import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Redacted, Semaphore } from "effect";
import { z } from "zod";
import { SecretRepository } from "../credentials/secret-repository";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { Conflict, InvalidInput, NotFound } from "../shared/errors";
import { GitHubUnavailable, github } from "./github-api";
import { githubAppUsers, githubApps } from "./schema";

/** Where GitHub sends the owner back after signing in through an App; each App lists it as a callback URL. */
export const authorizedPath = "/ui/github-app/authorized";

/** A token is refreshed once less than this is left of its eight hours. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** The owner has this long to finish signing in on GitHub. */
const STATE_TTL_MS = 10 * 60 * 1000;

const stateKey = (state: string) => `github-app-user-state:${state}`;

const pendingState = z.object({
  appId: z.string(),
  verifier: z.string(),
  redirectUri: z.string(),
  createdAt: z.number(),
});

// GitHub answers OAuth errors with 200 and an `error` field.
const tokenAnswer = z.union([
  z.object({
    access_token: z.string().min(1),
    expires_in: z.number().int(),
    refresh_token: z.string().min(1),
    refresh_token_expires_in: z.number().int(),
  }),
  z.object({ error: z.string(), error_description: z.string().optional() }),
]);

const user = z.object({ login: z.string().min(1), id: z.number().int() });

type AppRow = typeof githubApps.$inferSelect;

/** The owner as an App's bots act on GitHub. */
export type GitHubAppUser = { login: string; userId: number };

/** Exchanges a code or refresh token at GitHub's OAuth endpoint, on github.com rather than the REST API. */
const exchange = (params: Record<string, string>) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          signal,
          headers: { Accept: "application/json" },
          body: new URLSearchParams(params),
        },
      );

      return tokenAnswer.parse(await response.json());
    },
    catch: () =>
      new GitHubUnavailable({ message: "GitHub's sign-in didn't answer" }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () =>
        Effect.fail(new GitHubUnavailable({ message: "GitHub timed out" })),
    }),
  );

/**
 * The owner signing in to GitHub through an App, so bots assigned to it act as the owner instead of as `slug[bot]`.
 * GitHub shows their issues, pull requests, and comments with the App's badge. Tokens last eight hours and are
 * refreshed on use; refreshing rotates the refresh token, so refreshes run one at a time.
 */
export class GitHubAppUsers extends Context.Service<
  GitHubAppUsers,
  {
    readonly of: (appId: string) => Effect.Effect<GitHubAppUser | undefined>;
    /** GitHub's sign-in page for the App; it sends the owner back to `{origin}/ui/github-app/authorized`. */
    readonly authorize: (
      appId: string,
      origin: string,
    ) => Effect.Effect<string, NotFound | Conflict>;
    /** Exchanges the code GitHub sent the owner back with, and returns the App's ID. */
    readonly complete: (input: {
      code: string;
      state: string;
    }) => Effect.Effect<string, InvalidInput | GitHubUnavailable>;
    /** Forgets the owner's tokens after revoking them on GitHub, when GitHub answers. */
    readonly signOut: (appId: string) => Effect.Effect<void>;
    readonly setClientSecret: (
      appId: string,
      clientSecret: string,
    ) => Effect.Effect<void, NotFound>;
    /** The owner's current token for the App, refreshed when it's about to expire. */
    readonly token: (
      app: AppRow,
    ) => Effect.Effect<Redacted.Redacted, GitHubUnavailable>;
  }
>()("crumble/github-apps/GitHubAppUsers") {
  static readonly layer = Layer.effect(
    GitHubAppUsers,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const box = yield* SecretBox;
      const secrets = yield* SecretRepository;
      const refreshing = yield* Semaphore.make(1);

      const row = Effect.fn("GitHubAppUsers.row")(function* (appId: string) {
        const [found] = yield* db
          .select()
          .from(githubAppUsers)
          .where(eq(githubAppUsers.appId, appId));

        return found;
      }, Effect.orDie);

      const app = Effect.fn("GitHubAppUsers.app")(function* (appId: string) {
        const [found] = yield* db
          .select()
          .from(githubApps)
          .where(eq(githubApps.id, appId));

        return found;
      }, Effect.orDie);

      const save = Effect.fn("GitHubAppUsers.save")(function* (
        appId: string,
        tokens: {
          access_token: string;
          expires_in: number;
          refresh_token: string;
          refresh_token_expires_in: number;
        },
        owner: GitHubAppUser,
      ) {
        const now = yield* Clock.currentTimeMillis;

        const values = {
          login: owner.login,
          userId: owner.userId,
          token: box.encrypt(tokens.access_token),
          expiresAt: now + tokens.expires_in * 1000,
          refreshToken: box.encrypt(tokens.refresh_token),
          refreshExpiresAt: now + tokens.refresh_token_expires_in * 1000,
        };

        yield* db
          .insert(githubAppUsers)
          .values({ appId, ...values })
          .onConflictDoUpdate({ target: githubAppUsers.appId, set: values })
          .pipe(Effect.orDie);
      });

      const of = Effect.fn("GitHubAppUsers.of")(function* (appId: string) {
        const found = yield* row(appId);

        return found && { login: found.login, userId: found.userId };
      });

      const authorize = Effect.fn("GitHubAppUsers.authorize")(function* (
        appId: string,
        origin: string,
      ) {
        const found = yield* app(appId);

        if (!found)
          return yield* new NotFound({ message: "GitHub App not found" });

        if (!found.clientSecret)
          return yield* new Conflict({
            message: `Add ${found.name}'s client secret first`,
          });

        const state = randomBytes(24).toString("hex");
        const verifier = randomBytes(32).toString("base64url");
        const redirectUri = `${origin}${authorizedPath}`;

        yield* secrets.set(
          stateKey(state),
          JSON.stringify({
            appId,
            verifier,
            redirectUri,
            createdAt: yield* Clock.currentTimeMillis,
          }),
        );

        return `https://github.com/login/oauth/authorize?${new URLSearchParams({
          client_id: found.clientId,
          redirect_uri: redirectUri,
          state,
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
          // Asks for a refresh token even from an App that opted out of expiring tokens.
          scope: "offline_access",
        })}`;
      });

      const complete = Effect.fn("GitHubAppUsers.complete")(function* (input: {
        code: string;
        state: string;
      }) {
        const raw = yield* secrets.get(stateKey(input.state));

        const pending = raw
          ? pendingState.safeParse(JSON.parse(raw))
          : undefined;

        const now = yield* Clock.currentTimeMillis;

        yield* secrets.delete(stateKey(input.state));

        if (!pending?.success || now - pending.data.createdAt > STATE_TTL_MS)
          return yield* new InvalidInput({
            message:
              "This GitHub sign-in is stale or was already used; start again",
          });

        const found = yield* app(pending.data.appId);

        if (!found?.clientSecret)
          return yield* new InvalidInput({
            message: "The GitHub App was removed or lost its client secret",
          });

        const answer = yield* exchange({
          client_id: found.clientId,
          client_secret: box.decrypt(found.clientSecret),
          code: input.code,
          redirect_uri: pending.data.redirectUri,
          code_verifier: pending.data.verifier,
        });

        if ("error" in answer)
          return yield* new InvalidInput({
            message: `GitHub refused the sign-in: ${answer.error_description ?? answer.error}`,
          });

        const owner = yield* github("/user", user, {
          token: answer.access_token,
        });

        yield* save(found.id, answer, { login: owner.login, userId: owner.id });

        return found.id;
      });

      const signOut = Effect.fn("GitHubAppUsers.signOut")(function* (
        appId: string,
      ) {
        const [found, signedIn] = [yield* app(appId), yield* row(appId)];

        if (!signedIn) return;

        if (found?.clientSecret) {
          const basic = Buffer.from(
            `${found.clientId}:${box.decrypt(found.clientSecret)}`,
          ).toString("base64");

          // Revoking the grant also ends the refresh token, which would otherwise stay valid for months.
          yield* Effect.tryPromise((signal) =>
            fetch(
              `https://api.github.com/applications/${found.clientId}/grant`,
              {
                method: "DELETE",
                signal,
                headers: {
                  Accept: "application/vnd.github+json",
                  Authorization: `Basic ${basic}`,
                },
                body: JSON.stringify({
                  access_token: box.decrypt(signedIn.token),
                }),
              },
            ),
          ).pipe(Effect.timeout("15 seconds"), Effect.ignore);
        }

        yield* db
          .delete(githubAppUsers)
          .where(eq(githubAppUsers.appId, appId))
          .pipe(Effect.orDie);
      });

      const setClientSecret = Effect.fn("GitHubAppUsers.setClientSecret")(
        function* (appId: string, clientSecret: string) {
          const updated = yield* db
            .update(githubApps)
            .set({ clientSecret: box.encrypt(clientSecret) })
            .where(eq(githubApps.id, appId))
            .returning({ id: githubApps.id })
            .pipe(Effect.orDie);

          if (!updated.length)
            return yield* new NotFound({ message: "GitHub App not found" });
        },
      );

      const refresh = Effect.fn("GitHubAppUsers.refresh")(function* (
        found: AppRow,
      ) {
        // Another request may have refreshed while this one waited for the lock.
        const signedIn = yield* row(found.id);
        const now = yield* Clock.currentTimeMillis;

        if (!signedIn)
          return yield* new GitHubUnavailable({
            message: "the owner signed out of GitHub",
          });

        if (signedIn.expiresAt - now > TOKEN_MARGIN_MS)
          return Redacted.make(box.decrypt(signedIn.token));

        if (!found.clientSecret || signedIn.refreshExpiresAt <= now)
          return yield* new GitHubUnavailable({
            message: `sign in to GitHub through ${found.name} again`,
          });

        const answer = yield* exchange({
          client_id: found.clientId,
          client_secret: box.decrypt(found.clientSecret),
          grant_type: "refresh_token",
          refresh_token: box.decrypt(signedIn.refreshToken),
        });

        if ("error" in answer)
          return yield* new GitHubUnavailable({
            message: `sign in to GitHub through ${found.name} again (${answer.error})`,
          });

        yield* save(found.id, answer, signedIn);

        return Redacted.make(answer.access_token);
      });

      const token = Effect.fn("GitHubAppUsers.token")(function* (
        found: AppRow,
      ) {
        const signedIn = yield* row(found.id);
        const now = yield* Clock.currentTimeMillis;

        if (signedIn && signedIn.expiresAt - now > TOKEN_MARGIN_MS)
          return Redacted.make(box.decrypt(signedIn.token));

        return yield* refreshing.withPermit(refresh(found));
      });

      return GitHubAppUsers.of({
        of,
        authorize,
        complete,
        signOut,
        setClientSecret,
        token,
      });
    }),
  );
}
