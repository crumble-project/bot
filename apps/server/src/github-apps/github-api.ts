import { Clock, Effect, Schema } from "effect";
import type { z } from "zod";
import type { SecretRepository } from "../credentials/secret-repository";

const API = "https://api.github.com";

/** The credential a bot's GitHub token is swapped in for; `gh` and most GitHub tools read it. */
export const GITHUB_TOKEN_CREDENTIAL = "GH_TOKEN";

export const GITHUB_HOSTS = [
  "github.com",
  "api.github.com",
  "uploads.github.com",
];

/** GitHub couldn't be reached or refused a request, or the bot has no GitHub App for it */
export class GitHubUnavailable extends Schema.TaggedError<GitHubUnavailable>()(
  "GitHubUnavailable",
  { message: Schema.String },
) {}

/** How a bot commits in one GitHub account's repositories; `trailer` marks commits made as the owner. */
export type GitHubIdentity = {
  account: string;
  name: string;
  email: string;
  trailer?: string | undefined;
};

export const noreplyEmail = (userId: number, login: string) =>
  `${userId}+${login}@users.noreply.github.com`;

/** One call to GitHub's REST API, its answer parsed with `schema`. */
export const github = <T>(
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
    catch: () => new GitHubUnavailable({ message: "Can't reach GitHub" }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () =>
        Effect.fail(new GitHubUnavailable({ message: "GitHub timed out" })),
    }),
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise({
            try: async () => schema.parse(await response.json()),
            catch: () =>
              new GitHubUnavailable({
                message: "GitHub answered in an unexpected shape",
              }),
          })
        : Effect.fail(
            new GitHubUnavailable({
              message: `GitHub answered ${response.status}`,
            }),
          ),
    ),
  );

/** The state saved before sending the owner to GitHub; undefined when unknown or older than `ttlMs`. */
export const pendingState = <T extends { createdAt: number }>(
  secrets: SecretRepository["Service"],
  key: string,
  schema: z.ZodType<T>,
  ttlMs: number,
) =>
  Effect.gen(function* () {
    const raw = yield* secrets.get(key);
    const parsed = raw ? schema.safeParse(JSON.parse(raw)) : undefined;
    const now = yield* Clock.currentTimeMillis;

    return parsed?.success && now - parsed.data.createdAt <= ttlMs
      ? parsed.data
      : undefined;
  });
