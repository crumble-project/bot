import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type { serverSettingsSchema } from "@crumble/server/contract/admin";
import { api, queryClient } from "@/lib/api";

export type ServerSettings = z.infer<typeof serverSettingsSchema>;

export const serverSettingsQuery = queryOptions({
  queryKey: ["admin", "settings"],
  queryFn: () => api<"serverSettings">("/v1/admin/settings"),
});

export const refreshAdmin = () =>
  queryClient.invalidateQueries({ queryKey: ["admin"] });
