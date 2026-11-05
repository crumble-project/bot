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

export class GitHubUnavailable extends Schema.TaggedError<GitHubUnavailable>()(
  "GitHubUnavailable",
  { message: Schema.String, status: Schema.optional(Schema.Number) },
) {}

export const noreplyEmail = (userId: number, login: string) =>
  `${userId}+${login}@users.noreply.github.com`;

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

export const githubFile = (repository: string, commit: string, path: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const url = `https://raw.githubusercontent.com/${repository}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
      const response = await fetch(url, { signal });

      if (!response.ok) throw new Error(String(response.status));

      return response.text();
    },
    catch: () =>
      new GitHubUnavailable({ message: `Can't read ${path} from GitHub` }),
  }).pipe(timed);

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
