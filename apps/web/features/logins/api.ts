import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  loginsResponse,
  loginUseResponse,
} from "@crumble/server/contract/api-responses";
import { agentPath } from "@/features/bots/api";
import { api, queryClient } from "@/lib/api";
import { refreshSecrets } from "@/features/password-managers/api";

export type Logins = z.infer<typeof loginsResponse>;

export type Login = Logins["logins"][number];

export type LoginRequest = Logins["requests"][number];

export type LoginUse = z.infer<typeof loginUseResponse>;

export const loginsQuery = (id: string) =>
  queryOptions({
    queryKey: ["logins", id],
    queryFn: ({ signal }) =>
      api<"agentLogins">(`${agentPath(id)}/logins`, { signal }),
  });

export const loginPath = (id: string, name: string) =>
  `${agentPath(id)}/logins/${encodeURIComponent(name)}` as const;

export async function refreshLogins(id: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: loginsQuery(id).queryKey }),
    refreshSecrets(),
  ]);
}
