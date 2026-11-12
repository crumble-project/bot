import type { z } from "zod";
import type { githubAccountResponse } from "../contract/github-apps";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { Context, Effect, Layer, Redacted } from "effect";
import { secretKey } from "../secrets/secret-key";
import type { SecretUnavailable } from "../secrets/secret-values";
import { Secrets } from "../secrets/secrets";
import { ServerSecrets } from "../secrets/server-secrets";
import type { SecretInput } from "../contract/secrets";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { Conflict, InvalidInput, NotFound } from "../shared/errors";
import { GitHubUnavailable, github, githubUser } from "./github-api";
import { assignmentChange } from "./github-identity";
import { githubAccountBots, githubAccounts } from "./schema";
import { newSigningKey, sshPublicKey, sshSign } from "./ssh-signing";

export type GitHubAccount = z.infer<typeof githubAccountResponse>;

export type GitHubAccountOfBot = {
  login: string;
  userId: number;
  token: Effect.Effect<
    Redacted.Redacted,
    SecretUnavailable | GitHubUnavailable
  >;
  signingKey: string;
  /** Signs a commit or tag with the account's key, as `ssh-keygen -Y sign -n git` would. */
  sign: (data: Uint8Array) => string;
};

const tokenKey = (id: string) => secretKey("github-account", id);

// Made by the server, never entered by the owner, so it stays in Crumble's own encrypted store.
const signingKeyKey = (id: string) => secretKey("github-account-signing", id);

const userOf = (token: Redacted.Redacted) =>
  github("/user", githubUser, { token: Redacted.value(token) }).pipe(
    Effect.catchIf(
      (error) => error.status === 401,
      () =>
        Effect.fail(
          new InvalidInput({
            message: "GitHub refused this token; check that it hasn't expired",
          }),
        ),
    ),
  );

type AccountRow = typeof githubAccounts.$inferSelect;

const publicSigningKey = (privateKey: string, login: string) =>
  sshPublicKey(privateKey, `${login}@crumble`);

/**
 * GitHub users the owner made for bots, added with a personal access token. A bot acts as its machine account
 * wherever none of its GitHub Apps does: in other accounts' repositories, forks, and public issues.
 */
export class GitHubAccounts extends Context.Service<
  GitHubAccounts,
  {
    readonly list: Effect.Effect<GitHubAccount[]>;
    readonly get: (id: string) => Effect.Effect<GitHubAccount, NotFound>;
    readonly add: (
      token: SecretInput,
    ) => Effect.Effect<
      GitHubAccount,
      InvalidInput | Conflict | GitHubUnavailable
    >;
    readonly setToken: (
      id: string,
      token: SecretInput,
    ) => Effect.Effect<
      GitHubAccount,
      NotFound | InvalidInput | GitHubUnavailable
    >;
    readonly ofBot: (
      agentId: string,
    ) => Effect.Effect<GitHubAccountOfBot | undefined>;
  }
>()("crumble/github-apps/GitHubAccounts") {
  static readonly layer = Layer.effect(
    GitHubAccounts,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const secrets = yield* Secrets;
      const serverSecrets = yield* ServerSecrets;

      const privateKey = Effect.fn("GitHubAccounts.privateKey")(function* (
        id: string,
      ) {
        const key = yield* serverSecrets.get(signingKeyKey(id));

        if (!key) return yield* Effect.die(`Account ${id} has no signing key`);

        return key;
      });

      const row = Effect.fn("GitHubAccounts.row")(function* (id: string) {
        const [found] = yield* db
          .select()
          .from(githubAccounts)
          .where(eq(githubAccounts.id, id));

        return found;
      }, Effect.orDie);

      const botIdsOf = Effect.fn("GitHubAccounts.botIdsOf")(function* (
        id: string,
      ) {
        const rows = yield* db
          .select({ agentId: githubAccountBots.agentId })
          .from(githubAccountBots)
          .where(eq(githubAccountBots.accountId, id))
          .orderBy(asc(githubAccountBots.assignedAt));

        return rows.map((each) => each.agentId);
      }, Effect.orDie);

      const accountOf = Effect.fn("GitHubAccounts.accountOf")(function* (
        found: AccountRow,
      ) {
        return {
          id: found.id,
          login: found.login,
          htmlUrl: `https://github.com/${found.login}`,
          botIds: yield* botIdsOf(found.id),
          token: yield* secrets.status(tokenKey(found.id)),
          signingKey: publicSigningKey(
            yield* privateKey(found.id),
            found.login,
          ),
          createdAt: found.createdAt,
        } satisfies GitHubAccount;
      });

      const get = Effect.fn("GitHubAccounts.get")(function* (id: string) {
        const found = yield* row(id);

        if (!found)
          return yield* new NotFound({ message: "Machine account not found" });

        return yield* accountOf(found);
      });

      const list = Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(githubAccounts)
          .orderBy(asc(githubAccounts.createdAt))
          .pipe(Effect.orDie);

        return yield* Effect.forEach(rows, accountOf);
      }).pipe(Effect.withSpan("GitHubAccounts.list"));

      const notAdded = Effect.fnUntraced(function* (found: {
        login: string;
        id: number;
      }) {
        const [existing] = yield* db
          .select({ id: githubAccounts.id })
          .from(githubAccounts)
          .where(eq(githubAccounts.userId, found.id))
          .pipe(Effect.orDie);

        if (existing)
          return yield* new Conflict({
            message: `${found.login} is already added; replace its token instead`,
          });
      });

      const add = Effect.fn("GitHubAccounts.add")(function* (
        token: SecretInput,
      ) {
        const id = randomUUID();

        const found = yield* secrets.save(tokenKey(id), token, (value) =>
          userOf(value).pipe(Effect.tap(notAdded)),
        );

        yield* serverSecrets.set(signingKeyKey(id), newSigningKey());

        yield* db
          .insert(githubAccounts)
          .values({
            id,
            login: found.login,
            userId: found.id,
            createdAt: yield* nowIso,
          })
          .pipe(Effect.orDie);

        return yield* get(id).pipe(Effect.orDie);
      });

      const setToken = Effect.fn("GitHubAccounts.setToken")(function* (
        id: string,
        token: SecretInput,
      ) {
        const found = yield* row(id);

        if (!found)
          return yield* new NotFound({ message: "Machine account not found" });

        const owner = yield* secrets.save(tokenKey(id), token, (value) =>
          userOf(value).pipe(
            Effect.filterOrFail(
              (each) => each.id === found.userId,
              (each) =>
                new InvalidInput({
                  message: `This token signs in as ${each.login}, not ${found.login}`,
                }),
            ),
          ),
        );

        // A renamed user keeps its ID; the login follows the token.
        yield* db
          .update(githubAccounts)
          .set({ login: owner.login })
          .where(eq(githubAccounts.id, id))
          .pipe(Effect.orDie);

        return yield* get(id);
      });

      const ofBot = Effect.fn("GitHubAccounts.ofBot")(function* (
        agentId: string,
      ) {
        const [found] = yield* db
          .select({ account: githubAccounts })
          .from(githubAccountBots)
          .innerJoin(
            githubAccounts,
            eq(githubAccounts.id, githubAccountBots.accountId),
          )
          .where(eq(githubAccountBots.agentId, agentId))
          .pipe(Effect.orDie);

        if (!found) return;
        const key = yield* privateKey(found.account.id);

        return {
          login: found.account.login,
          userId: found.account.userId,
          signingKey: publicSigningKey(key, found.account.login),
          sign: (data: Uint8Array) => sshSign(key, data, "git"),
          token: Effect.flatMap(
            secrets.read(tokenKey(found.account.id)),
            (token) =>
              token
                ? Effect.succeed(token)
                : Effect.fail(
                    new GitHubUnavailable({
                      message: `the machine account ${found.account.login} has no token`,
                    }),
                  ),
          ),
        };
      });

      return GitHubAccounts.of({
        list,
        get,
        add,
        setToken,
        ofBot,
      });
    }),
  );
}

/**
 * Who acts as a machine account. Only `GitHubApps` runs these: each bot they change needs its `GH_TOKEN` credential
 * synced, which takes the bot's Apps too.
 */
export const accountMembership = Effect.gen(function* () {
  const db = yield* ProductDatabase;
  const secrets = yield* Secrets;
  const serverSecrets = yield* ServerSecrets;
  const accounts = yield* GitHubAccounts;

  const assign = Effect.fn("accountMembership.assign")(function* (
    id: string,
    botIds: readonly string[],
  ) {
    const current = yield* accounts.get(id);
    const { added, removed } = assignmentChange(current.botIds, botIds);

    const clashing = added.length
      ? yield* db
          .select({ agentId: githubAccountBots.agentId })
          .from(githubAccountBots)
          .where(
            and(
              inArray(githubAccountBots.agentId, added),
              ne(githubAccountBots.accountId, id),
            ),
          )
          .pipe(Effect.orDie)
      : [];

    if (clashing.length)
      return yield* new Conflict({
        message:
          "A bot already acts as another machine account; take it off that account first",
      });

    const at = yield* nowIso;

    yield* db
      .transaction(() =>
        Effect.gen(function* () {
          if (removed.length)
            yield* db
              .delete(githubAccountBots)
              .where(inArray(githubAccountBots.agentId, removed));

          if (added.length)
            yield* db.insert(githubAccountBots).values(
              added.map((agentId) => ({
                agentId,
                accountId: id,
                assignedAt: at,
              })),
            );
        }),
      )
      .pipe(Effect.orDie);

    return {
      account: yield* accounts.get(id),
      changed: [...added, ...removed],
    };
  });

  const remove = Effect.fn("accountMembership.remove")(function* (id: string) {
    const { botIds } = yield* accounts.get(id);

    yield* db
      .delete(githubAccounts)
      .where(eq(githubAccounts.id, id))
      .pipe(Effect.orDie);
    yield* secrets.delete(tokenKey(id));
    yield* serverSecrets.delete(signingKeyKey(id));

    return botIds;
  });

  return { assign, remove };
});
