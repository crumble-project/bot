import { z } from "@hono/zod-openapi";
import {
  PUSH_ENVIRONMENTS,
  PUSH_PLATFORMS,
  PUSH_TRANSPORTS,
} from "../shared/push-devices";
import { body, define, empty, json } from "./route";

export const chatReference = z.object({
  kind: z.enum(["bot", "group"]),
  id: z.string().min(1),
});

export type ChatReference = z.infer<typeof chatReference>;

export const replySurface = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text") }),
  z.object({ kind: z.literal("tool-card"), toolCallId: z.string().min(1) }),
  z.object({ kind: z.literal("held-action"), actionId: z.string().min(1) }),
]);

export type ReplySurface = z.infer<typeof replySurface>;

export const replyReference = z.object({
  eventId: z.string().min(1),
  surface: replySurface,
});

export type ReplyReference = z.infer<typeof replyReference>;

export const replyAssociation = z.object({
  eventId: z.string().min(1),
  chat: chatReference,
  messageId: z.string().min(1),
  entryId: z.string().min(1),
  surface: replySurface,
});

export type ReplyAssociation = z.infer<typeof replyAssociation>;

export const pushInput = z
  .object({
    platform: z.enum(PUSH_PLATFORMS),
    transport: z.enum(PUSH_TRANSPORTS),
    token: z.string().trim().min(1).max(4096),
    environment: z.enum(PUSH_ENVIRONMENTS),
    bundleId: z.string().trim().min(1).max(255).optional(),
    enabled: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.transport === "fcm" && value.platform !== "android")
      ctx.addIssue({
        code: "custom",
        path: ["transport"],
        message: "FCM is only valid for Android",
      });

    if (value.transport === "apns" && value.platform === "android")
      ctx.addIssue({
        code: "custom",
        path: ["transport"],
        message: "APNs is only valid for macOS or iOS",
      });

    if (value.transport === "apns" && !value.bundleId)
      ctx.addIssue({
        code: "custom",
        path: ["bundleId"],
        message: "APNs requires bundleId",
      });
  });

export const viewInput = z.object({ chat: chatReference.nullable() });

export const seenInput = z.object({
  chat: chatReference,
  eventIds: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Event IDs must be distinct",
    ),
});

export const pushStatusResponse = z
  .object({
    serverId: z.string(),
    transports: z.object({ apns: z.boolean(), fcm: z.boolean() }),
  })
  .openapi("PushStatus");

export const pushDeviceResponse = z
  .object({ serverId: z.string(), remoteDelivery: z.boolean() })
  .openapi("PushDeviceRegistration");

const installation = z.object({ installationId: z.uuid() });

export const pushRoutes = {
  pushStatus: define({
    method: "get",
    path: "/v1/push",
    operationId: "getPushStatus",
    responses: { 200: json(pushStatusResponse) },
  }),
  putDevice: define({
    method: "put",
    path: "/v1/push/devices/{installationId}",
    operationId: "putPushDevice",
    request: { params: installation, body: body(pushInput) },
    responses: { 200: json(pushDeviceResponse) },
  }),
  deleteDevice: define({
    method: "delete",
    path: "/v1/push/devices/{installationId}",
    operationId: "deletePushDevice",
    request: { params: installation },
    responses: { 204: empty },
  }),
  putView: define({
    method: "put",
    path: "/v1/chat-attention/views/{viewId}",
    operationId: "putChatAttentionView",
    request: {
      params: z.object({ viewId: z.string().min(1) }),
      body: body(viewInput),
    },
    responses: { 204: empty },
  }),
  postSeen: define({
    method: "post",
    path: "/v1/chat-attention/seen",
    operationId: "postChatAttentionSeen",
    request: { body: body(seenInput) },
    responses: { 204: empty },
  }),
};
