import {
  createRoute,
  OpenAPIHono,
  z,
  type RouteConfig,
} from "@hono/zod-openapi";
import { agentInput, scheduleInput, skillInput } from "./domain";
import { attachmentInput, MAX_ATTACHMENTS } from "./attachments";
import * as response from "./api-responses";

export const memoryInput = z.object({
  content: z.string().trim().min(1).max(32000),
});

export const snapshotInput = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const historyInput = snapshotInput.extend({
  before: z.string().min(1).max(200).optional(),
});

export const messageInput = z
  .object({
    content: z.string().trim().max(32000),
    requestId: z.string().uuid(),
    replyTo: z.string().min(1).max(200).optional(),
    attachments: z.array(attachmentInput).max(MAX_ATTACHMENTS).default([]),
    timezone: z.string().min(1).max(100).optional(),
  })
  .refine((value) => value.content || value.attachments.length, {
    message: "Write a message or attach a file",
    path: ["content"],
  });

export const activityInput = z.object({
  agentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

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
  agentId: z.string().uuid().nullable(),
});

export const providerKeyInput = z.object({
  apiKey: z.string().trim().min(1).max(16000),
});

export const oauthInput = z.object({
  redirectUri: z
    .string()
    .max(500)
    .regex(/^[a-z][a-z0-9+.-]*:\S+$/i, "Use an absolute redirect URI"),
});

export const oauthCallbackInput = z.object({
  code: z.string().min(1).max(4000),
  state: z.string().min(1).max(200),
  iss: z.string().min(1).max(500).optional(),
});

export const mcpInput = z.object({
  name: z.string().trim().min(1).max(100),
  url: z
    .url()
    .refine(
      (value) => ["http:", "https:"].includes(new URL(value).protocol),
      "Use an HTTP or HTTPS URL",
    ),
  enabled: z.boolean().default(true),
  token: z.string().max(16000).optional(),
});

export const mcpCreateInput = mcpInput.extend({
  agentId: z.string().uuid().nullable().default(null),
});

export const attachmentIndex = z.coerce
  .number()
  .int()
  .min(0)
  .max(MAX_ATTACHMENTS - 1);

const id = z.object({ id: z.string() });
const installation = z.object({ installationId: z.string().uuid() });
const memoryParams = id.extend({ memoryId: z.string() });

const json = <S extends z.ZodType>(schema: S, description = "Success") => ({
  description,
  content: { "application/json": { schema } },
});

const body = <S extends z.ZodType>(schema: S) => ({
  required: true,
  content: { "application/json": { schema } },
});

function patchInput(schema: z.ZodObject) {
  const fields: Record<string, z.ZodType> = {};

  for (const [key, field] of Object.entries(schema.shape))
    fields[key] = (
      field instanceof z.ZodDefault ? field.removeDefault() : field
    ).optional();

  return z.object(fields);
}

const empty = { description: "Success, no response body" };

const error = z
  .object({
    error: z.string(),
    details: z
      .array(
        z
          .object({
            code: z.string(),
            path: z.array(z.union([z.string(), z.number()])),
            message: z.string(),
          })
          .loose(),
      )
      .optional(),
  })
  .openapi("Error");

const errors = {
  400: json(error, "Invalid request or operation"),
  401: {
    description: "Missing or invalid bearer token",
    content: { "text/plain": { schema: z.string() } },
  },
  404: json(error, "Resource not found"),
  405: json(error, "Resource is read-only"),
  409: json(error, "Conflicting request"),
  413: {
    description: "Request body exceeds the size limit",
    content: { "text/plain": { schema: z.string() } },
  },
  500: json(error, "Internal server error"),
  503: json(error, "Service unavailable"),
};

function define<const R extends RouteConfig>(config: R) {
  return createRoute({
    ...config,
    security: [{ BearerAuth: [] }],
    responses: { ...errors, ...config.responses },
  });
}

export const routes = {
  health: createRoute({
    method: "get",
    path: "/health",
    operationId: "getHealth",
    security: [],
    responses: { 200: json(response.healthResponse) },
  }),
  capabilities: define({
    method: "get",
    path: "/v1/capabilities",
    operationId: "getCapabilities",
    responses: { 200: json(response.capabilitiesResponse) },
  }),
  pushStatus: define({
    method: "get",
    path: "/v1/push",
    operationId: "getPushStatus",
    responses: { 200: json(response.pushStatusResponse) },
  }),
  putDevice: define({
    method: "put",
    path: "/v1/push/devices/{installationId}",
    operationId: "putPushDevice",
    request: { params: installation, body: body(pushInput) },
    responses: { 200: json(response.pushDeviceResponse) },
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
  listAgents: define({
    method: "get",
    path: "/v1/agents",
    operationId: "listAgents",
    responses: { 200: json(z.array(response.agentPreviewResponse)) },
  }),
  createAgent: define({
    method: "post",
    path: "/v1/agents",
    operationId: "createAgent",
    request: { body: body(agentInput) },
    responses: { 201: json(response.agentResponse) },
  }),
  getAgent: define({
    method: "get",
    path: "/v1/agents/{id}",
    operationId: "getAgent",
    request: { params: id },
    responses: { 200: json(response.agentResponse) },
  }),
  updateAgent: define({
    method: "patch",
    path: "/v1/agents/{id}",
    operationId: "updateAgent",
    request: { params: id, body: body(patchInput(agentInput)) },
    responses: { 200: json(z.union([response.agentResponse, z.null()])) },
  }),
  duplicateAgent: define({
    method: "post",
    path: "/v1/agents/{id}/duplicate",
    operationId: "duplicateAgent",
    request: { params: id },
    responses: { 201: json(z.union([response.agentResponse, z.null()])) },
  }),
  deleteAgent: define({
    method: "delete",
    path: "/v1/agents/{id}",
    operationId: "deleteAgent",
    request: { params: id },
    responses: { 204: empty },
  }),
  chat: define({
    method: "get",
    path: "/v1/agents/{id}/chat",
    operationId: "getChat",
    request: { params: id, query: snapshotInput },
    responses: { 200: json(response.chatSnapshotResponse) },
  }),
  history: define({
    method: "get",
    path: "/v1/agents/{id}/chat/history",
    operationId: "getChatHistory",
    request: { params: id, query: historyInput },
    responses: { 200: json(response.historyResponse) },
  }),
  codingJobs: define({
    method: "get",
    path: "/v1/agents/{id}/coding-jobs",
    operationId: "listCodingJobs",
    request: { params: id },
    responses: { 200: json(response.codingJobsResponse) },
  }),
  codingJobHistory: define({
    method: "get",
    path: "/v1/agents/{id}/coding-jobs/{name}/history",
    operationId: "getCodingJobHistory",
    request: { params: id.extend({ name: z.string() }), query: historyInput },
    responses: { 200: json(response.historyResponse) },
  }),
  sendMessage: define({
    method: "post",
    path: "/v1/agents/{id}/messages",
    operationId: "sendMessage",
    request: { params: id, body: body(messageInput) },
    responses: { 202: json(response.executionResponse) },
  }),
  attachment: define({
    method: "get",
    path: "/v1/agents/{id}/attachments/{entryId}/{index}",
    operationId: "getAttachment",
    request: {
      params: id.extend({
        entryId: z.string(),
        index: attachmentIndex.openapi({
          param: { name: "index", in: "path", required: true },
        }),
      }),
    },
    responses: {
      200: {
        description:
          "Attachment bytes; Content-Type identifies the image format",
        content: {
          "image/*": { schema: z.string().openapi({ format: "binary" }) },
        },
        headers: {
          "Cache-Control": {
            schema: { type: "string" },
            description: "private, max-age=31536000, immutable",
          },
        },
      },
    },
  }),
  abort: define({
    method: "post",
    path: "/v1/agents/{id}/abort",
    operationId: "abortChat",
    request: { params: id },
    responses: { 204: empty },
  }),
  compact: define({
    method: "post",
    path: "/v1/agents/{id}/compact",
    operationId: "compactChat",
    request: { params: id },
    responses: { 202: json(response.compactResponse) },
  }),
  chatEvents: define({
    method: "get",
    path: "/v1/agents/{id}/events",
    operationId: "streamChatEvents",
    "x-sse-events": {
      snapshot: { $ref: "#/components/schemas/ChatSnapshot" },
      heartbeat: { $ref: "#/components/schemas/HeartbeatEvent" },
    },
    description:
      "Server-sent events. Each snapshot event carries a ChatSnapshot JSON object in data. Heartbeat events carry {} every 15 seconds. Authenticate with the Authorization header. Reconnect by fetching the current snapshot; there is no Last-Event-ID replay.",
    request: { params: id, query: snapshotInput },
    responses: {
      200: {
        description: "SSE stream, not a JSON array",
        content: { "text/event-stream": { schema: z.string() } },
      },
    },
  }),
  events: define({
    method: "get",
    path: "/v1/events",
    operationId: "streamActivityEvents",
    "x-sse-events": {
      activity: { $ref: "#/components/schemas/ActivityEvent" },
      heartbeat: { $ref: "#/components/schemas/HeartbeatEvent" },
    },
    description:
      "Server-sent events. Each activity event carries a ReplyEvent or ChatPreviewEvent JSON object in data. Current chat previews replay on connection; finished replies are not replayed. Heartbeat events carry {} every 15 seconds. Authenticate with the Authorization header. No Last-Event-ID replay.",
    responses: {
      200: {
        description: "SSE stream, not a JSON array",
        content: { "text/event-stream": { schema: z.string() } },
      },
    },
  }),
  agentMemories: define({
    method: "get",
    path: "/v1/agents/{id}/memories",
    operationId: "listAgentMemories",
    request: { params: id },
    responses: { 200: json(z.array(response.memoryResponse)) },
  }),
  createAgentMemory: define({
    method: "post",
    path: "/v1/agents/{id}/memories",
    operationId: "createAgentMemory",
    request: { params: id, body: body(memoryInput) },
    responses: { 201: json(response.memoryResponse) },
  }),
  updateAgentMemory: define({
    method: "patch",
    path: "/v1/agents/{id}/memories/{memoryId}",
    operationId: "updateAgentMemory",
    request: { params: memoryParams, body: body(memoryInput) },
    responses: { 200: json(z.union([response.memoryResponse, z.null()])) },
  }),
  deleteAgentMemory: define({
    method: "delete",
    path: "/v1/agents/{id}/memories/{memoryId}",
    operationId: "deleteAgentMemory",
    request: { params: memoryParams },
    responses: { 204: empty },
  }),
  memories: define({
    method: "get",
    path: "/v1/memories",
    operationId: "listSharedMemories",
    responses: { 200: json(z.array(response.memoryResponse)) },
  }),
  createMemory: define({
    method: "post",
    path: "/v1/memories",
    operationId: "createSharedMemory",
    request: { body: body(memoryInput) },
    responses: { 201: json(response.memoryResponse) },
  }),
  updateMemory: define({
    method: "patch",
    path: "/v1/memories/{id}",
    operationId: "updateSharedMemory",
    request: { params: id, body: body(memoryInput) },
    responses: { 200: json(z.union([response.memoryResponse, z.null()])) },
  }),
  deleteMemory: define({
    method: "delete",
    path: "/v1/memories/{id}",
    operationId: "deleteSharedMemory",
    request: { params: id },
    responses: { 204: empty },
  }),
  skills: define({
    method: "get",
    path: "/v1/skills",
    operationId: "listSkills",
    responses: { 200: json(z.array(response.listedSkillResponse)) },
  }),
  createSkill: define({
    method: "post",
    path: "/v1/skills",
    operationId: "createSkill",
    request: { body: body(skillInput) },
    responses: { 201: json(response.skillResponse) },
  }),
  updateSkill: define({
    method: "patch",
    path: "/v1/skills/{id}",
    operationId: "updateSkill",
    request: { params: id, body: body(patchInput(skillInput)) },
    responses: { 200: json(z.union([response.skillResponse, z.null()])) },
  }),
  deleteSkill: define({
    method: "delete",
    path: "/v1/skills/{id}",
    operationId: "deleteSkill",
    request: { params: id },
    responses: { 204: empty },
  }),
  schedules: define({
    method: "get",
    path: "/v1/schedules",
    operationId: "listSchedules",
    request: { query: z.object({ agentId: z.string().optional() }) },
    responses: { 200: json(z.array(response.scheduleResponse)) },
  }),
  createSchedule: define({
    method: "post",
    path: "/v1/schedules",
    operationId: "createSchedule",
    request: { body: body(scheduleInput) },
    responses: { 201: json(response.scheduleResponse) },
  }),
  updateSchedule: define({
    method: "patch",
    path: "/v1/schedules/{id}",
    operationId: "updateSchedule",
    request: {
      params: id,
      body: body(patchInput(z.object(scheduleInput.shape))),
    },
    responses: { 200: json(z.union([response.scheduleResponse, z.null()])) },
  }),
  deleteSchedule: define({
    method: "delete",
    path: "/v1/schedules/{id}",
    operationId: "deleteSchedule",
    request: { params: id },
    responses: { 204: empty },
  }),
  runSchedule: define({
    method: "post",
    path: "/v1/schedules/{id}/run",
    operationId: "runSchedule",
    request: { params: id },
    responses: { 202: json(response.scheduleRunResponse) },
  }),
  executions: define({
    method: "get",
    path: "/v1/executions",
    operationId: "listExecutions",
    request: { query: z.object({ agentId: z.string().optional() }) },
    responses: { 200: json(z.array(response.executionResponse)) },
  }),
  activity: define({
    method: "get",
    path: "/v1/activity/feed",
    operationId: "getActivityFeed",
    request: { query: activityInput },
    responses: { 200: json(response.activityFeedResponse) },
  }),
  providers: define({
    method: "get",
    path: "/v1/providers",
    operationId: "listProviders",
    responses: { 200: json(z.array(response.providerResponse)) },
  }),
  models: define({
    method: "get",
    path: "/v1/models",
    operationId: "listModels",
    request: { query: z.object({ provider: z.string().optional() }) },
    responses: { 200: json(z.array(response.modelResponse)) },
  }),
  putProvider: define({
    method: "put",
    path: "/v1/providers/{provider}",
    operationId: "putProviderKey",
    request: {
      params: z.object({ provider: z.string() }),
      body: body(providerKeyInput),
    },
    responses: { 200: json(response.providerConfiguredResponse) },
  }),
  deleteProvider: define({
    method: "delete",
    path: "/v1/providers/{provider}",
    operationId: "deleteProviderKey",
    request: { params: z.object({ provider: z.string() }) },
    responses: { 204: empty },
  }),
  mcpServers: define({
    method: "get",
    path: "/v1/mcp-servers",
    operationId: "listMcpServers",
    responses: { 200: json(z.array(response.describedMcpServerResponse)) },
  }),
  oauth: define({
    method: "post",
    path: "/v1/mcp-servers/{id}/oauth",
    operationId: "startMcpOAuth",
    request: { params: id, body: body(oauthInput) },
    responses: { 200: json(response.oauthStartResponse) },
  }),
  oauthCallback: define({
    method: "post",
    path: "/v1/mcp-servers/{id}/oauth/callback",
    operationId: "finishMcpOAuth",
    request: { params: id, body: body(oauthCallbackInput) },
    responses: { 200: json(response.describedMcpServerResponse) },
  }),
  deleteOauth: define({
    method: "delete",
    path: "/v1/mcp-servers/{id}/oauth",
    operationId: "signOutMcpOAuth",
    request: { params: id },
    responses: { 200: json(response.describedMcpServerResponse) },
  }),
  createMcpServer: define({
    method: "post",
    path: "/v1/mcp-servers",
    operationId: "createMcpServer",
    request: { body: body(mcpCreateInput) },
    responses: { 201: json(response.mcpServerResponse) },
  }),
  updateMcpServer: define({
    method: "patch",
    path: "/v1/mcp-servers/{id}",
    operationId: "updateMcpServer",
    request: { params: id, body: body(patchInput(mcpInput)) },
    responses: { 200: json(z.union([response.mcpServerResponse, z.null()])) },
  }),
  deleteMcpServer: define({
    method: "delete",
    path: "/v1/mcp-servers/{id}",
    operationId: "deleteMcpServer",
    request: { params: id },
    responses: { 204: empty },
  }),
};

export function contractApp() {
  const app = new OpenAPIHono();
  app.openAPIRegistry.registerComponent("securitySchemes", "BearerAuth", {
    type: "http",
    scheme: "bearer",
  });
  app.openAPIRegistry.register("ReplyEvent", response.replyEvent);
  app.openAPIRegistry.register("ChatPreviewEvent", response.chatPreviewEvent);
  app.openAPIRegistry.register("HeartbeatEvent", response.heartbeatEvent);
  app.openAPIRegistry.register("ActivityEvent", response.activityEvent);

  return app;
}

export function openAPIDocument() {
  const app = contractApp();

  for (const route of Object.values(routes))
    app.openAPIRegistry.registerPath(route);

  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Crumble API",
      version: "1.0.0",
      description:
        "Shared HTTP contract for Crumble clients. Provider availability and cross-field business rules are validated at runtime.",
    },
  });
}
