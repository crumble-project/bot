import { queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  desktopControlResponse,
  desktopViewerResponse,
  heldActionResponse,
} from "@crumble/server/contract/api-responses";
import { agentPath } from "@/features/bots/api";
import { api } from "@/lib/api";

export type DesktopControl = z.infer<typeof desktopControlResponse>;

export type DesktopViewer = z.infer<typeof desktopViewerResponse>;

export type HeldAction = z.infer<typeof heldActionResponse>;

const HELD_POLL_MS = 5000;

export const desktopStatusQuery = (id: string) =>
  queryOptions({
    queryKey: ["desktop-status", id],
    queryFn: ({ signal }) =>
      api<"desktopStatus">(`${agentPath(id)}/desktop/status`, { signal }),
  });

export const heldActionsQuery = (id: string) =>
  queryOptions({
    queryKey: ["held-actions", id],
    queryFn: ({ signal }) =>
      api<"agentHeldActions">(`${agentPath(id)}/held-actions`, { signal }),
    // A stopped job, a restart, or another client can end a waiting action.
    refetchInterval: (query) =>
      query.state.data?.some((action) => action.status === "pending")
        ? HELD_POLL_MS
        : false,
  });

export const heldActionPath = (id: string, actionId: string) =>
  `${agentPath(id)}/held-actions/${encodeURIComponent(actionId)}` as const;
