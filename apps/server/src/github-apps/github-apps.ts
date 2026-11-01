import { createSign, randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect";
import { z } from "zod";
import { AgentCredentialRepository } from "../credentials/agent-credential-repository";
import { agentCredentials } from "../credentials/schema";
import { SecretRepository } from "../credentials/secret-repository";
import type { CredentialTarget } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { nowIso } from "../shared/time";
import { Conflict, InvalidInput, NotFound } from "../shared/errors";
import { githubAppBots, githubApps } from "./schema";

const API = "https://api.github.com";

/** The credential an installed App's token is swapped in for; `gh` and most GitHub tools read it. */
export const GITHUB_TOKEN_CREDENTIAL = "GH_TOKEN";

const GITHUB_HOSTS = ["github.com", "api.github.com", "uploads.github.com"];

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

/** The public page a created App links to; the server's own address would be published on it. */
const HOMEPAGE = "https://docs.crumbli.ng";

/** GitHub couldn't be reached, refused the App's token request, or no App covers the request. */
export class GitHubAppUnavailable extends Schema.TaggedError<GitHubAppUnavailable>()(
  "GitHubAppUnavailable",
  { message: Schema.String },
) {}

/** One of the account's GitHub Apps as the owner sees it. */
export type GitHubApp = {
  id: string;
  slug: string;
  name: string;
  /** The name commits and pull requests show, such as `scout[bot]`. */
  login: string;
  htmlUrl: string;
  installUrl: string;
  /** The GitHub user or organization whose repositories the App works on. */
  account: string | null;
  installed: boolean;
  botIds: string[];
  createdAt: string;
};

/** How a bot commits in one GitHub account's repositories. */
export type GitHubIdentity = { account: string; name: string; email: string };

/** What the web posts to GitHub to create the App: `manifest` goes in a form field, `state` is already in `url`. */
export type GitHubAppManifest = { url: string; manifest: string };

const conversion = z.object({
  id: z.number().int(),
  slug: z.string().min(1),
  name: z.string().min(1),
  client_id: z.string().min(1),
  pem: z.string().min(1),
  html_url: z.string(),
  owner: z.object({ login: z.string() }),
});

const botUser = z.object({ id: z.number().int() });

const installations = z.array(
  z.object({ id: z.number().int(), account: z.object({ login: z.string() }) }),
);

const accessToken = z.object({ token: z.string(), expires_at: z.string() });

const pendingState = z.object({ createdAt: z.number() });

const stateKey = (state: string) => `github-app-state:${state}`;

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

const OWNER_SCOPES = new Set(["repos", "orgs", "users"]);

/** The GitHub account a request is about, from its path; undefined for paths without one, such as GraphQL. */
export const ownerOf = (target: CredentialTarget) => {
  const parts = target.path.split("?")[0]!.split("/").filter(Boolean);

  if (target.host === "github.com") return parts[0]?.toLowerCase();

  return OWNER_SCOPES.has(parts[0] ?? "") ? parts[1]?.toLowerCase() : undefined;
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

type AppRow = typeof githubApps.$inferSelect;

const identityOf = (row: AppRow) => {
  const name = `${row.slug}[bot]`;

  return { name, email: `${row.botUserId}+${name}@users.noreply.github.com` };
};

/**
 * The account's GitHub Apps: each created from a manifest on one GitHub account, installed there, and assigned to
 * bots. A bot with an installed App gets the `GH_TOKEN` credential; its value is an installation token minted on
 * use, from the App whose account owns the request's repository.
 */
export class GitHubApps extends Context.Service<
  GitHubApps,
  {
    readonly list: Effect.Effect<GitHubApp[]>;
    /** The manifest the owner's browser posts to GitHub; `organization` creates the App there instead of on the owner's account. */
    readonly manifest: (input: {
      name: string;
      origin: string;
      organization?: string | undefined;
    }) => Effect.Effect<GitHubAppManifest>;
    /** Exchanges the code GitHub redirected back with for the App's keys. */
    readonly complete: (input: {
      code: string;
      state: string;
    }) => Effect.Effect<GitHubApp, InvalidInput | GitHubAppUnavailable>;
    /** Looks up the App's installation on its account and gives its bots the `GH_TOKEN` credential. */
    readonly connect: (
      id: string,
    ) => Effect.Effect<GitHubApp, NotFound | Conflict | GitHubAppUnavailable>;
    /** Replaces the bots that act through the App; a bot keeps at most one App per GitHub account. */
    readonly assign: (
      id: string,
      botIds: readonly string[],
    ) => Effect.Effect<GitHubApp, NotFound | Conflict>;
    /** Forgets the App; it stays on GitHub until the owner deletes it there. */
    readonly remove: (id: string) => Effect.Effect<void, NotFound>;
    readonly token: (
      agentId: string,
      target: CredentialTarget,
    ) => Effect.Effect<Redacted.Redacted, GitHubAppUnavailable>;
    /** The commit identity in each GitHub account the bot works in, default first. */
    readonly identities: (agentId: string) => Effect.Effect<GitHubIdentity[]>;
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

      const row = Effect.fn("GitHubApps.row")(function* (id: string) {
        const [found] = yield* db
          .select()
          .from(githubApps)
          .where(eq(githubApps.id, id));

        return found;
      }, Effect.orDie);

      const botIdsOf = Effect.fn("GitHubApps.botIdsOf")(function* (id: string) {
        const rows = yield* db
          .select({ agentId: githubAppBots.agentId })
          .from(githubAppBots)
          .where(eq(githubAppBots.appId, id))
          .orderBy(asc(githubAppBots.assignedAt));

        return rows.map((each) => each.agentId);
      }, Effect.orDie);

      const appOf = Effect.fn("GitHubApps.appOf")(function* (found: AppRow) {
        return {
          id: found.id,
          slug: found.slug,
          name: found.name,
          login: `${found.slug}[bot]`,
          htmlUrl: found.htmlUrl,
          installUrl: `https://github.com/apps/${found.slug}/installations/new`,
          account: found.account,
          installed: found.installationId !== null,
          botIds: yield* botIdsOf(found.id),
          createdAt: found.createdAt,
        } satisfies GitHubApp;
      });

      const get = Effect.fn("GitHubApps.get")(function* (id: string) {
        const found = yield* row(id);

        if (!found)
          return yield* new NotFound({ message: "GitHub App not found" });

        return yield* appOf(found);
      });

      /** The bot's Apps, oldest assignment first: the first is its default. */
      const appsOfBot = Effect.fn("GitHubApps.appsOfBot")(function* (
        agentId: string,
      ) {
        const rows = yield* db
          .select({ app: githubApps })
          .from(githubAppBots)
          .innerJoin(githubApps, eq(githubApps.id, githubAppBots.appId))
          .where(eq(githubAppBots.agentId, agentId))
          .orderBy(asc(githubAppBots.assignedAt));

        return rows.map((each) => each.app);
      }, Effect.orDie);

      /** Gives a bot `GH_TOKEN` while one of its Apps is installed, and takes it away when none is. */
      const syncCredential = Effect.fn("GitHubApps.syncCredential")(function* (
        agentId: string,
      ) {
        const installed = (yield* appsOfBot(agentId)).some(
          (app) => app.installationId !== null,
        );

        if (installed) {
          // An existing GH_TOKEN keeps its placeholder; only its source changes to the Apps.
          yield* credentials.save(agentId, GITHUB_TOKEN_CREDENTIAL, {
            hosts: GITHUB_HOSTS,
            githubApp: true,
            placeholder: `crumble-credential-${randomBytes(24).toString("hex")}`,
          });

          return;
        }

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

      const jwtFor = (found: AppRow) =>
        Effect.map(Clock.currentTimeMillis, (now) =>
          appJwt(found.clientId, box.decrypt(found.privateKey), now),
        );

      const list = Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(githubApps)
          .orderBy(asc(githubApps.createdAt))
          .pipe(Effect.orDie);

        return yield* Effect.forEach(rows, appOf);
      }).pipe(Effect.withSpan("GitHubApps.list"));

      const manifest = Effect.fn("GitHubApps.manifest")(function* (input: {
        name: string;
        origin: string;
        organization?: string | undefined;
      }) {
        const state = randomBytes(24).toString("hex");
        const createdAt = yield* Clock.currentTimeMillis;

        yield* secrets.set(stateKey(state), JSON.stringify({ createdAt }));

        const base = input.organization
          ? `https://github.com/organizations/${encodeURIComponent(input.organization)}/settings/apps/new`
          : "https://github.com/settings/apps/new";

        return {
          url: `${base}?state=${state}`,
          manifest: JSON.stringify({
            name: input.name,
            url: HOMEPAGE,
            description:
              "A Crumble bot's GitHub identity. Commits and pull requests from this App are a bot's work.",
            redirect_url: `${input.origin}/ui/github-app/callback`,
            setup_url: `${input.origin}/ui/github-app/installed`,
            public: false,
            default_permissions: PERMISSIONS,
            default_events: [],
          }),
        };
      });

      const complete = Effect.fn("GitHubApps.complete")(function* (input: {
        code: string;
        state: string;
      }) {
        const raw = yield* secrets.get(stateKey(input.state));

        const pending = raw
          ? pendingState.safeParse(JSON.parse(raw))
          : undefined;

        const now = yield* Clock.currentTimeMillis;

        if (!pending?.success || now - pending.data.createdAt > STATE_TTL_MS)
          return yield* new InvalidInput({
            message:
              "This GitHub link is stale or was already used; start again",
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

        const id = randomUUID();

        yield* secrets.delete(stateKey(input.state));
        yield* db
          .insert(githubApps)
          .values({
            id,
            appId: app.id,
            slug: app.slug,
            name: app.name,
            clientId: app.client_id,
            privateKey: box.encrypt(app.pem),
            botUserId: user.id,
            htmlUrl: app.html_url,
            account: app.owner.login,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.orDie);

        return yield* get(id).pipe(Effect.orDie);
      });

      const connect = Effect.fn("GitHubApps.connect")(function* (id: string) {
        const found = yield* row(id);

        if (!found)
          return yield* new NotFound({ message: "GitHub App not found" });

        const all = yield* github("/app/installations", installations, {
          token: yield* jwtFor(found),
        });

        // A private App installs only on its owner; an older App may not know its account yet.
        const installation = all.find(
          (each) =>
            !found.account ||
            each.account.login.toLowerCase() === found.account.toLowerCase(),
        );

        if (!installation)
          return yield* new Conflict({
            message: `Install ${found.name} on GitHub first`,
          });

        yield* db
          .update(githubApps)
          .set({
            installationId: installation.id,
            account: installation.account.login,
          })
          .where(eq(githubApps.id, id))
          .pipe(Effect.orDie);
        tokens.delete(id);
        yield* Effect.forEach(yield* botIdsOf(id), syncCredential);

        return yield* get(id);
      });

      /** The bots that already use another App for the same GitHub account. */
      const clashes = Effect.fn("GitHubApps.clashes")(function* (
        found: AppRow,
        botIds: readonly string[],
      ) {
        if (!found.account || !botIds.length) return [];

        const rows = yield* db
          .select({
            agentId: githubAppBots.agentId,
            account: githubApps.account,
          })
          .from(githubAppBots)
          .innerJoin(githubApps, eq(githubApps.id, githubAppBots.appId))
          .where(
            and(
              inArray(githubAppBots.agentId, [...botIds]),
              ne(githubApps.id, found.id),
              isNotNull(githubApps.account),
            ),
          )
          .pipe(Effect.orDie);

        const account = found.account.toLowerCase();

        return rows.filter((each) => each.account?.toLowerCase() === account);
      });

      const assign = Effect.fn("GitHubApps.assign")(function* (
        id: string,
        botIds: readonly string[],
      ) {
        const found = yield* row(id);

        if (!found)
          return yield* new NotFound({ message: "GitHub App not found" });

        const previous = yield* botIdsOf(id);
        const added = botIds.filter((botId) => !previous.includes(botId));
        const removed = previous.filter((botId) => !botIds.includes(botId));
        const clashing = yield* clashes(found, added);

        if (clashing.length)
          return yield* new Conflict({
            message: `A bot already uses another App for ${found.account}; take it off that App first`,
          });

        const at = yield* nowIso;

        // Kept bots keep their assignment time, which decides each bot's default App.
        yield* db
          .transaction(() =>
            Effect.gen(function* () {
              if (removed.length)
                yield* db
                  .delete(githubAppBots)
                  .where(
                    and(
                      eq(githubAppBots.appId, id),
                      inArray(githubAppBots.agentId, removed),
                    ),
                  );

              if (added.length)
                yield* db.insert(githubAppBots).values(
                  added.map((agentId) => ({
                    appId: id,
                    agentId,
                    assignedAt: at,
                  })),
                );
            }),
          )
          .pipe(Effect.orDie);

        yield* Effect.forEach([...added, ...removed], syncCredential);

        return yield* get(id);
      });

      const remove = Effect.fn("GitHubApps.remove")(function* (id: string) {
        const botIds = yield* botIdsOf(id);

        const deleted = yield* db
          .delete(githubApps)
          .where(eq(githubApps.id, id))
          .returning({ id: githubApps.id })
          .pipe(Effect.orDie);

        if (!deleted.length)
          return yield* new NotFound({ message: "GitHub App not found" });

        tokens.delete(id);
        yield* Effect.forEach(botIds, syncCredential);
      });

      const mint = Effect.fn("GitHubApps.mint")(function* (found: AppRow) {
        const now = yield* Clock.currentTimeMillis;
        const cached = tokens.get(found.id);

        if (cached && cached.expiresAt - now > TOKEN_MARGIN_MS)
          return Redacted.make(cached.token);

        const minted = yield* github(
          `/app/installations/${found.installationId}/access_tokens`,
          accessToken,
          { method: "POST", token: yield* jwtFor(found) },
        );

        tokens.set(found.id, {
          token: minted.token,
          expiresAt: Date.parse(minted.expires_at),
        });

        return Redacted.make(minted.token);
      });

      const token = Effect.fn("GitHubApps.token")(function* (
        agentId: string,
        target: CredentialTarget,
      ) {
        const installed = (yield* appsOfBot(agentId)).filter(
          (app) => app.installationId !== null,
        );

        const owner = ownerOf(target);

        // Requests without an owner in their path, such as GraphQL, go to the bot's default App.
        const app =
          installed.find((each) => each.account?.toLowerCase() === owner) ??
          installed[0];

        if (!app)
          return yield* new GitHubAppUnavailable({
            message: "the bot has no installed GitHub App",
          });

        return yield* mint(app);
      });

      const identities = Effect.fn("GitHubApps.identities")(function* (
        agentId: string,
      ) {
        return (yield* appsOfBot(agentId)).flatMap((app) =>
          app.account ? [{ account: app.account, ...identityOf(app) }] : [],
        );
      });

      const gitEnv = Effect.fn("GitHubApps.gitEnv")(function* (
        agentId: string,
      ) {
        const apps = yield* appsOfBot(agentId);
        const fallback = apps[0];

        if (!fallback) return {};

        const { name, email } = identityOf(fallback);

        // Config, not GIT_AUTHOR_*, so a repository's own user.name wins in another account's repositories.
        const entries: [string, string][] = [
          ["user.name", name],
          ["user.email", email],
        ];

        if (apps.some((app) => app.installationId !== null))
          // git sends the placeholder as the Basic password; the credential proxy swaps it for the token.
          entries.push([
            "credential.https://github.com.helper",
            `!f() { echo username=x-access-token; echo "password=$${GITHUB_TOKEN_CREDENTIAL}"; }; f`,
          ]);

        return Object.fromEntries([
          ["GIT_CONFIG_COUNT", String(entries.length)],
          ...entries.flatMap(([key, value], index) => [
            [`GIT_CONFIG_KEY_${index}`, key],
            [`GIT_CONFIG_VALUE_${index}`, value],
          ]),
        ]);
      });

      return GitHubApps.of({
        list,
        manifest,
        complete,
        connect,
        assign,
        remove,
        token,
        identities,
        gitEnv,
      });
    }),
  );
}
