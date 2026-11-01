import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { Context, Effect, Layer, Redacted } from "effect";
import { z } from "zod";
import type { SecretUnavailable } from "../password-managers/secret-values";
import { Secrets, secretKey } from "../password-managers/secrets";
import type { SecretInput, SecretStatus } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { Conflict, InvalidInput, NotFound } from "../shared/errors";
import { GitHubUnavailable, assignmentChange, github } from "./github-api";
import { githubAccountBots, githubAccounts } from "./schema";

/** A machine account as the owner sees it; its token never leaves the server. */
export type GitHubAccount = {
  id: string;
  login: string;
  htmlUrl: string;
  botIds: string[];
  token: SecretStatus;
  createdAt: string;
};

/** The machine account a bot acts as, for the credential proxy and the bot's commits; `token` reads it on use. */
export type GitHubAccountOfBot = {
  login: string;
  userId: number;
  token: Effect.Effect<Redacted.Redacted, SecretUnavailable>;
};

const tokenKey = (id: string) => secretKey("github-account", id);

const user = z.object({ login: z.string().min(1), id: z.number().int() });

/** The GitHub user a token signs in as; a token GitHub refuses is the owner's input to fix. */
const userOf = (token: Redacted.Redacted) =>
  github("/user", user, { token: Redacted.value(token) }).pipe(
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
    /** Replaces the token, such as one about to expire, with another of the same GitHub user. */
    readonly setToken: (
      id: string,
      token: SecretInput,
    ) => Effect.Effect<
      GitHubAccount,
      NotFound | InvalidInput | GitHubUnavailable
    >;
    /** Replaces the account's bots and returns every bot whose machine account changed. */
    readonly assign: (
      id: string,
      botIds: readonly string[],
    ) => Effect.Effect<
      { account: GitHubAccount; changed: string[] },
      NotFound | Conflict
    >;
    /** Forgets the account and returns the bots that acted as it. */
    readonly remove: (id: string) => Effect.Effect<string[], NotFound>;
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

      const assign = Effect.fn("GitHubAccounts.assign")(function* (
        id: string,
        botIds: readonly string[],
      ) {
        if (!(yield* row(id)))
          return yield* new NotFound({ message: "Machine account not found" });

        const { added, removed } = assignmentChange(
          yield* botIdsOf(id),
          botIds,
        );

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

        return { account: yield* get(id), changed: [...added, ...removed] };
      });

      const remove = Effect.fn("GitHubAccounts.remove")(function* (id: string) {
        const botIds = yield* botIdsOf(id);

        const deleted = yield* db
          .delete(githubAccounts)
          .where(eq(githubAccounts.id, id))
          .returning({ id: githubAccounts.id })
          .pipe(Effect.orDie);

        if (!deleted.length)
          return yield* new NotFound({ message: "Machine account not found" });

        yield* secrets.delete(tokenKey(id));

        return botIds;
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

        if (!found) return undefined;

        return {
          login: found.account.login,
          userId: found.account.userId,
          token: secrets
            .read(tokenKey(found.account.id))
            .pipe(Effect.map((token) => token ?? Redacted.make(""))),
        };
      });

      return GitHubAccounts.of({
        list,
        get,
        add,
        setToken,
        assign,
        remove,
        ofBot,
      });
    }),
  );
}
