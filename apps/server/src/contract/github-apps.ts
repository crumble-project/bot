import { z } from "@hono/zod-openapi";

export const githubAppManifestInput = z
  .object({
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

export const githubAppManifestResponse = z.object({
  url: z.string(),
  manifest: z.string(),
});

export const githubAppResponse = z
  .object({
    slug: z.string(),
    name: z.string(),
    login: z.string(),
    htmlUrl: z.string(),
    installUrl: z.string(),
    installedOn: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("GitHubApp");

export const githubAppStatusResponse = z.object({
  app: githubAppResponse.nullable(),
});

export type GitHubAppResponse = z.infer<typeof githubAppResponse>;
