import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type { pluginSettingsResponse } from "@crumble/server/contract/api-responses";
import { api } from "@/lib/api";

export type PluginSettings = z.infer<typeof pluginSettingsResponse>;

export const pluginSettingsQuery = queryOptions({
  queryKey: ["plugin-settings"],
  queryFn: ({ signal }) =>
    api<"pluginSettings">("/v1/plugin-settings", { signal }),
});

export const pluginSettingPath = (pluginId: string, key: string) =>
  `/v1/plugin-settings/${encodeURIComponent(pluginId)}/${encodeURIComponent(key)}` as const;
