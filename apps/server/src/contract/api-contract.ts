import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  agentInput,
  credentialSaveInput,
  groupChatInput,
  passwordManagerIdInput,
  scheduleInput,
  secretReferenceInput,
  skillInput,
  skillLifecycleInput,
} from "../shared/domain";
import { attachmentInput, MAX_ATTACHMENTS } from "../shared/attachments";
import * as response from "./api-responses";
import { body, define, empty, error, json } from "./route";
import { pushRoutes } from "../push/push-contract";

export type BotInput = z.input<typeof agentInput>;

export const memoryInput = z.object({
  content: z.string().trim().min(1).max(32000),
});

export const snapshotInput = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const historyInput = snapshotInput.extend({
  before: z.string().min(1).max(200).optional(),
});

export const desktopControlInput = z.object({
  holder: z.enum(["bot", "owner"]),
});

export const desktopViewerInput = z.object({
  passive: z.stringbool().optional(),
});

const messageFields = z.object({
  content: z.string().trim().max(32000),
  requestId: z.uuid(),
  replyTo: z.string().min(1).max(200).optional(),
  attachments: z.array(attachmentInput).max(MAX_ATTACHMENTS).default([]),
});

const hasContent = <T extends z.infer<typeof messageFields>>(
  schema: z.ZodType<T>,
) =>
  schema.refine((value) => value.content || value.attachments.length, {
    message: "Write a message or attach a file",
    path: ["content"],
  });

export const messageInput = hasContent(
  messageFields.extend({
    timezone: z.string().min(1).max(100).optional(),
  }),
);

/** `replyTo` names a message in the same group; replying to a bot's message also wakes that bot. */
export const groupMessageInput = hasContent(messageFields);

export const credentialUsesInput = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().min(1).max(200).optional(),
});

export const scriptRunsInput = credentialUsesInput.extend({
  limit: credentialUsesInput.shape.limit.default(20),
});

export const changesInput = credentialUsesInput.extend({
  /** One bot's changes; `shared` for the shared library; omit for every change. */
  agentId: z.union([z.uuid(), z.literal("shared")]).optional(),
});

export const reviewsInput = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const activityInput = z.object({
  agentId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  /** Only this kind of item; pass the same kind with every page's cursor. */
  kind: z
    .enum(["tool-call", "tool-result", "mcp-call", "bot-message", "change"])
    .optional(),
  /** The previous page's `nextCursor`. */
  cursor: z.string().min(1).max(8000).optional(),
});

export const apiKeyInput = z.object({
  apiKey: z.string().trim().min(1).max(16000),
});

/** A provider's API key, or where to read it from a password manager. */
export const providerKeyInput = z
  .object({
    /** Write-only. */
    apiKey: apiKeyInput.shape.apiKey.optional(),
    /** Read the key from a password manager instead of storing it. */
    reference: secretReferenceInput.optional(),
  })
  .refine((input) => (input.apiKey === undefined) !== !input.reference, {
    message: "Send an API key or a reference, not both",
    path: ["reference"],
  });

/** Write-only: the token never appears in a response. */
export const passwordManagerTokenInput = z.object({
  token: z.string().trim().min(1).max(16000),
});

const passwordManagerParams = z.object({ id: passwordManagerIdInput });

/** Login answers may be pasted callback URLs, never larger than this. */
const MAX_LOGIN_VALUE = 16384;

export const providerLoginInput = z.object({
  method: z.enum(["api_key", "oauth"]),
});

export const providerLoginAnswerInput = z.object({
  promptId: z.string().min(1).max(200),
  value: z.string().refine(
    // oxlint-disable-next-line typescript/no-misused-spread -- the limit counts code points, as spreading does
    (value) => [...value].length <= MAX_LOGIN_VALUE,
    `Use at most ${MAX_LOGIN_VALUE} characters`,
  ),
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
  /** Write-only; an empty string removes it. Exclusive with `tokenReference`. */
  token: z.string().max(16000).optional(),
  /** Read the token from a password manager instead of storing it; null removes it. */
  tokenReference: secretReferenceInput.nullable().optional(),
  /** The client ID of an OAuth app the owner registered with the server's authorization server; null removes it. */
  oauthClientId: z.string().trim().min(1).max(500).nullable().optional(),
  /** Write-only; an empty string removes it. */
  oauthClientSecret: z.string().max(1000).optional(),
});

export const mcpCreateInput = mcpInput.extend({
  agentId: z.uuid().nullable().default(null),
});

export const attachmentIndex = z.coerce
  .number()
  .int()
  .min(0)
  .max(MAX_ATTACHMENTS - 1);

const id = z.object({ id: z.string() });
const memoryParams = id.extend({ memoryId: z.string() });

const credentialParams = id.extend({ name: z.string() });
const skillParams = id.extend({ skillId: z.string() });

export function patchInput(schema: z.ZodObject) {
  const fields: Record<string, z.ZodType> = {};

  for (const [key, field] of Object.entries(schema.shape))
    fields[key] = (
      field instanceof z.ZodDefault ? field.unwrap() : field
    ).optional();

  return z.object(fields);
}

const gone = json(error, "Login session ended or was lost on restart");

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
  ...pushRoutes,
  getWebSearch: define({
    method: "get",
    path: "/v1/web-search",
    operationId: "getWebSearch",
    responses: {
      200: json(
        z.object({
          defaultProvider: z.enum(["mixed", "exa"]),
          exaKeyConfigured: z.boolean(),
        }),
      ),
    },
  }),
  updateWebSearch: define({
    method: "put",
    path: "/v1/web-search",
    operationId: "updateWebSearch",
    request: {
      body: body(z.object({ defaultProvider: z.enum(["mixed", "exa"]) })),
    },
    responses: {
      200: json(
        z.object({
          defaultProvider: z.enum(["mixed", "exa"]),
          exaKeyConfigured: z.boolean(),
        }),
      ),
    },
  }),
  setExaKey: define({
    method: "put",
    path: "/v1/web-search/exa-key",
    operationId: "setExaKey",
    request: { body: body(apiKeyInput) },
    responses: { 200: json(z.object({ exaKeyConfigured: z.boolean() })) },
  }),
  deleteExaKey: define({
    method: "delete",
    path: "/v1/web-search/exa-key",
    operationId: "deleteExaKey",
    responses: { 200: json(z.object({ exaKeyConfigured: z.boolean() })) },
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
  desktopJobs: define({
    method: "get",
    path: "/v1/agents/{id}/desktop-jobs",
    operationId: "listDesktopJobs",
    request: { params: id },
    responses: { 200: json(response.desktopJobsResponse) },
  }),
  desktopControl: define({
    method: "get",
    path: "/v1/agents/{id}/desktop/control",
    operationId: "getDesktopControl",
    request: { params: id },
    responses: { 200: json(response.desktopControlResponse) },
  }),
  putDesktopControl: define({
    method: "put",
    path: "/v1/agents/{id}/desktop/control",
    operationId: "putDesktopControl",
    description:
      "Take control of the bot desktop (holder owner) or hand it back (holder bot). 409 when the bot has no bot desktop.",
    request: { params: id, body: body(desktopControlInput) },
    responses: { 200: json(response.desktopControlResponse) },
  }),
  desktopEvents: define({
    method: "get",
    path: "/v1/agents/{id}/desktop/events",
    operationId: "streamDesktopEvents",
    "x-sse-events": {
      control: { $ref: "#/components/schemas/DesktopControl" },
      heartbeat: { $ref: "#/components/schemas/HeartbeatEvent" },
    },
    description:
      "Server-sent events. A control event carries the DesktopControl JSON object in data, once on connect and on every change. Heartbeat events carry {} every 15 seconds. Authenticate with the Authorization header.",
    request: { params: id },
    responses: {
      200: {
        description: "SSE stream, not a JSON array",
        content: { "text/event-stream": { schema: z.string() } },
      },
    },
  }),
  desktopStatus: define({
    method: "get",
    path: "/v1/agents/{id}/desktop/status",
    operationId: "getDesktopStatus",
    request: { params: id },
    responses: { 200: json(response.desktopStatusResponse) },
  }),
  createDesktopViewer: define({
    method: "post",
    path: "/v1/agents/{id}/desktop/viewer",
    operationId: "createDesktopViewer",
    description:
      "Issue a single-use viewer link for the bot desktop. The page and its WebSocket live outside /v1 and need no Authorization header: the link is the credential. With passive=true the link is watch-only: it neither boots the bot's machine nor keeps it awake, and its connection ends when the machine stops. 409 when the bot has no bot desktop.",
    request: { params: id, query: desktopViewerInput },
    responses: { 201: json(response.desktopViewerResponse) },
  }),
  desktopJobHistory: define({
    method: "get",
    path: "/v1/agents/{id}/desktop-jobs/{name}/history",
    operationId: "getDesktopJobHistory",
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
      learned: { $ref: "#/components/schemas/LearnedEvent" },
      heartbeat: { $ref: "#/components/schemas/HeartbeatEvent" },
    },
    description:
      "Server-sent events. Each activity event carries a ReplyEvent or ChatPreviewEvent JSON object in data. Each learned event carries a LearnedEvent: what a bot's review of one turn changed; GET /v1/agents/{id}/reviews lists them durably. Current chat previews replay on connection; finished replies and learned events are not replayed. Heartbeat events carry {} every 15 seconds. Authenticate with the Authorization header. No Last-Event-ID replay.",
    responses: {
      200: {
        description: "SSE stream, not a JSON array",
        content: { "text/event-stream": { schema: z.string() } },
      },
    },
  }),
  listGroupChats: define({
    method: "get",
    path: "/v1/group-chats",
    operationId: "listGroupChats",
    responses: { 200: json(z.array(response.groupChatResponse)) },
  }),
  createGroupChat: define({
    method: "post",
    path: "/v1/group-chats",
    operationId: "createGroupChat",
    request: { body: body(groupChatInput) },
    responses: { 201: json(response.groupChatResponse) },
  }),
  getGroupChat: define({
    method: "get",
    path: "/v1/group-chats/{id}",
    operationId: "getGroupChat",
    request: { params: id },
    responses: { 200: json(response.groupChatResponse) },
  }),
  updateGroupChat: define({
    method: "patch",
    path: "/v1/group-chats/{id}",
    operationId: "updateGroupChat",
    request: { params: id, body: body(patchInput(groupChatInput)) },
    responses: { 200: json(response.groupChatResponse) },
  }),
  deleteGroupChat: define({
    method: "delete",
    path: "/v1/group-chats/{id}",
    operationId: "deleteGroupChat",
    request: { params: id },
    responses: { 204: empty },
  }),
  groupChatSnapshot: define({
    method: "get",
    path: "/v1/group-chats/{id}/chat",
    operationId: "getGroupChatSnapshot",
    request: { params: id, query: snapshotInput },
    responses: { 200: json(response.groupChatSnapshotResponse) },
  }),
  groupChatHistory: define({
    method: "get",
    path: "/v1/group-chats/{id}/history",
    operationId: "getGroupChatHistory",
    request: { params: id, query: historyInput },
    responses: { 200: json(response.historyResponse) },
  }),
  sendGroupMessage: define({
    method: "post",
    path: "/v1/group-chats/{id}/messages",
    operationId: "sendGroupMessage",
    request: { params: id, body: body(groupMessageInput) },
    responses: { 201: json(response.groupMessageReceiptResponse) },
  }),
  groupAttachment: define({
    method: "get",
    path: "/v1/group-chats/{id}/attachments/{entryId}/{index}",
    operationId: "getGroupAttachment",
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
          "Attachment bytes; Content-Type identifies the image or text format",
        content: {
          "*/*": { schema: z.string().openapi({ format: "binary" }) },
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
  stopGroupChat: define({
    method: "post",
    path: "/v1/group-chats/{id}/stop",
    operationId: "stopGroupChat",
    description:
      "Ends every running bot turn in the group and drops the queued ones. The group is not paused; the next message starts turns again.",
    request: { params: id },
    responses: { 204: empty },
  }),
  groupChatEvents: define({
    method: "get",
    path: "/v1/group-chats/{id}/events",
    operationId: "streamGroupChatEvents",
    "x-sse-events": {
      snapshot: { $ref: "#/components/schemas/GroupChatSnapshot" },
      heartbeat: { $ref: "#/components/schemas/HeartbeatEvent" },
    },
    description:
      "Server-sent events. Each snapshot event carries a GroupChatSnapshot JSON object in data, sent on connection and after every change. Heartbeat events carry {} every 15 seconds. Authenticate with the Authorization header. Reconnect by fetching the current snapshot; there is no Last-Event-ID replay.",
    request: { params: id, query: snapshotInput },
    responses: {
      200: {
        description: "SSE stream, not a JSON array",
        content: { "text/event-stream": { schema: z.string() } },
      },
    },
  }),
  agentCredentials: define({
    method: "get",
    path: "/v1/agents/{id}/credentials",
    operationId: "listAgentCredentials",
    description:
      "The bot's credentials and its requests for credentials the owner has not answered. Values are never returned.",
    request: { params: id },
    responses: { 200: json(response.credentialsResponse) },
  }),
  listBotRequests: define({
    method: "get",
    path: "/v1/agents/{id}/bot-requests",
    operationId: "listBotRequests",
    description:
      "Lists bot requests, newest first, including their current approval status.",
    request: { params: id },
    responses: { 200: json(z.array(response.botRequestResponse)) },
  }),
  approveBotRequest: define({
    method: "post",
    path: "/v1/agents/{id}/bot-requests/{requestId}/approve",
    operationId: "approveBotRequest",
    description:
      "Approves a pending bot request, optionally saving an edited proposal and creating the new bot.",
    request: {
      params: id.extend({ requestId: z.string() }),
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({ proposal: agentInput.optional() }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({
          request: response.botRequestResponse,
          agent: response.agentResponse,
        }),
      ),
    },
  }),
  declineBotRequest: define({
    method: "post",
    path: "/v1/agents/{id}/bot-requests/{requestId}/decline",
    operationId: "declineBotRequest",
    description: "Declines a pending bot request.",
    request: { params: id.extend({ requestId: z.string() }) },
    responses: { 200: json(response.botRequestResponse) },
  }),
  saveAgentCredential: define({
    method: "put",
    path: "/v1/agents/{id}/credentials/{name}",
    operationId: "saveAgentCredential",
    description:
      "Creates or updates a credential. Saving one the bot requested answers the request and starts a bot turn with a notice. A new value applies from the next request; the placeholder stays the same.",
    request: { params: credentialParams, body: body(credentialSaveInput) },
    responses: { 200: json(response.credentialResponse) },
  }),
  deleteAgentCredential: define({
    method: "delete",
    path: "/v1/agents/{id}/credentials/{name}",
    operationId: "deleteAgentCredential",
    description:
      "Deletes a credential and its use records, or declines a request for one, which starts a bot turn with a notice.",
    request: { params: credentialParams },
    responses: { 204: empty },
  }),
  declineAgentCredential: define({
    method: "post",
    path: "/v1/agents/{id}/credentials/{name}/decline",
    operationId: "declineAgentCredential",
    description:
      "Declines a pending credential request without changing a saved credential.",
    request: { params: credentialParams },
    responses: { 204: empty },
  }),
  agentCredentialUses: define({
    method: "get",
    path: "/v1/agents/{id}/credentials/{name}/uses",
    operationId: "listAgentCredentialUses",
    description:
      "Requests sent with the credential's value in the last 90 days, newest first. Page with `before` set to the last use's ID.",
    request: { params: credentialParams, query: credentialUsesInput },
    responses: { 200: json(z.array(response.credentialUseResponse)) },
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
  agentSkills: define({
    method: "get",
    path: "/v1/agents/{id}/skills",
    operationId: "listAgentSkills",
    description:
      "The bot's own skill packages, including stale and archived ones. The agent's inline `skills` field lists the same skills by name and instructions.",
    request: { params: id },
    responses: { 200: json(z.array(response.skillPackageResponse)) },
  }),
  createAgentSkill: define({
    method: "post",
    path: "/v1/agents/{id}/skills",
    operationId: "createAgentSkill",
    request: { params: id, body: body(skillInput) },
    responses: { 201: json(response.skillPackageResponse) },
  }),
  updateAgentSkill: define({
    method: "patch",
    path: "/v1/agents/{id}/skills/{skillId}",
    operationId: "updateAgentSkill",
    description:
      "Changes a skill's content, restores an archived skill by setting state to active, or pins it so the curator never marks it stale or archives it.",
    request: {
      params: skillParams,
      body: body(patchInput(skillInput).extend(skillLifecycleInput.shape)),
    },
    responses: {
      200: json(z.union([response.skillPackageResponse, z.null()])),
    },
  }),
  deleteAgentSkill: define({
    method: "delete",
    path: "/v1/agents/{id}/skills/{skillId}",
    operationId: "deleteAgentSkill",
    request: { params: skillParams },
    responses: { 204: empty },
  }),
  agentReviews: define({
    method: "get",
    path: "/v1/agents/{id}/reviews",
    operationId: "listAgentReviews",
    description:
      "What the bot's reviews changed, newest first, one entry per reviewed execution with its changes. Clients show these as notices in the bot chat, also after reconnecting.",
    request: { params: id, query: reviewsInput },
    responses: { 200: json(z.array(response.reviewResultResponse)) },
  }),
  changes: define({
    method: "get",
    path: "/v1/changes",
    operationId: "listChanges",
    description:
      "Skill and memory changes by owners, bots, and reviews, newest first, with the state before and after each. Page with `before` set to the last change's ID.",
    request: { query: changesInput },
    responses: { 200: json(z.array(response.learnedChangeResponse)) },
  }),
  revertChange: define({
    method: "post",
    path: "/v1/changes/{id}/revert",
    operationId: "revertChange",
    description:
      "Restores the state before the change, whatever happened since, and records the revert as a change of its own.",
    request: { params: id },
    responses: { 201: json(response.learnedChangeResponse) },
  }),
  skills: define({
    method: "get",
    path: "/v1/skills",
    operationId: "listSkills",
    responses: { 200: json(z.array(response.listedSkillResponse)) },
  }),
  getSkill: define({
    method: "get",
    path: "/v1/skills/{id}",
    operationId: "getSkill",
    description:
      "One shared skill as a full package. GET /v1/skills keeps its earlier item shapes; the full records are here and in the create and update responses.",
    request: { params: id },
    responses: { 200: json(response.skillPackageResponse) },
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
    responses: {
      200: json(z.union([response.skillResponse, z.null()])),
    },
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
    responses: {
      201: json(response.scheduleResponse),
      403: json(
        error,
        "Script tasks need coding jobs and must stay with their creator",
      ),
    },
  }),
  updateSchedule: define({
    method: "patch",
    path: "/v1/schedules/{id}",
    operationId: "updateSchedule",
    request: {
      params: id,
      body: body(patchInput(z.object(scheduleInput.shape))),
    },
    responses: {
      200: json(z.union([response.scheduleResponse, z.null()])),
      403: json(
        error,
        "Script tasks need coding jobs and must stay with their creator",
      ),
    },
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
  listScriptRuns: define({
    method: "get",
    path: "/v1/schedules/{id}/runs",
    operationId: "listScriptRuns",
    description:
      "Script task runs from the last 90 days, newest first. Page with `before` set to the last run's ID. An unknown ID returns an empty list.",
    request: { params: id, query: scriptRunsInput },
    responses: { 200: json(z.array(response.scriptRunResponse)) },
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
    description:
      "Bots' tool calls, tool results, MCP calls, and bot messages, and skill and memory changes, newest first. Page with `cursor` set to the previous page's `nextCursor`. A page may hold fewer than `limit` items while `hasMore` is true.",
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
    description:
      "Saves the provider's API key, or a password manager reference to read it from. A reference is read once to check it; 400 when it can't be read, keeping the previous credential.",
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
    description:
      "Remove the provider's saved credential. 409 for a provider that signs in outside Crumble; the message names its sign-out command.",
    request: { params: z.object({ provider: z.string() }) },
    responses: { 204: empty },
  }),
  startProviderLogin: define({
    method: "post",
    path: "/v1/providers/{provider}/login",
    operationId: "startProviderLogin",
    request: {
      params: z.object({ provider: z.string() }),
      body: body(providerLoginInput),
    },
    responses: { 202: json(response.loginSessionResponse) },
  }),
  getProviderLogin: define({
    method: "get",
    path: "/v1/provider-logins/{id}",
    operationId: "getProviderLogin",
    request: { params: id },
    responses: { 200: json(response.loginSessionResponse), 410: gone },
  }),
  answerProviderLogin: define({
    method: "post",
    path: "/v1/provider-logins/{id}/responses",
    operationId: "answerProviderLogin",
    request: { params: id, body: body(providerLoginAnswerInput) },
    responses: { 200: json(response.loginSessionResponse), 410: gone },
  }),
  cancelProviderLogin: define({
    method: "delete",
    path: "/v1/provider-logins/{id}",
    operationId: "cancelProviderLogin",
    request: { params: id },
    responses: { 200: json(response.loginSessionResponse), 410: gone },
  }),
  passwordManagers: define({
    method: "get",
    path: "/v1/password-managers",
    operationId: "listPasswordManagers",
    description:
      "Every password manager this server supports, whether it is connected, and which secrets read from it.",
    responses: { 200: json(response.passwordManagersResponse) },
  }),
  connectPasswordManager: define({
    method: "put",
    path: "/v1/password-managers/{id}",
    operationId: "connectPasswordManager",
    description:
      "Signs in with the token to check it, then connects the password manager or replaces its token. A new token drops the values read with the old one. 400 when the password manager rejects the token; 503 when it can't be reached.",
    request: {
      params: passwordManagerParams,
      body: body(passwordManagerTokenInput),
    },
    responses: { 200: json(response.passwordManagerResponse) },
  }),
  disconnectPasswordManager: define({
    method: "delete",
    path: "/v1/password-managers/{id}",
    operationId: "disconnectPasswordManager",
    description:
      "Disconnects the password manager and drops its token. 409 while any secret still reads from it; `usedBy` in the list names them.",
    request: { params: passwordManagerParams },
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
    description:
      "Better Auth session token from /api/auth/sign-in/email. The legacy server token is not accepted.",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "SessionCookie", {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
    description:
      "Better Auth session cookie. HTTPS deployments use the __Secure- prefix. Cookie-authenticated writes require the configured Origin.",
  });
  app.openAPIRegistry.register("ReplyEvent", response.replyEvent);
  app.openAPIRegistry.register("ChatPreviewEvent", response.chatPreviewEvent);
  app.openAPIRegistry.register("HeartbeatEvent", response.heartbeatEvent);
  app.openAPIRegistry.register("ActivityEvent", response.activityEvent);
  app.openAPIRegistry.register("LearnedEvent", response.learnedEvent);

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
      version: "3.4.0",
      description:
        "Shared HTTP contract for Crumble clients. Provider availability and cross-field business rules are validated at runtime.",
    },
  });
}
