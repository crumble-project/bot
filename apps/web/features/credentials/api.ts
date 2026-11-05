import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  credentialsResponse,
  credentialUseResponse,
} from "@crumble/server/contract/api-responses";
import { agentPath } from "@/features/bots/api";
import { api, queryClient } from "@/lib/api";
import { refreshSecrets } from "@/lib/secrets";

export type Credentials = z.infer<typeof credentialsResponse>;

export type Credential = Credentials["credentials"][number];

export type CredentialRequest = Credentials["requests"][number];

export type CredentialUse = z.infer<typeof credentialUseResponse>;

const credentialsKey = ["credentials"];

export const credentialsQuery = (id: string) =>
  queryOptions({
    queryKey: [...credentialsKey, id],
    queryFn: ({ signal }) =>
      api<"agentCredentials">(`${agentPath(id)}/credentials`, { signal }),
  });

export const credentialPath = (id: string, name: string) =>
  `${agentPath(id)}/credentials/${encodeURIComponent(name)}` as const;

/** Every bot's credentials, for writes that reach more than one bot. */
export const refreshAllCredentials = () =>
  queryClient.invalidateQueries({ queryKey: credentialsKey });

export async function refreshCredentials(id: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: credentialsQuery(id).queryKey }),
    refreshSecrets(),
  ]);
}
