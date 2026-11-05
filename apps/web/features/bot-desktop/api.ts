import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  desktopControlResponse,
  desktopViewerResponse,
} from "@crumble/server/contract/api-responses";
import { agentPath } from "@/features/bots/api";
import { api } from "@/lib/api";

export type DesktopControl = z.infer<typeof desktopControlResponse>;

export type DesktopViewer = z.infer<typeof desktopViewerResponse>;

export const desktopStatusQuery = (id: string) =>
  queryOptions({
    queryKey: ["desktop-status", id],
    queryFn: ({ signal }) =>
      api<"desktopStatus">(`${agentPath(id)}/desktop/status`, { signal }),
  });
