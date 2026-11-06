import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type { secretStatusResponse } from "@crumble/server/contract/api-responses";
import { api, queryClient, type ResponseBody } from "@/lib/api";

export type PasswordManager =
  ResponseBody<"passwordManagers">["passwordManagers"][number];

export type PasswordManagerId = PasswordManager["id"];

export type SecretStatus = z.infer<typeof secretStatusResponse>;

export const passwordManagersQuery = queryOptions({
  queryKey: ["password-managers"],
  queryFn: async ({ signal }) =>
    (await api<"passwordManagers">("/v1/password-managers", { signal }))
      .passwordManagers,
});

export const passwordManagerPath = (id: PasswordManagerId) =>
  `/v1/password-managers/${encodeURIComponent(id)}` as const;

/** After any secret write: each password manager's "used by" counts every saved reference. */
export const invalidateSecrets = () =>
  queryClient.invalidateQueries({ queryKey: passwordManagersQuery.queryKey });
