import { Effect, Schema } from "effect";
import { z } from "zod";

const API = "https://api.github.com";

/** The credential a bot's GitHub token is swapped in for; `gh` and most GitHub tools read it. */
export const GITHUB_TOKEN_CREDENTIAL = "GH_TOKEN";

export const GITHUB_HOSTS = [
  "github.com",
  "api.github.com",
  "uploads.github.com",
];

/** GitHub couldn't be reached or refused a request, or the bot has no GitHub App or machine account for it */
export class GitHubUnavailable extends Schema.TaggedError<GitHubUnavailable>()(
  "GitHubUnavailable",
  { message: Schema.String, status: Schema.optional(Schema.Number) },
) {}

/** How a bot commits in one GitHub account's repositories, or in every other one for a machine account (`account`
 * null); `trailer` marks commits made as the owner. */
export type GitHubIdentity = {
  account: string | null;
  name: string;
  email: string;
  trailer?: string | undefined;
};

/** The bots an assignment adds and takes off, from the identity's current bots and the requested ones. */
export const assignmentChange = (
  previous: readonly string[],
  botIds: readonly string[],
) => ({
  added: botIds.filter((botId) => !previous.includes(botId)),
  removed: previous.filter((botId) => !botIds.includes(botId)),
});

export const noreplyEmail = (userId: number, login: string) =>
  `${userId}+${login}@users.noreply.github.com`;

/** The GitHub user a token signs in as. */
export const githubUser = z.object({
  login: z.string().min(1),
  id: z.number().int(),
});

/** The name a GitHub App's commits and pull requests show. */
export const botLogin = (slug: string) => `${slug}[bot]`;

const timed = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () =>
        Effect.fail(new GitHubUnavailable({ message: "GitHub timed out" })),
    }),
  );

const REST_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const send = (url: string, init: RequestInit, unreachable: string) =>
  Effect.tryPromise({
    try: (signal) => fetch(url, { ...init, signal }),
    catch: () => new GitHubUnavailable({ message: unreachable }),
  });

/** One call to GitHub's REST API, its answer parsed with `schema`. */
export const github = <T>(
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; token?: string } = {},
) =>
  send(
    `${API}${path}`,
    {
      method: init.method ?? "GET",
      headers: {
        ...REST_HEADERS,
        ...(init.token && { Authorization: `Bearer ${init.token}` }),
      },
    },
    "Can't reach GitHub",
  ).pipe(
    timed,
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
              status: response.status,
            }),
          ),
    ),
  );

/** Exchanges a code or refresh token at GitHub's OAuth endpoint, on github.com rather than the REST API. */
export const githubOAuth = <T>(
  params: Record<string, string>,
  schema: z.ZodType<T>,
) =>
  send(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams(params),
    },
    "GitHub's sign-in didn't answer",
  ).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: async () => schema.parse(await response.json()),
        catch: () =>
          new GitHubUnavailable({ message: "GitHub's sign-in didn't answer" }),
      }),
    ),
    timed,
  );

/** Revokes an OAuth app's grant, which also ends its refresh token; GitHub's answer is not awaited for more than that. */
export const revokeGitHubGrant = (
  client: { clientId: string; clientSecret: string },
  accessToken: string,
) =>
  send(
    `${API}/applications/${client.clientId}/grant`,
    {
      method: "DELETE",
      headers: {
        ...REST_HEADERS,
        Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({ access_token: accessToken }),
    },
    "Can't reach GitHub",
  ).pipe(timed, Effect.ignore);
