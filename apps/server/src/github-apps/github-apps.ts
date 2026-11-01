import { createSign, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";
import { z } from "zod";
import { AgentCredentialRepository } from "../credentials/agent-credential-repository";
import { agentCredentials } from "../credentials/schema";
import { SecretRepository } from "../credentials/secret-repository";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { nowIso } from "../shared/time";
import { Conflict, InvalidInput, NotFound } from "../shared/errors";
import { agentGithubApps } from "./schema";

const API = "https://api.github.com";

/** The credential an installed App's token is swapped in for; `gh` and most GitHub tools read it. */
export const GITHUB_TOKEN_CREDENTIAL = "GH_TOKEN";

const GITHUB_HOSTS = ["github.com", "api.github.com"];

// Read-only on CI and checks so jobs can follow their PRs; no `workflows`, so jobs can't change CI.
const PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  actions: "read",
  metadata: "read",
};

/** A token is minted again once less than this is left of its hour. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** GitHub's manifest codes are valid for an hour; a state older than that can't finish. */
const STATE_TTL_MS = 60 * 60 * 1000;

/** GitHub couldn't be reached, or refused the App's token request. */
export class GitHubAppUnavailable extends Schema.TaggedError<GitHubAppUnavailable>()(
  "GitHubAppUnavailable",
  { message: Schema.String },
) {}

/** A bot's GitHub App as the owner sees it. */
export type GitHubApp = {
  slug: string;
  name: string;
  /** The name commits and pull requests show, such as `scout[bot]`. */
  login: string;
  htmlUrl: string;
  installUrl: string;
  /** The user or organization the App is installed on; null until installed. */
  installedOn: string | null;
  createdAt: string;
};

/** What the web posts to GitHub to create the App: `manifest` goes in a form field, `state` is already in `url`. */
export type GitHubAppManifest = { url: string; manifest: string };

const conversion = z.object({
  id: z.number().int(),
  slug: z.string().min(1),
  name: z.string().min(1),
  client_id: z.string().min(1),
  pem: z.string().min(1),
  html_url: z.string(),
});

const botUser = z.object({ id: z.number().int() });

const installations = z.array(
  z.object({ id: z.number().int(), account: z.object({ login: z.string() }) }),
);

const accessToken = z.object({ token: z.string(), expires_at: z.string() });

const pendingState = z.object({ state: z.string(), createdAt: z.number() });

const stateKey = (agentId: string) => `github-app-state:${agentId}`;

const base64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

/** A JWT that authenticates as the App itself, valid for nine minutes; `iat` is back-dated for clock drift. */
const appJwt = (clientId: string, privateKey: string, nowMs: number) => {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));

  const claims = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: clientId }),
  );

  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(privateKey);

  return `${header}.${claims}.${base64url(signature)}`;
};

const github = <T>(
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; token?: string } = {},
) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(`${API}${path}`, {
        method: init.method ?? "GET",
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init.token && { Authorization: `Bearer ${init.token}` }),
        },
      }),
    catch: () => new GitHubAppUnavailable({ message: "Can't reach GitHub" }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () =>
        Effect.fail(new GitHubAppUnavailable({ message: "GitHub timed out" })),
    }),
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise({
            try: async () => schema.parse(await response.json()),
            catch: () =>
              new GitHubAppUnavailable({
                message: "GitHub answered in an unexpected shape",
              }),
          })
        : Effect.fail(
            new GitHubAppUnavailable({
              message: `GitHub answered ${response.status}`,
            }),
          ),
    ),
  );

/**
 * Each bot's own GitHub App: created from a manifest, installed by the owner, and turned into the bot's `GH_TOKEN`
 * credential, whose value is an installation token minted on use.
 */
export class GitHubApps extends Context.Service<
  GitHubApps,
  {
    readonly get: (agentId: string) => Effect.Effect<GitHubApp | undefined>;
    /** The manifest the owner's browser posts to GitHub; `organization` creates the App there instead of on the owner's account. */
    readonly manifest: (
      agentId: string,
      input: {
        botName: string;
        origin: string;
        organization?: string | undefined;
      },
    ) => Effect.Effect<GitHubAppManifest, Conflict>;
    /** Exchanges the code GitHub redirected back with for the App's keys. */
    readonly complete: (
      agentId: string,
      input: { code: string; state: string },
    ) => Effect.Effect<
      GitHubApp,
      InvalidInput | Conflict | GitHubAppUnavailable
    >;
    /** Looks up where the owner installed the App and gives the bot its `GH_TOKEN` credential. */
    readonly connect: (
      agentId: string,
    ) => Effect.Effect<GitHubApp, NotFound | Conflict | GitHubAppUnavailable>;
    /** Forgets the App and its credential; the App itself stays on GitHub until the owner deletes it there. */
    readonly remove: (agentId: string) => Effect.Effect<void, NotFound>;
    readonly token: (
      agentId: string,
    ) => Effect.Effect<Redacted.Redacted, GitHubAppUnavailable>;
    /** Commit identity and git's HTTPS sign-in for the bot's coding jobs; empty without an App. */
    readonly gitEnv: (agentId: string) => Effect.Effect<Record<string, string>>;
  }
>()("crumble/github-apps/GitHubApps") {
  static readonly layer = Layer.effect(
    GitHubApps,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const box = yield* SecretBox;
      const secrets = yield* SecretRepository;
      const credentials = yield* AgentCredentialRepository;
      const tokens = new Map<string, { token: string; expiresAt: number }>();

      const row = Effect.fn("GitHubApps.row")(function* (agentId: string) {
        const [found] = yield* db
          .select()
          .from(agentGithubApps)
          .where(eq(agentGithubApps.agentId, agentId));

        return found;
      }, Effect.orDie);

      const appOf = (
        found: typeof agentGithubApps.$inferSelect,
      ): GitHubApp => ({
        slug: found.slug,
        name: found.name,
        login: `${found.slug}[bot]`,
        htmlUrl: found.htmlUrl,
        installUrl: `https://github.com/apps/${found.slug}/installations/new`,
        installedOn: found.installedOn,
        createdAt: found.createdAt,
      });

      const get = Effect.fn("GitHubApps.get")(function* (agentId: string) {
        const found = yield* row(agentId);

        return found && appOf(found);
      });

      const jwtFor = (found: typeof agentGithubApps.$inferSelect) =>
        Effect.map(Clock.currentTimeMillis, (now) =>
          appJwt(found.clientId, box.decrypt(found.privateKey), now),
        );

      const manifest = Effect.fn("GitHubApps.manifest")(function* (
        agentId: string,
        input: {
          botName: string;
          origin: string;
          organization?: string | undefined;
        },
      ) {
        if (yield* row(agentId))
          return yield* new Conflict({
            message: "This bot already has a GitHub App; remove it first",
          });

        const state = randomBytes(24).toString("hex");
        const createdAt = yield* Clock.currentTimeMillis;

        yield* secrets.set(
          stateKey(agentId),
          JSON.stringify({ state, createdAt }),
        );

        const base = input.organization
          ? `https://github.com/organizations/${encodeURIComponent(input.organization)}/settings/apps/new`
          : "https://github.com/settings/apps/new";

        return {
          url: `${base}?state=${state}`,
          manifest: JSON.stringify({
            name: input.botName,
            url: input.origin,
            description: `${input.botName}, a Crumble bot. Commits and pull requests from this App are its work.`,
            redirect_url: `${input.origin}/ui/github-app/callback`,
            setup_url: `${input.origin}/ui/github-app/installed`,
            public: false,
            default_permissions: PERMISSIONS,
            default_events: [],
          }),
        };
      });

      const complete = Effect.fn("GitHubApps.complete")(function* (
        agentId: string,
        input: { code: string; state: string },
      ) {
        const raw = yield* secrets.get(stateKey(agentId));

        const pending = raw
          ? pendingState.safeParse(JSON.parse(raw))
          : undefined;

        const now = yield* Clock.currentTimeMillis;

        if (
          !pending?.success ||
          pending.data.state !== input.state ||
          now - pending.data.createdAt > STATE_TTL_MS
        )
          return yield* new InvalidInput({
            message:
              "This GitHub link is stale or was already used; start again",
          });

        if (yield* row(agentId))
          return yield* new Conflict({
            message: "This bot already has a GitHub App",
          });

        const app = yield* github(
          `/app-manifests/${encodeURIComponent(input.code)}/conversions`,
          conversion,
          { method: "POST" },
        );

        const user = yield* github(
          `/users/${encodeURIComponent(`${app.slug}[bot]`)}`,
          botUser,
        );

        yield* secrets.delete(stateKey(agentId));
        yield* db
          .insert(agentGithubApps)
          .values({
            agentId,
            appId: app.id,
            slug: app.slug,
            name: app.name,
            clientId: app.client_id,
            privateKey: box.encrypt(app.pem),
            botUserId: user.id,
            htmlUrl: app.html_url,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.orDie);

        return (yield* get(agentId))!;
      });

      const connect = Effect.fn("GitHubApps.connect")(function* (
        agentId: string,
      ) {
        const found = yield* row(agentId);

        if (!found)
          return yield* new NotFound({ message: "This bot has no GitHub App" });

        const [installation] = yield* github(
          "/app/installations",
          installations,
          {
            token: yield* jwtFor(found),
          },
        );

        if (!installation)
          return yield* new Conflict({
            message: `Install ${found.name} on GitHub first`,
          });

        yield* db
          .update(agentGithubApps)
          .set({
            installationId: installation.id,
            installedOn: installation.account.login,
          })
          .where(eq(agentGithubApps.agentId, agentId))
          .pipe(Effect.orDie);
        tokens.delete(agentId);

        // An existing GH_TOKEN keeps its placeholder; only its source changes to the App.
        yield* credentials.save(agentId, GITHUB_TOKEN_CREDENTIAL, {
          hosts: GITHUB_HOSTS,
          githubApp: true,
          placeholder: `crumble-credential-${randomBytes(24).toString("hex")}`,
        });

        return (yield* get(agentId))!;
      });

      const remove = Effect.fn("GitHubApps.remove")(function* (
        agentId: string,
      ) {
        const deleted = yield* db
          .delete(agentGithubApps)
          .where(eq(agentGithubApps.agentId, agentId))
          .returning({ agentId: agentGithubApps.agentId })
          .pipe(Effect.orDie);

        if (!deleted.length)
          return yield* new NotFound({ message: "This bot has no GitHub App" });

        tokens.delete(agentId);
        yield* db
          .delete(agentCredentials)
          .where(
            and(
              eq(agentCredentials.agentId, agentId),
              eq(agentCredentials.githubApp, true),
            ),
          )
          .pipe(Effect.orDie);
      });

      const token = Effect.fn("GitHubApps.token")(function* (agentId: string) {
        const now = yield* Clock.currentTimeMillis;
        const cached = tokens.get(agentId);

        if (cached && cached.expiresAt - now > TOKEN_MARGIN_MS)
          return Redacted.make(cached.token);

        const found = yield* row(agentId);

        if (!found?.installationId)
          return yield* new GitHubAppUnavailable({
            message: "the bot's GitHub App isn't installed",
          });

        const minted = yield* github(
          `/app/installations/${found.installationId}/access_tokens`,
          accessToken,
          { method: "POST", token: yield* jwtFor(found) },
        );

        tokens.set(agentId, {
          token: minted.token,
          expiresAt: Date.parse(minted.expires_at),
        });

        return Redacted.make(minted.token);
      });

      const gitEnv = Effect.fn("GitHubApps.gitEnv")(function* (
        agentId: string,
      ) {
        const found = yield* row(agentId);

        if (!found) return {};

        const name = `${found.slug}[bot]`;
        const email = `${found.botUserId}+${name}@users.noreply.github.com`;

        const identity = {
          GIT_AUTHOR_NAME: name,
          GIT_AUTHOR_EMAIL: email,
          GIT_COMMITTER_NAME: name,
          GIT_COMMITTER_EMAIL: email,
        };

        if (!found.installationId) return identity;

        // git sends the placeholder as the Basic password; the credential proxy swaps it for the token.
        return {
          ...identity,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
          GIT_CONFIG_VALUE_0: `!f() { echo username=x-access-token; echo "password=$${GITHUB_TOKEN_CREDENTIAL}"; }; f`,
        };
      });

      return GitHubApps.of({
        get,
        manifest,
        complete,
        connect,
        remove,
        token,
        gitEnv,
      });
    }),
  );
}
