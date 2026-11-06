import type { z } from "@hono/zod-openapi";
import type {
  activityEvent,
  activityFeedResponse,
  learnedChangeResponse,
} from "@crumble/server/contract/api-responses";

export type ActivityFeed = z.infer<typeof activityFeedResponse>;

export type ActivityEvent = z.infer<typeof activityEvent>;

export type Change = z.infer<typeof learnedChangeResponse>;

export const activityKey = ["activity"];
