import { z } from "@hono/zod-openapi";
import { body, define, empty, json } from "../contract/route";

export const pushInput = z
  .object({
    platform: z.enum(["macos", "ios", "android"]),
    transport: z.enum(["apns", "fcm"]),
    token: z.string().trim().min(1).max(4096),
    environment: z.enum(["development", "production"]),
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

export const presenceInput = z.object({
  active: z.boolean(),
  agentId: z.uuid().nullable(),
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
  putPresence: define({
    method: "put",
    path: "/v1/push/devices/{installationId}/presence",
    operationId: "putPushPresence",
    request: { params: installation, body: body(presenceInput) },
    responses: { 204: empty },
  }),
};
