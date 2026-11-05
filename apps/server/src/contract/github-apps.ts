import { z } from "@hono/zod-openapi";
import { secretStatusResponse } from "./api-responses";

export const MAX_GITHUB_APP_NAME_CHARS = 34;

export const githubAppManifestInput = z
  .object({
    /** The App's name on GitHub, unique across GitHub. */
    name: z.string().trim().min(1).max(MAX_GITHUB_APP_NAME_CHARS),
    /** The web UI's origin; GitHub sends the owner back to its callback page. */
    origin: z.url({ protocol: /^https?$/ }).max(2000),
    /** Create the App on this organization instead of the owner's account. */
    organization: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,39}$/, "Organization names are GitHub logins")
      .optional(),
  })
  .strict();

export const githubAppCompleteInput = z
  .object({
    code: z.string().min(1).max(200),
    state: z.string().min(1).max(200),
  })
  .strict();

export const githubAppSignInInput = z
  .object({
    /** The web UI's origin; GitHub sends the owner back to its sign-in page. */
    origin: z.url({ protocol: /^https?$/ }).max(2000),
  })
  .strict();

export const githubAppSignInResponse = z.object({ url: z.string() });

export const githubBotsInput = z
  .object({ botIds: z.array(z.string().min(1)).max(200) })
  .strict();

export const githubAppManifestResponse = z.object({
  url: z.string(),
  manifest: z.string(),
});

export const githubAppResponse = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    login: z.string().openapi({
      description:
        "The name commits and pull requests show, such as `scout[bot]`.",
    }),
    htmlUrl: z.string(),
    installUrl: z.string(),
    account: z.string().nullable().openapi({
      description:
        "The GitHub user or organization whose repositories the App works on.",
    }),
    installed: z.boolean(),
    clientSecret: secretStatusResponse,
    user: z.string().nullable().openapi({
      description:
        "The owner's GitHub login when signed in through the App; its bots then act as the owner, with the App's badge.",
    }),
    botIds: z.array(z.string()),
    createdAt: z.string(),
  })
  .openapi("GitHubApp");

export const githubAppsResponse = z.object({
  apps: z.array(githubAppResponse),
});

export type GitHubAppResponse = z.infer<typeof githubAppResponse>;

export const githubAccountResponse = z
  .object({
    id: z.string(),
    login: z.string().openapi({
      description: "The GitHub user its bots act and commit as.",
    }),
    htmlUrl: z.string(),
    botIds: z.array(z.string()),
    token: secretStatusResponse,
    signingKey: z.string().openapi({
      description:
        "The OpenSSH public key the account's commits are signed with. Add it on GitHub as the user's signing key so its commits show as verified.",
    }),
    createdAt: z.string(),
  })
  .openapi("GitHubAccount");

export const githubAccountsResponse = z.object({
  accounts: z.array(githubAccountResponse),
});

/** The web pages GitHub sends the owner back to, published in each App's manifest; older Apps keep what they registered. */
export const GITHUB_APP_WEB_PATHS = {
  created: "/github-app/callback",
  installed: "/github-app/installed",
  authorized: "/github-app/authorized",
} as const;
