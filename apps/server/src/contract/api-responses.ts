import { z } from "@hono/zod-openapi";
import {
  PASSWORD_MANAGER_IDS,
  WEB_SEARCH_PROVIDER_IDS,
} from "../shared/vendors";
import { ATTACHMENT_KINDS } from "../shared/attachment-rules";
import {
  ACTIVITY_KINDS,
  CHANGE_ACTIONS,
  CHANGE_ACTORS,
  CHANGE_TARGETS,
  CONTROL_HOLDERS,
  EXECUTION_STATUSES,
  HELD_ACTION_STATUSES,
  MEMORY_SOURCE_KINDS,
  OWNER_MESSAGE_SOURCES,
  SCRIPT_RUN_STATUSES,
  SIGN_IN_METHODS,
} from "../shared/domain";
import { agentInput, THINKING_LEVELS } from "./agents";
import { loginFieldInput } from "./secrets";
import { SCHEDULE_KINDS } from "./schedules";
import { SKILL_STATES } from "./skills";
import { avatarDefinitionSchema } from "./avatar";
import { replyEvent } from "./reply-event";
import {
  voiceCallCancelEvent,
  voiceCallEvent,
  voiceGatewayConfigEvent,
  voiceGatewayReplacedEvent,
} from "./voice-gateway";

export const secretStatusResponse = z
  .object({
    configured: z.boolean(),
    passwordManager: z.enum(PASSWORD_MANAGER_IDS).nullable().openapi({
      description:
        "The password manager the value is read from; null for a value stored in Crumble or no value.",
    }),
    reference: z.string().nullable().openapi({
      description: "Where in `passwordManager` the value is read from.",
    }),
  })
  .openapi("SecretStatus", {
    description: "A secret the owner entered; its value is never returned.",
  });

const strings = z.array(z.string());

const thinkingLevel = z.enum(THINKING_LEVELS);

const inference = z.object({
  thinkingLevel: thinkingLevel.optional(),
  temperature: z.number().optional(),
  maxOutputTokens: z.number().optional(),
});

export const healthResponse = z
  .object({ status: z.literal("ok"), apiVersion: z.literal(1) })
  .openapi("Health");

export const capabilitiesResponse = z
  .object({
    coding: z.boolean().openapi({
      description: "Whether bots can be given the coding tool on this server.",
    }),
    desktop: z.boolean().openapi({
      description:
        "Whether bots can be given the desktop tool, and with it a bot desktop, on this server.",
    }),
    jobKinds: z.array(z.string()).openapi({
      description:
        "The kinds of background job bots can be given on this server, such as `coding` and `desktop`.",
    }),
  })
  .openapi("Capabilities");

export const agentResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    avatar: avatarDefinitionSchema.openapi({
      description:
        "Open Bot Avatar v1 geometry in a 0 0 100 100 viewBox, body color and eye color.",
    }),
    description: z.string(),
    instructions: z.string(),
    provider: z.string(),
    model: z.string(),
    webSearchProvider: z.enum(WEB_SEARCH_PROVIDER_IDS).nullable().optional(),
    enabled: z.boolean(),
    tools: strings.openapi({
      description:
        "The bot's tools; always includes `schedule` and `codemode`.",
    }),
    skills: z.array(z.object({ name: z.string(), instructions: z.string() })),
    sharedSkills: strings.optional(),
    sharedMemory: z.boolean().optional().openapi({
      description:
        "True whenever `tools` includes `memory`; the server ignores it in input.",
    }),
    mcpServers: strings,
    delegates: strings.openapi({
      description:
        "Every other bot; with `delegate` in `tools` this bot may message any of them. The server ignores it in input.",
    }),
    inference: inference.optional(),
    desktopModel: z
      .object({ provider: z.string(), model: z.string() })
      .optional()
      .openapi({
        description:
          "The model for this bot's desktop jobs; unset, they use the bot's own model.",
      }),
    review: z
      .object({
        enabled: z.boolean(),
        skillThreshold: z.number().int(),
        memoryThreshold: z.number().int(),
        maxInputTokens: z.number().int().optional(),
      })
      .optional()
      .openapi({
        description:
          "How the bot reviews its turns to learn: whether at all, after how many tool-activity rounds for skills and memory, and how much of a turn a review reads. Unset means enabled with thresholds of 10.",
      }),
    reviewModel: z
      .object({ provider: z.string(), model: z.string() })
      .optional()
      .openapi({
        description:
          "The model that runs this bot's reviews; unset, they use the bot's own model.",
      }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Agent");

export const agentPreviewResponse = agentResponse
  .extend({ lastMessage: z.string().optional() })
  .openapi("AgentPreview");

const conversation = z
  .object({
    id: z.string(),
    agentId: z.string(),
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    archived: z.boolean().optional(),
  })
  .openapi("Conversation");

const origin = z
  .object({
    kind: z.string().openapi({
      description:
        "Where the message came from: owner, task, event (an event automation's prompt), script (a script task's result), credential, bot, group, or call (a voice gateway call ended, which starts a bot turn). Clients may receive other values later.",
    }),
    name: z.string().optional(),
    agentId: z.string().optional(),
    via: z.string().optional().openapi({
      description:
        "On an owner message sent through a message gateway: the gateway's ID, such as `discord`. On a spoken message from a voice gateway call: `voice`.",
    }),
    source: z.string().optional().openapi({
      description:
        "On an event automation's message: the name of the event source whose event started it.",
    }),
  })
  .openapi("MessageOrigin");

export const botCommunication = z
  .object({
    executionId: z.string(),
    fromAgentId: z.string(),
    fromName: z.string(),
    toAgentId: z.string(),
    toName: z.string(),
    status: z.enum(["sent", "done", "failed", "cancelled"]),
  })
  .openapi("BotCommunication");

export type BotCommunication = z.infer<typeof botCommunication>;

const attachment = z
  .object({
    name: z.string(),
    mimeType: z.string(),
    size: z.number(),
    kind: z.enum(ATTACHMENT_KINDS),
  })
  .openapi("AttachmentInfo");

const message = z
  .object({
    id: z.string(),
    entryId: z.string(),
    requestId: z.string().optional(),
    role: z.string(),
    content: z.string(),
    blocks: z.unknown().optional().openapi({
      description: "Provider content blocks, with inline image bytes removed.",
    }),
    stopReason: z.string().optional(),
    timestamp: z.number().optional(),
    kind: z.string().optional().openapi({
      description:
        "The entry's kind. Events include bot-message, job-question, held-action, job-failure, reset, compaction, call-started (content: the greeting of a call the bot placed, or Call started), and call-ended (content: how the call ended, when it woke no bot turn). Clients may receive other values later.",
    }),
    replyTo: z.string().optional(),
    replyPreview: z.string().optional(),
    origin: origin.optional(),
    communication: botCommunication.optional(),
    jobQuestion: z
      .object({
        id: z.string(),
        kind: z.string(),
        job: z.string(),
        options: z.array(z.string()).optional(),
        multiple: z.boolean().optional(),
      })
      .optional()
      .openapi({
        description:
          "On a `job-question` event: the job that asked the owner the question in `content`. Whether it still waits is the job's `question` in its listing.",
      }),
    heldAction: z
      .object({ id: z.string(), job: z.string() })
      .optional()
      .openapi({
        description:
          "On a `held-action` event: the desktop job action waiting for the owner. Its state is under `/v1/agents/{id}/held-actions`.",
      }),
    call: z
      .object({
        callId: z.string(),
        direction: z.enum(["inbound", "outbound"]).openapi({
          description: "outbound: the bot called the owner.",
        }),
      })
      .optional()
      .openapi({
        description: "On a `call-started` or `call-ended` event: the call.",
      }),
    attachments: z.array(attachment).optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    isError: z.boolean().optional(),
    toolDetails: z.unknown().optional().openapi({
      description:
        "Provider-specific tool details, including nested code-mode calls. A successful `desktop_screenshot` result has `{ mimeType, size }`; read its image from `GET /v1/agents/{id}/attachments/{entryId}/0`.",
    }),
    sources: z
      .array(z.object({ url: z.string(), title: z.string() }))
      .optional()
      .openapi({
        description:
          "In a group chat, the pages the sending bot searched or read in the turn that wrote the message.",
      }),
  })
  .openapi("TranscriptMessage");

export const historyResponse = z
  .object({
    messages: z.array(message),
    hasMore: z.boolean(),
    oldestEntryId: z.string().nullable(),
  })
  .openapi("TranscriptPage");

const jobsResponse = (kind: "Coding" | "Desktop") =>
  z
    .object({
      jobs: z
        .array(
          z
            .object({
              name: z.string(),
              conversationId: z.string(),
              status: z.enum(["working", "idle"]),
              model: z
                .object({ provider: z.string(), model: z.string() })
                .optional()
                .openapi({
                  description:
                    "The model the job runs with. Absent when the job has none of its own and uses the server's default.",
                }),
              usage: z.unknown().optional().openapi({
                description:
                  "Pi Durable usage document of the job's own conversation: tokens and cost per model and tool. Absent before its first request.",
              }),
              question: z
                .object({
                  id: z.string(),
                  text: z.string(),
                  askedAt: z.number(),
                  options: z.array(z.string()).optional().openapi({
                    description:
                      "Answers the owner can pick; any other text is an answer too.",
                  }),
                  multiple: z.boolean().optional().openapi({
                    description:
                      "Whether several options can be picked; the answer lists each.",
                  }),
                })
                .optional()
                .openapi({
                  description:
                    "The question the job asked the owner and waits on. Answer it with the job's `answer` route.",
                }),
            })
            .openapi(`${kind}Job`),
        )
        .openapi({ description: "Oldest job first." }),
    })
    .openapi(`${kind}Jobs`);

export const codingJobsResponse = jobsResponse("Coding");

export const desktopJobsResponse = jobsResponse("Desktop");

export const desktopControlResponse = z
  .object({
    holder: z.enum(CONTROL_HOLDERS).openapi({
      description:
        "Who operates the bot desktop. While the owner holds control, the bot's desktop job pauses and only the owner's viewer input reaches the bot desktop.",
    }),
    changes: z.number().int().openapi({
      description:
        "How often control changed hands. A desktop job refuses actions it planned before a change.",
    }),
    updatedAt: z.string(),
  })
  .openapi("DesktopControl");

export const desktopStatusResponse = z
  .object({
    running: z.boolean().openapi({
      description:
        "Whether the bot's machine runs its bot desktop now, so a passive viewer can connect. Always false for a bot without a bot desktop.",
    }),
  })
  .openapi("DesktopStatus");

export const desktopViewerResponse = z
  .object({
    path: z.string().openapi({
      description:
        "Server-relative URL of the viewer page, a noVNC client of the bot desktop. Load it in a web view; it works once and expires at expiresAt unless its connection has started by then.",
    }),
    expiresAt: z.string(),
  })
  .openapi("DesktopViewer");

export const chatSnapshotResponse = historyResponse
  .extend({
    conversationId: z.string(),
    agentId: z.string(),
    conversation,
    live: z.unknown().optional().openapi({
      description:
        "Pi Durable live progress state. In-flight assistant message content is omitted.",
    }),
    partial: z.string().openapi({
      description:
        "Text of the reply the bot is writing now. Empty unless the event stream was opened with partial=true.",
    }),
    usage: z
      .unknown()
      .optional()
      .openapi({ description: "Pi Durable usage document." }),
    status: z.enum(["idle", "running", "failed"]),
    updatedAt: z.number(),
    error: z.string().nullable(),
  })
  .openapi("ChatSnapshot");

export const groupChatResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    memberIds: strings.openapi({
      description: "Member bots in the order they joined.",
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("GroupChat");

export const groupActivityResponse = z
  .object({
    paused: z.boolean().openapi({
      description:
        "Bot-started turns used up the turn budget; the owner's next message resumes the group.",
    }),
    botTurns: z.number().openapi({
      description: "Bot-started turns since the owner's last message.",
    }),
    members: z.array(
      z
        .object({
          agentId: z.string(),
          status: z.enum(["idle", "queued", "running", "disabled"]),
          error: z.string().nullable().openapi({
            description: "Why the member's latest turn failed.",
          }),
        })
        .openapi("GroupMemberActivity"),
    ),
  })
  .openapi("GroupActivity");

export const groupChatSnapshotResponse = historyResponse
  .extend({
    groupChat: groupChatResponse,
    activity: groupActivityResponse,
    updatedAt: z.number(),
  })
  .openapi("GroupChatSnapshot");

export const groupMessageReceiptResponse = z
  .object({ requestId: z.string(), entryId: z.string() })
  .openapi("GroupMessageReceipt");

export const executionResponse = z
  .object({
    id: z.string(),
    agentId: z.string(),
    conversationId: z.string(),
    scheduleId: z.string().nullable(),
    submissionId: z.string().nullable(),
    requestId: z.string(),
    prompt: z.string(),
    replyTo: z.string().nullable().optional(),
    attachmentsDigest: z.string().nullable().optional(),
    status: z.enum(EXECUTION_STATUSES),
    error: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Execution");

export const scriptRunResponse = z
  .object({
    id: z.string(),
    scheduleId: z.string(),
    agentId: z.string(),
    command: z.string(),
    status: z.enum(SCRIPT_RUN_STATUSES),
    exitCode: z.number().int().nullable(),
    output: z.string().openapi({
      description: "The last 64 KiB and 2000 lines of combined output.",
    }),
    droppedBytes: z
      .number()
      .int()
      .openapi({ description: "Bytes dropped from the output tail." }),
    error: z.string().nullable(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi("ScriptRun");

export const scheduleRunResponse = z
  .object({
    admitted: z.boolean(),
    result: z
      .object({
        ...executionResponse.partial().shape,
        status: z.string().optional(),
      })
      .loose()
      .openapi("ScheduleRunResult")
      .optional(),
  })
  .openapi("ScheduleRun");

// One object with optional fields rather than a union, so client generators keep it.
const memorySourceResponse = z
  .object({
    kind: z.enum(MEMORY_SOURCE_KINDS),
    name: z.string().optional().openapi({
      description:
        "The task, bot, or group chat, as named when the memory was saved.",
    }),
    scheduleId: z.string().optional().openapi({ description: "For `task`." }),
    agentId: z.string().optional().openapi({ description: "For `bot`." }),
    groupId: z.string().optional().openapi({ description: "For `group`." }),
  })
  .openapi("MemorySource", {
    description:
      "Where the memory was saved: the owner's bot chat, the owner directly, a scheduled task, another bot's request, or a group chat.",
  });

export const credentialResponse = z
  .object({
    name: z.string(),
    hosts: z.array(z.string()),
    secret: secretStatusResponse.nullable().openapi({
      description: "Null when `github` is true.",
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastUsedAt: z.string().nullable(),
    lastError: z.string().nullable().openapi({
      description:
        "Why the newest use couldn't read the value from its password manager; null when it could.",
    }),
    github: z.boolean().openapi({
      description:
        "The value is a GitHub token: from the bot's GitHub App, minted for the App or for the owner signed in through it, or its machine account's personal access token. It has no secret here.",
    }),
  })
  .openapi("Credential");

export const credentialRequestResponse = z
  .object({
    name: z.string(),
    hosts: z.array(z.string()),
    reason: z.string(),
    requestedAt: z.string(),
  })
  .openapi("CredentialRequest");

export const credentialsResponse = z
  .object({
    credentials: z.array(credentialResponse),
    requests: z.array(credentialRequestResponse),
  })
  .openapi("Credentials");

export const credentialUseResponse = z
  .object({
    id: z.string(),
    at: z.string(),
    method: z.string(),
    host: z.string(),
    path: z.string(),
    status: z.number().int().nullable(),
    error: z
      .string()
      .nullable()
      .describe(
        "Why the value couldn't be read from its password manager; the request was never sent.",
      ),
  })
  .openapi("CredentialUse");

export const loginResponse = z
  .object({
    name: z.string(),
    hosts: z.array(z.string()),
    fields: z
      .object({
        username: secretStatusResponse.optional(),
        password: secretStatusResponse.optional(),
        one_time_code: secretStatusResponse.optional(),
      })
      .openapi({
        description:
          "Where each field's value is read from. A login always has a username and a password; `one_time_code` only when it has one.",
      }),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastUsedAt: z.string().nullable(),
    lastError: z.string().nullable().openapi({
      description:
        "Why the newest fill couldn't read its value; null when it could.",
    }),
  })
  .openapi("Login");

export const loginRequestResponse = z
  .object({
    name: z.string(),
    hosts: z.array(z.string()),
    reason: z.string(),
    oneTimeCode: z.boolean().openapi({
      description: "Whether the bot says the site asks for a one-time code.",
    }),
    requestedAt: z.string(),
  })
  .openapi("LoginRequest");

export const heldActionResponse = z
  .object({
    id: z.string(),
    job: z.string().openapi({ description: "The desktop job's name." }),
    action: z.string().openapi({ description: "The action in plain words." }),
    page: z.string().nullable().openapi({
      description: "The URL of the page the job read last.",
    }),
    ownerMessages: z
      .array(
        z.object({
          requestId: z.string(),
          text: z.string(),
          from: z.enum(OWNER_MESSAGE_SOURCES),
        }),
      )
      .openapi({
        description: "The owner messages the action was checked against.",
      }),
    reason: z
      .string()
      .openapi({ description: "Why the intent check held it." }),
    status: z.enum(HELD_ACTION_STATUSES),
    declineReason: z.string().nullable(),
    heldAt: z.string(),
    decidedAt: z.string().nullable(),
  })
  .openapi("HeldAction");

const judgeChoice = z
  .object({
    provider: z.string(),
    model: z.string(),
    name: z.string(),
    kind: z.enum(["classifier", "chat"]),
  })
  .openapi("JudgeChoice");

export const judgeModelResponse = z
  .object({
    judgeModel: z
      .object({ provider: z.string(), model: z.string() })
      .nullable()
      .openapi({
        description:
          "The owner's classifier; null uses the default, GPT-6 Luna through OpenAI Decisions.",
      }),
    effective: judgeChoice.nullable().openapi({
      description:
        "The model that judges now: a classifier, or a small chat model when no key reaches one. Null when no model is available; then only commit points are held.",
    }),
    choices: z.array(judgeChoice).openapi({
      description: "The classifier models the account's provider keys reach.",
    }),
  })
  .openapi("JudgeModel");

const visionChoice = z
  .object({ provider: z.string(), model: z.string(), name: z.string() })
  .openapi("VisionChoice");

export const visionModelResponse = z
  .object({
    visionModel: z
      .object({ provider: z.string(), model: z.string() })
      .nullable()
      .openapi({
        description:
          "The model that describes images for bots whose model can't read them. Null when off: such bots refuse images in their chat and get only an image's name in group chats.",
      }),
    choices: z.array(visionChoice).openapi({
      description:
        "The chat models that read images and that the account's provider keys reach.",
    }),
  })
  .openapi("VisionModel");

export const loginsResponse = z
  .object({
    logins: z.array(loginResponse),
    requests: z.array(loginRequestResponse),
  })
  .openapi("Logins");

export const loginUseResponse = z
  .object({
    id: z.string(),
    at: z.string(),
    host: z.string(),
    field: loginFieldInput,
    error: z
      .string()
      .nullable()
      .describe("Why the value couldn't be read; nothing was typed."),
  })
  .openapi("LoginUse");

export const botRequestResponse = z
  .object({
    id: z.string(),
    agentId: z.string(),
    proposal: agentInput,
    reason: z.string(),
    status: z.enum(["pending", "approved", "declined"]),
    createdAgentId: z.string().nullable(),
    requestedAt: z.string(),
    decidedAt: z.string().nullable(),
  })
  .openapi("BotRequest");

export const memoryResponse = z
  .object({
    id: z.string(),
    agentId: z.string().nullable(),
    content: z.string(),
    // Null for memories saved before sources were recorded. A bare nullable union keeps generators' projection simple.
    source: z.union([memorySourceResponse, z.null()]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Memory");

export const skillDocumentResponse = z
  .object({ path: z.string(), content: z.string() })
  .openapi("SkillDocument");

export const skillOriginResponse = z
  .object({
    repository: z.string().openapi({ description: "`owner/repo`." }),
    branch: z.string(),
    path: z
      .string()
      .openapi({ description: "The skill's folder; empty for the root." }),
    commit: z.string(),
    digest: z.string().openapi({
      description:
        "Fingerprint of the imported files; an update is available when upstream's differs.",
    }),
  })
  .openapi("SkillOrigin", {
    description:
      "Where an installed skill came from. Installed skills are read-only.",
  });

export const skillUpdateResponse = z
  .object({
    commit: z.string(),
    removed: z.boolean().openapi({
      description: "The skill's folder is gone from the branch.",
    }),
  })
  .openapi("SkillUpdate", {
    description: "The newer upstream commit of an installed skill.",
  });

// The published shape of a skill, kept as is: ListedSkill refers to it, and a changed member of that union would be
// a breaking change. Responses permit additional properties, so handlers return the full package anyway.
export const skillResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    instructions: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Skill");

/** A skill as a full package, with its documents, provenance, usage, and lifecycle. A plain object, not an extension of Skill, so generators see one typed object. */
export const skillPackageResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    instructions: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    // The bot that owns the skill; null for a shared skill.
    agentId: z.string().nullable(),
    description: z.string(),
    documents: z.array(skillDocumentResponse),
    createdBy: z.enum(["owner", "bot"]),
    sourceExecutionId: z.string().nullable(),
    useCount: z.number().int(),
    lastUsedAt: z.string().nullable(),
    state: z.enum(SKILL_STATES),
    pinned: z.boolean(),
    copiedFromSkillId: z.uuid().nullable().optional(),
    origin: skillOriginResponse.nullable().optional(),
  })
  .openapi("SkillPackage");

export const listedSkillResponse = z
  .discriminatedUnion("source", [
    skillResponse.extend({
      source: z.literal("shared"),
      description: z.string().optional(),
      origin: skillOriginResponse.nullable().optional(),
      update: skillUpdateResponse.nullable().optional(),
    }),
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      instructions: z.string(),
      path: z.string(),
      source: z.literal("bundled"),
    }),
  ])
  .openapi("ListedSkill");

const changeSourceResponse = z
  .object({
    executionId: z.string().nullable().optional(),
    conversationId: z.string().nullable().optional(),
    groupId: z.string().nullable().optional(),
  })
  .openapi("ChangeSource");

export const learnedChangeResponse = z
  .object({
    id: z.string(),
    // The bot whose skill or memory changed; null for a shared one.
    agentId: z.string().nullable(),
    actor: z.enum(CHANGE_ACTORS),
    target: z.enum(CHANGE_TARGETS),
    targetId: z.string(),
    action: z.enum(CHANGE_ACTIONS),
    before: z.union([skillPackageResponse, memoryResponse, z.null()]),
    after: z.union([skillPackageResponse, memoryResponse, z.null()]),
    source: z.union([changeSourceResponse, z.null()]),
    revertsId: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("LearnedChange");

export const reviewResultResponse = z
  .object({
    executionId: z.string(),
    agentId: z.string(),
    createdAt: z.string(),
    changes: z.array(learnedChangeResponse),
  })
  .openapi("ReviewResult");

export const scheduleResponse = z
  .object({
    id: z.string(),
    agentId: z.string(),
    name: z.string(),
    prompt: z.string(),
    kind: z.enum(SCHEDULE_KINDS),
    command: z.string().nullable(),
    timeoutSeconds: z.number().int(),
    notify: z.boolean(),
    cron: z.string().nullable(),
    timezone: z.string(),
    runAt: z.string().nullable(),
    eventSourceId: z.string().nullable().openapi({
      description:
        "The event source whose events start this automation; set instead of `cron` and `runAt`.",
    }),
    enabled: z.boolean(),
    nextRunAt: z.string().nullable(),
    createdAt: z.string(),
    createdByAgentId: z.string().nullable(),
  })
  .openapi("Schedule");

const operationalActivity = z
  .object({
    id: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    entryId: z.string(),
    timestamp: z.number().optional(),
    kind: z.enum(ACTIVITY_KINDS),
    details: z.record(z.string(), z.unknown()),
  })
  .openapi("OperationalActivity");

const changeActivity = z
  .object({
    id: z.string(),
    // Null for a change to the shared library.
    agentId: z.string().nullable(),
    agentName: z.string().nullable(),
    timestamp: z.number(),
    kind: z.literal("change"),
    change: learnedChangeResponse,
  })
  .openapi("ChangeActivity");

export const activityFeedResponse = z
  .object({
    activities: z.array(z.union([operationalActivity, changeActivity])),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .openapi("ActivityFeed");

const authType = z.enum(SIGN_IN_METHODS);

export const loginMethod = z
  .object({
    type: authType,
    label: z.string(),
    subscription: z.boolean(),
  })
  .openapi("ProviderLoginMethod");

export const externalAuthResponse = z
  .object({
    status: z.enum(["signed_in", "signed_out", "cli_missing", "error"]),
    cliVersion: z.string().nullable(),
    signInCommand: z.string().nullable(),
    signOutCommand: z.string().nullable(),
    message: z.string().nullable(),
  })
  .openapi("ProviderExternalAuth");

export const providerResponse = z
  .object({
    provider: z.string(),
    name: z.string(),
    configured: z.boolean(),
    authMethods: z.array(loginMethod),
    /** The provider's saved credential; ambient credentials have none. */
    credentialType: authType.nullable(),
    apiKey: secretStatusResponse,
    activeLoginId: z.string().nullable(),
    /** Set for providers whose sign-in happens outside Crumble; they have no `authMethods`. */
    externalAuth: externalAuthResponse.nullable(),
  })
  .openapi("Provider");

/** One object rather than a union, so generated clients keep the nullable prompt. */
export const loginPrompt = z.object({
  id: z.string(),
  type: z.enum(["text", "secret", "select", "manual_code"]),
  message: z.string(),
  placeholder: z.string().optional(),
  /** Present exactly for `select`; answer with an option's `id`. */
  options: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

export const loginEvent = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("info"),
      message: z.string(),
      links: z
        .array(z.object({ url: z.string(), label: z.string().optional() }))
        .optional(),
    }),
    z.object({
      type: z.literal("auth_url"),
      url: z.string(),
      instructions: z.string().optional(),
    }),
    z.object({
      type: z.literal("device_code"),
      userCode: z.string(),
      verificationUri: z.string(),
      intervalSeconds: z.number().optional(),
      expiresInSeconds: z.number().optional(),
    }),
    z.object({ type: z.literal("progress"), message: z.string() }),
  ])
  .openapi("ProviderLoginEvent");

export const loginSessionResponse = z
  .object({
    id: z.string(),
    provider: z.string(),
    method: authType,
    status: z.enum(["pending", "succeeded", "failed", "cancelled", "expired"]),
    createdAt: z.number(),
    expiresAt: z.number(),
    prompt: loginPrompt.nullable(),
    events: z.array(loginEvent),
    failure: z
      .object({
        code: z.enum([
          "provider_failure",
          "callback_unavailable",
          "storage_failure",
        ]),
        message: z.string(),
      })
      .nullable(),
  })
  .openapi("ProviderLoginSession");

export const modelResponse = z
  .object({
    provider: z.string(),
    id: z.string(),
    name: z.string(),
    contextWindow: z.number(),
    reasoning: z.boolean(),
    thinkingLevels: z.array(thinkingLevel).openapi({
      description:
        "The thinking levels this model takes, from lowest to highest. A bot's level outside them runs at the nearest one.",
    }),
  })
  .openapi("Model");

export const providerConfiguredResponse = z
  .object({ provider: z.string(), configured: z.boolean() })
  .openapi("ProviderConfigured");

export const passwordManagerResponse = z
  .object({
    id: z.enum(PASSWORD_MANAGER_IDS),
    name: z.string(),
    connected: z.boolean(),
    connectedAt: z.string().nullable(),
    usedBy: z.array(z.string()).openapi({
      description:
        "The keys of the secrets that read their value from this password manager, such as `mcp:<server ID>`; it can't be disconnected while any remain.",
    }),
  })
  .openapi("PasswordManager");

export const passwordManagersResponse = z
  .object({ passwordManagers: z.array(passwordManagerResponse) })
  .openapi("PasswordManagers");

export const pluginSettingResponse = z
  .object({
    key: z.string(),
    kind: z.enum(["secret"]).openapi({
      description: "A secret is written once and never returned.",
    }),
    label: z.string(),
    whenMissing: z.string().openapi({
      description: "The status to show while the setting has no value.",
    }),
    secret: secretStatusResponse,
  })
  .openapi("PluginSetting");

export const pluginSettingsResponse = z
  .object({
    plugins: z.array(
      z.object({
        id: z.string(),
        contributes: z
          .array(
            z.enum([
              "providers",
              "jobKinds",
              "webSearchProviders",
              "chatAdapters",
            ]),
          )
          .openapi({
            description:
              "What the plugin adds to the server, so a client can show its settings where those are chosen.",
          }),
        settings: z.array(pluginSettingResponse),
      }),
    ),
  })
  .openapi("PluginSettings");

export const mcpServerResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    enabled: z.boolean(),
    agentId: z.string().nullable(),
    oauthClientId: z.string().nullable().openapi({
      description:
        "The client ID of an OAuth app the owner registered with the server's authorization server, used instead of registering Crumble.",
    }),
    token: secretStatusResponse,
    oauthClientSecret: secretStatusResponse,
  })
  .openapi("McpServer");

export const describedMcpServerResponse = mcpServerResponse
  .extend({
    auth: z.enum(["oauth", "token", "none"]),
    error: z.string().nullable().openapi({
      description:
        "Why the server's tools were left out of a bot's last turn, such as a missing sign-in; null once it connects again.",
    }),
    authenticated: z.boolean(),
  })
  .openapi("McpServerStatus");

export const oauthStartResponse = z
  .union([
    z.object({ authorizationUrl: z.string() }),
    z.object({ authorized: z.literal(true) }),
  ])
  .openapi("McpOAuthStart");

export const compactResponse = z
  .object({ taskId: z.string() })
  .openapi("Compaction");

export const chatPreviewEvent = z
  .object({
    type: z.literal("chat-preview"),
    agentId: z.string(),
    agentName: z.string(),
    lastMessage: z.string(),
  })
  .openapi("ChatPreviewEvent");

export const learnedEvent = z
  .object({
    type: z.literal("learned"),
    agentId: z.string(),
    agentName: z.string(),
    executionId: z.string(),
    changes: z.array(
      z.object({
        changeId: z.string(),
        target: z.enum(CHANGE_TARGETS),
        action: z.enum(CHANGE_ACTIONS),
        name: z.string(),
      }),
    ),
    createdAt: z.string(),
  })
  .openapi("LearnedEvent", {
    description:
      "A bot's review of one of its turns changed its skills or memory, sent as the `learned` event on /v1/events. Clients show a short notice in the bot chat and link to the change record.",
  });

// LearnedEvent is its own `learned` SSE event, not a member of this union: adding a member would be a breaking
// change for clients that read the union as closed, while a new event name is ignored by every client.
export const activityEvent = z
  .discriminatedUnion("type", [replyEvent, chatPreviewEvent])
  .openapi("ActivityEvent");

export const heartbeatEvent = z.object({}).openapi("HeartbeatEvent");

export const eventSchemas: {
  schema: z.ZodType;
  component?: string;
  artifact?: string;
}[] = [
  { schema: replyEvent, component: "ReplyEvent" },
  { schema: chatPreviewEvent, component: "ChatPreviewEvent" },
  {
    schema: heartbeatEvent,
    component: "HeartbeatEvent",
    artifact: "heartbeat.schema.json",
  },
  {
    schema: activityEvent,
    component: "ActivityEvent",
    artifact: "activity-event.schema.json",
  },
  {
    schema: learnedEvent,
    component: "LearnedEvent",
    artifact: "learned-event.schema.json",
  },
  { schema: chatSnapshotResponse, artifact: "chat-snapshot.schema.json" },
  {
    schema: groupChatSnapshotResponse,
    artifact: "group-chat-snapshot.schema.json",
  },
  { schema: desktopControlResponse, artifact: "desktop-control.schema.json" },
  {
    schema: voiceGatewayConfigEvent,
    component: "VoiceGatewayConfigEvent",
    artifact: "voice-gateway-config.schema.json",
  },
  {
    schema: voiceCallEvent,
    component: "VoiceCallEvent",
    artifact: "voice-call.schema.json",
  },
  {
    schema: voiceCallCancelEvent,
    component: "VoiceCallCancelEvent",
    artifact: "voice-call-cancel.schema.json",
  },
  {
    schema: voiceGatewayReplacedEvent,
    component: "VoiceGatewayReplacedEvent",
    artifact: "voice-gateway-replaced.schema.json",
  },
];
