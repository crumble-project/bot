import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type { describedMcpServerResponse } from "@crumble/server/contract/api-responses";
import { api } from "@/lib/api";

export type McpServer = z.infer<typeof describedMcpServerResponse>;

export const mcpServersQuery = queryOptions({
  queryKey: ["mcp-servers"],
  queryFn: ({ signal }) => api<"mcpServers">("/v1/mcp-servers", { signal }),
});

export const mcpServerPath = (id: string) =>
  `/v1/mcp-servers/${encodeURIComponent(id)}` as const;
