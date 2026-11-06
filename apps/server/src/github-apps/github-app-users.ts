import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Redacted, Semaphore } from "effect";
import { z } from "zod";
import { secretKey } from "../secrets/secret-key";
import { Secrets } from "../secrets/secrets";
import { PendingStates } from "../secrets/server-secrets";
import type { SecretInput } from "../contract/secrets";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { Conflict, InvalidInput, NotFound } from "../shared/errors";
import {
  GitHubUnavailable,
  github,
  githubOAuth,
  githubUser,
  revokeGitHubGrant,
} from "./github-api";
import { githubAppUsers, githubApps } from "./schema";

/** A token is refreshed once less than this is left of its eight hours. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

const STATE_TTL_MS = 10 * 60 * 1000;

const STATE_FLOW = "github-app-user-state";

export const githubAppClientSecretKey = (appId: string) =>
  secretKey("github-app-client", appId);

const signInState = z.object({
  appId: z.string(),
  verifier: z.string(),
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

type GitHubAppClient = Pick<
  typeof githubApps.$inferSelect,
  "id" | "name" | "clientId"
>;

export type GitHubAppUser = { login: string; userId: number };

/**
 * The owner signing in to GitHub through an App, so bots assigned to it act as the owner instead of as `slug[bot]`.
 * GitHub shows their issues, pull requests, and comments with the App's badge. Tokens last eight hours and are
 * refreshed on use; refreshing rotates the refresh token, so refreshes run one at a time.
 */
export class GitHubAppUsers extends Context.Service<
  GitHubAppUsers,
  {
    readonly of: (appId: string) => Effect.Effect<GitHubAppUser | undefined>;
    readonly authorize: (
      appId: string,
    ) => Effect.Effect<string, NotFound | Conflict>;
    readonly complete: (input: {
      code: string;
      state: string;
    }) => Effect.Effect<string, InvalidInput | GitHubUnavailable>;
    readonly signOut: (appId: string) => Effect.Effect<void>;
    readonly setClientSecret: (
      appId: string,
      clientSecret: SecretInput,
    ) => Effect.Effect<void, NotFound | InvalidInput>;
    readonly token: (
      app: GitHubAppClient,
    ) => Effect.Effect<Redacted.Redacted, GitHubUnavailable>;
  }
>()("crumble/github-apps/GitHubAppUsers") {
  static readonly layer = Layer.effect(
    GitHubAppUsers,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const box = yield* SecretBox;
      const pendingStates = yield* PendingStates;
      const secrets = yield* Secrets;
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

      const clientSecretOf = (appId: string) =>
        secrets.read(githubAppClientSecretKey(appId)).pipe(
          Effect.mapError(
            (error) =>
              new GitHubUnavailable({
                message: `the client secret could not be read: ${error.message}`,
              }),
          ),
        );

      const authorize = Effect.fn("GitHubAppUsers.authorize")(function* (
        appId: string,
      ) {
        const found = yield* app(appId);

        if (!found)
          return yield* new NotFound({ message: "GitHub App not found" });

        if (
          !(yield* secrets.status(githubAppClientSecretKey(appId))).configured
        )
          return yield* new Conflict({
            message: `Add ${found.name}'s client secret first`,
          });

        const state = randomBytes(24).toString("hex");
        const verifier = randomBytes(32).toString("base64url");
        yield* pendingStates.put(STATE_FLOW, state, { appId, verifier });

        return `https://github.com/login/oauth/authorize?${new URLSearchParams({
          // No redirect_uri: GitHub uses the App's callback URL, which older Apps registered under /ui/.
          client_id: found.clientId,
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
        const pending = yield* pendingStates.read(
          STATE_FLOW,
          input.state,
          signInState,
          STATE_TTL_MS,
        );

        yield* pendingStates.drop(STATE_FLOW, input.state);

        if (!pending)
          return yield* new InvalidInput({
            message:
              "This GitHub sign-in is stale or was already used; start again",
          });

        const found = yield* app(pending.appId);
        const secret = found && (yield* clientSecretOf(found.id));

        if (!found || !secret)
          return yield* new InvalidInput({
            message: "The GitHub App was removed or lost its client secret",
          });

        const answer = yield* githubOAuth(
          {
            client_id: found.clientId,
            client_secret: Redacted.value(secret),
            code: input.code,
            code_verifier: pending.verifier,
          },
          tokenAnswer,
        );

        if ("error" in answer)
          return yield* new InvalidInput({
            message: `GitHub refused the sign-in: ${answer.error_description ?? answer.error}`,
          });

        const owner = yield* github("/user", githubUser, {
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

        const secret =
          found &&
          (yield* clientSecretOf(found.id).pipe(
            Effect.orElseSucceed(() => undefined),
          ));

        // Revoking the grant also ends the refresh token, which would otherwise stay valid for months.
        if (found && secret)
          yield* revokeGitHubGrant(
            {
              clientId: found.clientId,
              clientSecret: Redacted.value(secret),
            },
            box.decrypt(signedIn.token),
          );

        yield* db
          .delete(githubAppUsers)
          .where(eq(githubAppUsers.appId, appId))
          .pipe(Effect.orDie);
      });

      const setClientSecret = Effect.fn("GitHubAppUsers.setClientSecret")(
        function* (appId: string, clientSecret: SecretInput) {
          if (!(yield* app(appId)))
            return yield* new NotFound({ message: "GitHub App not found" });

          yield* secrets.save(githubAppClientSecretKey(appId), clientSecret);
        },
      );

      const refresh = Effect.fn("GitHubAppUsers.refresh")(function* (
        found: GitHubAppClient,
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

        const secret = yield* clientSecretOf(found.id);

        if (!secret || signedIn.refreshExpiresAt <= now)
          return yield* new GitHubUnavailable({
            message: `sign in to GitHub through ${found.name} again`,
          });

        const answer = yield* githubOAuth(
          {
            client_id: found.clientId,
            client_secret: Redacted.value(secret),
            grant_type: "refresh_token",
            refresh_token: box.decrypt(signedIn.refreshToken),
          },
          tokenAnswer,
        );

        if ("error" in answer)
          return yield* new GitHubUnavailable({
            message: `sign in to GitHub through ${found.name} again (${answer.error})`,
          });

        yield* save(found.id, answer, signedIn);

        return Redacted.make(answer.access_token);
      });

      const token = Effect.fn("GitHubAppUsers.token")(function* (
        found: GitHubAppClient,
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
