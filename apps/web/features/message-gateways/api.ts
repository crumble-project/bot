import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  gatewayConfigInput,
  gatewayResponse,
} from "@crumble/server/contract/message-gateway";
import { api } from "@/lib/api";

export type GatewayConfig = z.infer<typeof gatewayConfigInput>;

export type MessageGateway = z.infer<typeof gatewayResponse>;

export const messageGatewaysQuery = queryOptions({
  queryKey: ["message-gateways"],
  queryFn: async ({ signal }) =>
    (await api<"messageGateways">("/v1/message-gateways", { signal })).gateways,
  refetchInterval: 5000,
});

export const messageGatewayPath = (id: string) =>
  `/v1/message-gateways/${encodeURIComponent(id)}` as const;
