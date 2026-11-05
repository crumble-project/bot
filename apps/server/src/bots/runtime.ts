import {
  BOT_MESSAGE_ENTRY,
  MESSAGE_ENTRY,
  type MessageOrigin,
} from "./entries";
import {
  BACKGROUND_CONTEXT,
  type Context as PiContext,
} from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { rm } from "node:fs/promises";
import {
  Harness,
  createRegistry,
  type ConversationId,
  type Tx,
  defineExtension,
  defineTool,
  type EnvTarget,
  type Extension,
  type LiveState,
  watchEvents,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { Context, Effect, Layer, Predicate } from "effect";
import {
  JOB_KNOWLEDGE_EXTENSION,
  defineJobKind,
  mergeTurnWork,
  modelRef,
  type JobKind,
  type TurnWork,
} from "../jobs/jobs";
import { JOB_KINDS, jobKindTitle, type JobKindName } from "../jobs/job-kinds";
import { GroupConversation, groupOf } from "../group-chats/group-conversation";
import {
  GROUP_EXCLUDED_EXTENSIONS,
  GroupAnchor,
  groupTurnExtension,
} from "../group-chats/group-turns";
import type { Agent } from "../shared/domain";
import { formatEntryId, parseEntryId } from "../shared/entry-ids";
import { ProviderModels } from "../providers/providers";
import { BotMemory } from "../memory/bot-memory";
import { memoryExtension, type MemoryStore } from "../memory/memory-tool";
import { SettingsRepository } from "../shared/settings-repository";
import { AgentRepository } from "./agent-repository";
import { BotExtensions } from "./bot-extensions";
import {
  clockInstructions,
  conversationInstructions,
  jobKnowledge,
  type ConversationScope,
} from "./prompts";
import { SkillReads, skillTool } from "../skills/skill-library";
import { BotSkills } from "../skills/skills";
import { skillManageTool } from "../skills/skill-manage";
import {
  ReviewAnchor,
  ReviewConversation,
  reviewExtension,
} from "../learning/review-conversation";
import type { ReviewScope } from "../learning/review-instructions";
import type { AttachmentInput } from "../shared/attachment-rules";
import { prepareAttachments } from "../shared/attachments";
import { BOT_TOOL } from "../contract/tools";
import {
  prepareReply,
  readAttachment,
  conversations,
  readResponse,
  readConversationTranscript,
  readTranscript,
  type BotMessageEvent,
  type PageOptions,
  type TranscriptMessage,
  type TranscriptPage,
} from "./transcript";
import { InvalidInput, NotFound } from "../shared/errors";
import {
  chosenVisionModel,
  describesImages,
  readsImages,
  visionExtension,
  type VisionModelRef,
} from "../vision/vision";

/** The IANA timezone the owner's client last reported with a chat message. */
export const OWNER_TIMEZONE = "owner-timezone";

export type RuntimeCallbacks = MemoryStore & {
  models: Models | ((agent: Agent) => Models | Promise<Models>);
  /** The bot as it is now; null once it is gone. */
  currentAgent: (agent: Agent) => Agent | null;
  ownerTimezone: () => string | undefined;
  /** The skills a bot can load and the ones it may write. Listed in its instructions by name only. */
  skillLibrary: BotSkills["Service"];
  /** The account's vision model, read at each use; undefined while it is off. */
  visionModel: () => VisionModelRef | undefined;
  extensions: (agent: Agent) => Extension[] | Promise<Extension[]>;
  /** Installed but never offered in the bot's chat: tasks select them for the conversations they own. */
  taskExtensions: (agent: Agent) => Extension[] | Promise<Extension[]>;
  /** The execution environment of one of the bot's conversations, as configured now. Never asked for a review. */
  env: (
    agent: Agent,
    target: EnvTarget,
    context: PiContext,
  ) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
};

export type RuntimeSnapshot = {
  conversationId: string;
  messages: TranscriptMessage[];
  live: ReturnType<typeof publicLive>;
  partial: string;
  usage: JsonValue | undefined;
  hasMore: boolean;
  oldestEntryId: string | null;
  status: "idle" | "running";
  updatedAt: number;
};

export type RuntimeWatch = (snapshot: RuntimeSnapshot) => void | Promise<void>;

type HarnessRecord = {
  harness: Harness;
  models: Models;
  choices: { agent: Agent };
  memory: ReturnType<typeof defineTool>;
  skill: ReturnType<typeof defineTool>;
  skillManage: ReturnType<typeof defineTool>;
  memoryExtension: Extension;
  skillExtension: Extension;
  reviewExtension: Extension;
  groupExtension: Extension;
  visionExtension: Extension;
  askAboutImage: ReturnType<typeof defineTool>;
  jobKnowledgeExtension: Extension;
  registry: ReturnType<typeof createRegistry>;
  /** Everything installed in the registry: the offered extensions, then the task extensions. */
  extensions: Extension[];
};

/**
 * Keep run/tool progress available to clients without exposing the provider's
 * in-flight assistant message. The durable harness commits the final answer
 * together with run completion; clients should render that committed entry
 * only after the run has ended.
 */
function publicLive(live: LiveState | undefined) {
  if (!live) return live;

  if (!live.generation) return live;
  const { message: _message, ...generation } = live.generation;

  return { ...live, generation };
}

type InferenceOptions = { temperature?: number; maxTokens?: number };

function inferenceOptions(inference: Agent["inference"]): InferenceOptions {
  const options: InferenceOptions = {};

  if (inference?.temperature !== undefined)
    options.temperature = inference.temperature;

  if (inference?.maxOutputTokens !== undefined)
    options.maxTokens = inference.maxOutputTokens;

  return options;
}

type EntryMetadata = {
  requestId?: string;
  origin?: MessageOrigin;
  attachments?: Array<{ kind: string; [key: string]: JsonValue }>;
};

function entryMetadata(
  requestId: string | undefined,
  origin: MessageOrigin | undefined,
  attachments: Array<{ kind: string; [key: string]: JsonValue }>,
) {
  const metadata: EntryMetadata = {};

  if (requestId) metadata.requestId = requestId;

  if (origin) metadata.origin = origin;

  if (attachments.length) metadata.attachments = attachments;

  return metadata;
}

/** One input's text for the model and the data its entry stores. */
export type PreparedInput = {
  modelContent: string;
  data: Record<string, JsonValue>;
};

type HistoryOptions = PageOptions & {
  /** Operational consumers may need committed tool-call blocks mid-run. */
  includeActiveAssistant?: boolean | undefined;
};

function hideIncompleteAssistant(messages: TranscriptMessage[]) {
  return messages.filter(
    (message) =>
      message.role !== "assistant" ||
      (message.stopReason !== "aborted" && message.stopReason !== "error"),
  );
}

/**
 * What clients may show of `conversations`. A model can commit a tool-calling assistant entry before its tool round
 * completes, so assistant entries after an active input stay hidden until the run settles and no text segment leaks
 * mid-turn. Entry IDs are global across the bot's conversations, so only inputs of these conversations count.
 */
async function visibleMessages(
  harness: Harness,
  conversations: readonly ConversationId[],
  messages: TranscriptMessage[],
) {
  const { submissions } = await harness.inspect(BACKGROUND_CONTEXT);

  const cutoffs = submissions.flatMap((submission) =>
    submission.type === "input" &&
    submission.status === "placed" &&
    conversations.includes(submission.conversationId)
      ? [Number(submission.entry)]
      : [],
  );

  const finished = hideIncompleteAssistant(messages);

  if (!cutoffs.length) return finished;
  const cutoff = Math.min(...cutoffs);

  return finished.filter((message) => {
    const entry = parseEntryId(message.entryId);

    return (
      message.role !== "assistant" ||
      (Number.isSafeInteger(entry) ? entry : -1) <= cutoff
    );
  });
}

type AnchorTask = typeof GroupAnchor;

// Only reads and answers: a kind's documents and tasks are named by its facts, so these need no plugin.
const JOB_READERS: Record<JobKindName, JobKind> = {
  coding: defineJobKind(JOB_KINDS.coding),
  desktop: defineJobKind(JOB_KINDS.desktop),
};

const isJobKind = (kind: string): kind is JobKindName =>
  Object.hasOwn(JOB_READERS, kind);

function numericId(value: string): never {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Invalid durable record ID");

  // SAFETY: validated decimal IDs are branded by pi-durable at this boundary.
  return Number(value) as never;
}

function localConversationId(agentId: string, reference: string): never {
  const id = parseEntryId(reference, agentId);

  if (id === "foreign")
    throw new Error("Conversation belongs to a different agent");

  if (id === "malformed") throw new Error("Invalid durable record ID");

  // SAFETY: validated decimal IDs are branded by pi-durable at this boundary.
  return id as never;
}

async function conversationScope(
  harness: Harness,
  localId: ConversationId,
): Promise<ConversationScope> {
  const group = Boolean(await groupOf(harness, localId, BACKGROUND_CONTEXT));

  const reviewDoc = await harness.snapshot(
    ReviewConversation,
    localId,
    BACKGROUND_CONTEXT,
  );

  const review: ReviewScope | null = reviewDoc?.executionId
    ? { skills: reviewDoc.skills, memory: reviewDoc.memory }
    : null;

  return { group, review };
}

const isReview = async (target: EnvTarget, context: PiContext) =>
  Boolean(
    (
      await target.read.snapshot(
        ReviewConversation,
        target.conversationId,
        context,
      )
    )?.executionId,
  );

async function ensureModel(
  models: Models,
  choice: Pick<Agent, "provider" | "model">,
) {
  if (!models.getModel(choice.provider, choice.model))
    await models.refresh({ providers: [choice.provider] });
}

// The bot can always write its first skill, so management does not wait for the index.
function chatTools(
  record: HarnessRecord,
  agent: Agent,
  offered: Extension[],
  options: { hasSkills: boolean; group: boolean; vision: boolean },
) {
  return [
    ...(agent.tools.includes(BOT_TOOL.memory) ? [record.memory] : []),
    ...(options.hasSkills ? [record.skill] : []),
    record.skillManage,
    ...offered.flatMap((extension) => extension.tools ?? []),
    ...(options.group ? (record.groupExtension.tools ?? []) : []),
    ...(options.vision ? [record.askAboutImage] : []),
  ];
}

// A review gets only the stores it reviews, never chat actions, jobs, delegation, or integrations.
function reviewTools(
  record: HarnessRecord,
  agent: Agent,
  hasSkills: boolean,
  review: ReviewScope,
) {
  return [
    ...(agent.tools.includes(BOT_TOOL.memory) && review.memory
      ? [record.memory]
      : []),
    ...(hasSkills ? [record.skill] : []),
    ...(review.skills ? [record.skillManage] : []),
  ];
}

type PreparedAttachments = ReturnType<typeof prepareAttachments>;

// Catalogs that list no modalities are trusted; the provider reports anything it refuses. With a vision model set,
// the vision extension describes images for a model that can't read them.
function assertImageSupport(
  agent: Agent,
  model: { input?: readonly string[] } | undefined,
  info: PreparedAttachments["info"],
  vision: VisionModelRef | undefined,
) {
  if (
    info.some((item) => item.kind === "image") &&
    !readsImages(model) &&
    !vision
  )
    throw new InvalidInput({
      message: `${agent.model} can't read images. Choose a model that accepts images in the bot's profile, or set a vision model in Settings to describe images for it.`,
    });
}

function inputContent(text: string, blocks: PreparedAttachments["blocks"]) {
  if (!blocks.length) return text;

  return [...(text.trim() ? [{ type: "text" as const, text }] : []), ...blocks];
}

function inferenceModels(models: Models, choices: { agent: Agent }) {
  return new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple")
        return (...args: Parameters<Models["streamSimple"]>) => {
          const inference = choices.agent.inference;

          return target.streamSimple(args[0], args[1], {
            ...args[2],
            ...inferenceOptions(inference),
          });
        };

      // SAFETY: Proxy properties are the keys of the Models instance; the
      // special streamSimple branch above handles the only replaced method.
      const value = target[property as keyof Models];

      return value instanceof Function ? value.bind(target) : value;
    },
  });
}

type ConversationTools = ReturnType<typeof chatTools>;

// With code mode the model writes one script that calls the other tools, instead of calling them itself.
// Model-only tools, such as code mode itself, stay direct.
function modelToolsOf(tools: ConversationTools) {
  if (!tools.some((tool) => tool.name === CODEMODE_TOOL_NAME)) return tools;

  return tools.filter(
    (tool) => tool.callers !== undefined && !tool.callers.includes("tools"),
  );
}

function scopedExtensions(
  record: HarnessRecord,
  offered: Extension[],
  scope: { group: unknown; review: unknown },
) {
  if (scope.review)
    return {
      extensions: [
        record.memoryExtension,
        record.skillExtension,
        record.visionExtension,
        record.reviewExtension,
      ],
    };

  if (scope.group)
    return {
      extensions: [
        record.memoryExtension,
        record.skillExtension,
        ...offered,
        record.groupExtension,
        record.visionExtension,
      ],
    };

  // Only jobs select the job knowledge; the chat has the same in its instructions.
  return { extensions: { remove: [record.jobKnowledgeExtension] } };
}

async function ensureAgentModels(models: Models, agent: Agent) {
  // Dynamic catalogs (Melious) list models only after a refresh with the saved key.
  await ensureModel(models, agent);

  // The desktop job model may come from another provider with a dynamic catalog.
  if (agent.desktopModel) await ensureModel(models, agent.desktopModel);
}

export class AgentRuntime {
  /** Skills each turn has loaded, checked before a bot changes one. */
  private readonly skillReads = new SkillReads();
  private readonly records = new Map<string, Promise<HarnessRecord>>();
  private closed = false;
  constructor(
    private readonly dataDir: string,
    private readonly callbacks: RuntimeCallbacks,
  ) {}

  private async open(agent: Agent): Promise<HarnessRecord> {
    if (this.closed) throw new Error("Runtime is closed");
    const existing = this.records.get(agent.id);

    if (existing) return existing;
    const opening = this.openRecord(agent);
    this.records.set(agent.id, opening);

    try {
      return await opening;
    } catch (error) {
      this.records.delete(agent.id);
      throw error;
    }
  }

  private skillTools(agent: Agent) {
    const currentAgent = () => {
      const current = this.callbacks.currentAgent(agent);

      if (!current?.enabled)
        throw new Error("Skill access is disabled for this agent");

      return current;
    };

    const library = this.callbacks.skillLibrary;

    const skill = skillTool({
      skills: async () => Effect.runPromise(library.available(currentAgent())),
      used: async (loaded, runKey) => {
        this.skillReads.mark(runKey, loaded.id);
        await Effect.runPromise(library.used(currentAgent(), loaded));
      },
    });

    const skillManage = skillManageTool({
      library,
      reads: this.skillReads,
      agent: currentAgent,
    });

    return { skill, skillManage };
  }

  private async modelsFor(agent: Agent) {
    const { models } = this.callbacks;

    return models instanceof Function ? models(agent) : models;
  }

  private async extensionsOf(agent: Agent) {
    const next = await this.callbacks.extensions(agent);

    const installed = [
      ...next,
      ...(await this.callbacks.taskExtensions(agent)),
    ];

    return { next, installed };
  }

  private async openRecord(agent: Agent): Promise<HarnessRecord> {
    const storage = await openNodeSqliteStorage(
      `${this.dataDir}/${agent.id}.sqlite`,
    );

    try {
      const models = await this.modelsFor(agent);

      const { tool: memory, extension: memoryTools } = memoryExtension(
        agent,
        this.callbacks,
        this.callbacks.currentAgent,
      );

      const { skill, skillManage } = this.skillTools(agent);

      const registry = createRegistry();

      const skillExtension = defineExtension({
        name: "skills",
        tools: [skill, skillManage],
      });

      const groupExtension = groupTurnExtension();
      registry.install(memoryTools);
      registry.install(skillExtension);
      registry.install(groupExtension);

      // Hooks and tools run only once the harness is open; until then nothing calls them.
      let opened: Harness | undefined;

      const vision = visionExtension({
        harness: () => opened,
        visionModel: () => this.visionModel(),
      });

      registry.install(vision.extension);
      const reviewExt = reviewExtension();
      registry.install(reviewExt);
      const choices = { agent };

      // A job loads skills but never writes them or memory: memory writes record chat turns as their source.
      const jobKnowledgeExtension = defineExtension({
        name: JOB_KNOWLEDGE_EXTENSION,
        tools: [skill],
        sections: [
          {
            key: "bot_knowledge",
            render: async () => {
              const current = choices.agent;

              return jobKnowledge(
                current.instructions,
                await this.availableSkills(current),
                await this.callbacks.listMemory(current.id),
              );
            },
          },
        ],
      });

      registry.install(jobKnowledgeExtension);

      const { installed: extensions } = await this.extensionsOf(agent);

      for (const extension of extensions) registry.install(extension);

      const configuredModels = inferenceModels(models, choices);

      const harness = await Harness.open(
        storage,
        {
          models: configuredModels,
          registry,
          env: async (target, context) =>
            // A review runs no shell tools, so it gets no environment to reach the workspace through.
            (await isReview(target, context))
              ? undefined
              : this.callbacks.env(choices.agent, target, context),
        },
        BACKGROUND_CONTEXT,
      );

      opened = harness;

      if (agent.enabled) harness.resume();

      return {
        harness,
        models,
        choices,
        memory,
        skill,
        skillManage,
        memoryExtension: memoryTools,
        skillExtension,
        reviewExtension: reviewExt,
        groupExtension,
        visionExtension: vision.extension,
        askAboutImage: vision.ask,
        jobKnowledgeExtension,
        registry,
        extensions,
      };
    } catch (error) {
      await storage.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  private async installExtensions(record: HarnessRecord, agent: Agent) {
    const { next, installed } = await this.extensionsOf(agent);

    for (const previous of record.extensions)
      if (!installed.some((extension) => extension.name === previous.name))
        record.registry.uninstall(previous);

    for (const extension of installed) record.registry.install(extension);
    record.extensions = installed;

    return next;
  }

  private async ensuredReviewModel(
    record: HarnessRecord,
    agent: Agent,
    review: boolean,
  ) {
    const reviewModel = review ? this.reviewModelOf(agent) : null;

    if (reviewModel) await ensureModel(record.models, reviewModel);

    return reviewModel;
  }

  private async availableSkills(agent: Agent) {
    return Effect.runPromise(this.callbacks.skillLibrary.available(agent));
  }

  private async configure(
    record: HarnessRecord,
    agent: Agent,
    conversationId: string,
  ) {
    record.choices.agent = agent;

    await ensureAgentModels(record.models, agent);
    const next = await this.installExtensions(record, agent);

    const localId = localConversationId(agent.id, conversationId);

    const scope = await conversationScope(record.harness, localId);
    const { group, review } = scope;

    const reviewModel = await this.ensuredReviewModel(
      record,
      agent,
      Boolean(review),
    );

    // A group turn can neither delegate nor start coding jobs, and may pass instead of answering.
    const offered = group
      ? next.filter(
          (extension) => !GROUP_EXCLUDED_EXTENSIONS.has(extension.name),
        )
      : next;

    const skills = await this.availableSkills(agent);

    const tools = review
      ? reviewTools(record, agent, skills.length > 0, review)
      : chatTools(record, agent, offered, {
          hasSkills: skills.length > 0,
          group,
          vision: this.describesImagesFor(record, agent),
        });

    const conversation = await record.harness.conversation(
      localId,
      BACKGROUND_CONTEXT,
    );

    if (!conversation) throw new Error("Conversation not found");
    const memory = await this.callbacks.listMemory(agent.id);
    const clock = clockInstructions(this.callbacks.ownerTimezone);

    await conversation.configure(
      {
        model: modelRef(reviewModel ?? agent),
        thinkingLevel: agent.inference?.thinkingLevel ?? "off",
        ...scopedExtensions(record, offered, scope),
        instructions: conversationInstructions(agent, skills, memory, {
          ...scope,
          clock,
        }),
        tools,
        modelTools: modelToolsOf(tools),
      },
      BACKGROUND_CONTEXT,
    );

    return conversation;
  }

  async openChat(agent: Agent): Promise<string> {
    const record = await this.open(agent);
    const root = await record.harness.root(BACKGROUND_CONTEXT);
    const reference = formatEntryId(agent.id, Number(root.id));
    await this.configure(record, agent, reference);

    return reference;
  }

  /** A new working conversation for the bot in one group chat, owned by a background task of its chat. */
  async openGroupConversation(agent: Agent, groupId: string): Promise<string> {
    return this.openAnchored(agent, GroupAnchor, async (tx, id) => {
      (await tx.doc(GroupConversation, id)).groupId = groupId;
    });
  }

  /** A new conversation owned by a background `anchor` task of the bot's chat, set up by `init` in the same commit. */
  private async openAnchored(
    agent: Agent,
    anchor: AnchorTask,
    init: (tx: Tx, id: ConversationId) => Promise<void>,
  ): Promise<string> {
    const record = await this.open(agent);
    const root = await record.harness.root(BACKGROUND_CONTEXT);

    const id = await root.commit(async (tx) => {
      const taskId = await tx.createTask(anchor, null, {
        ownership: { kind: "conversation" },
        background: true,
      });

      const child = await tx.createConversation({
        ownership: { kind: "task", taskId },
      });

      await init(tx, child.id);

      return child.id;
    }, BACKGROUND_CONTEXT);

    const reference = formatEntryId(agent.id, Number(id));
    await this.configure(record, agent, reference);

    return reference;
  }

  /** The model a bot's reviews run on: the chosen one, else the bot's own. */
  private reviewModelOf(agent: Agent) {
    return (
      agent.reviewModel ?? { provider: agent.provider, model: agent.model }
    );
  }

  /** A new conversation that reviews one execution, owned by a background task so it stays out of the bot chat. */
  async openReviewConversation(
    agent: Agent,
    execution: { id: string; conversationId: string },
    scope: ReviewScope,
    budgetChars: number,
  ): Promise<string> {
    const { harness } = await this.open(agent);

    const reviewedGroup = await groupOf(
      harness,
      localConversationId(agent.id, execution.conversationId),
      BACKGROUND_CONTEXT,
    );

    return this.openAnchored(agent, ReviewAnchor, async (tx, id) => {
      const doc = await tx.doc(ReviewConversation, id);
      doc.executionId = execution.id;
      doc.groupId = reviewedGroup;
      doc.skills = scope.skills;
      doc.memory = scope.memory;
      doc.budgetChars = budgetChars;
    });
  }

  /** The context window of the bot's review model, which bounds what a review may spend; undefined when it lists none. */
  async reviewContextWindow(agent: Agent) {
    const { models } = await this.open(agent);
    const choice = this.reviewModelOf(agent);
    await ensureModel(models, choice);

    return models.getModel(choice.provider, choice.model)?.contextWindow;
  }

  /** The conversation of a submission and the input entry it wrote; none before the input is written. */
  async settledTurn(
    agent: Agent,
    conversationId: string,
    submissionId: string,
  ) {
    const { harness } = await this.open(agent);

    const submission = await harness.submission(
      numericId(submissionId),
      BACKGROUND_CONTEXT,
    );

    const status = await submission?.status(BACKGROUND_CONTEXT);

    const conversation = await harness.conversation(
      localConversationId(agent.id, conversationId),
      BACKGROUND_CONTEXT,
    );

    if (!status?.entry || !conversation) return undefined;

    return { conversation, entry: Number(status.entry) };
  }

  /** The account's vision model; undefined while it is off. */
  private visionModel() {
    return this.callbacks.visionModel?.();
  }

  /** Whether the vision model describes images for the bot: one is set and the bot's model can't read them. */
  private describesImagesFor(record: HarnessRecord, agent: Agent) {
    return describesImages(
      this.visionModel(),
      record.models.getModel(agent.provider, agent.model),
    );
  }

  /**
   * Whether the bot takes images: its model reads them, or the account's vision model describes them for it. Catalogs
   * that list no modalities are trusted, as for chat uploads.
   */
  async acceptsImages(agent: Agent) {
    const { models } = await this.open(agent);
    await ensureModel(models, agent);

    return (
      readsImages(models.getModel(agent.provider, agent.model)) ||
      this.visionModel() !== undefined
    );
  }

  /** One model answer outside any conversation, written by the bot's own model. */
  async complete(
    agent: Agent,
    systemPrompt: string,
    text: string,
    signal?: AbortSignal,
  ) {
    const { models } = await this.open(agent);
    await ensureModel(models, agent);
    const model = models.getModel(agent.provider, agent.model);

    if (!model) throw new Error(`${agent.model} is not available`);

    const options: InferenceOptions & { signal?: AbortSignal } =
      inferenceOptions(agent.inference);

    if (signal) options.signal = signal;

    return models.completeSimple(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", content: text, timestamp: Date.now() }],
      },
      options,
    );
  }

  async compact(agent: Agent, conversationId: string): Promise<string> {
    const conversation = await this.configure(
      await this.open(agent),
      agent,
      conversationId,
    );

    return String(await conversation.compact(undefined, BACKGROUND_CONTEXT));
  }

  /** An input's model text and stored data; a reply carries bounded context from the message it answers. */
  async prepareInput(
    agent: Agent,
    text: string,
    replyTo: string | undefined,
  ): Promise<PreparedInput> {
    if (!replyTo) return { modelContent: text, data: { text } };
    const { harness } = await this.open(agent);

    try {
      return await prepareReply(harness, agent.id, replyTo, text);
    } catch (error) {
      throw new InvalidInput({
        message:
          error instanceof Error ? error.message : "Invalid reply target",
      });
    }
  }

  /** `input` is what admission prepared and framed; without it, the model reads `text` as written. */
  async submit(
    agent: Agent,
    conversationId: string,
    text: string,
    requestId?: string,
    options: {
      input?: PreparedInput | undefined;
      origin?: MessageOrigin;
      attachments?: AttachmentInput[] | undefined;
    } = {},
  ): Promise<string> {
    const record = await this.open(agent);
    const attached = prepareAttachments(options.attachments ?? []);
    const prepared = options.input ?? { modelContent: text, data: { text } };
    const conversation = await this.configure(record, agent, conversationId);
    const model = record.models.getModel(agent.provider, agent.model);

    assertImageSupport(agent, model, attached.info, this.visionModel());

    const draft = {
      type: "input" as const,
      content: inputContent(prepared.modelContent, attached.blocks),
      entry: {
        kind: MESSAGE_ENTRY,
        data: {
          ...prepared.data,
          ...entryMetadata(requestId, options.origin, attached.info),
        },
      },
    };

    const submission = await conversation.submit(
      requestId === undefined ? draft : { ...draft, requestId },
      BACKGROUND_CONTEXT,
    );

    return String(submission.id);
  }

  /** Data-only writes make exchanges visible without starting another model turn. */
  async recordBotMessage(
    agent: Agent,
    conversationId: string,
    event: BotMessageEvent,
    requestId: string,
  ) {
    const conversation = await (
      await this.open(agent)
    ).harness.conversation(
      localConversationId(agent.id, conversationId),
      BACKGROUND_CONTEXT,
    );

    if (!conversation) throw new Error("Conversation not found");
    await conversation.submit(
      {
        type: "write",
        requestId,
        entry: {
          kind: BOT_MESSAGE_ENTRY,
          data: { ...event, timestamp: Date.now() },
        },
      },
      BACKGROUND_CONTEXT,
    );
  }

  /** The bytes of an attached image, read back from the input entry that carries it. */
  async attachment(agent: Agent, entryId: string, index: number) {
    const record = await this.open(agent);

    try {
      return await readAttachment(record.harness, agent.id, entryId, index);
    } catch (error) {
      throw new NotFound({
        message:
          error instanceof Error ? error.message : "Attachment not found",
      });
    }
  }

  async wait(
    submissionId: string,
    agent: Agent,
    context: PiContext = BACKGROUND_CONTEXT,
  ) {
    const submission = await (
      await this.open(agent)
    ).harness.submission(numericId(submissionId), context);

    if (!submission) throw new Error("Submission not found");

    return submission.wait(context);
  }

  async snapshot(
    agent: Agent,
    conversationId: string,
    options: { limit?: number | undefined } = {},
  ): Promise<RuntimeSnapshot> {
    const { harness } = await this.open(agent);

    const conversation = await harness.conversation(
      localConversationId(agent.id, conversationId),
      BACKGROUND_CONTEXT,
    );

    if (!conversation) throw new Error("Conversation not found");
    // Read transcript before attaching the live view. A run may commit an
    // intermediate assistant entry while the view is being attached; the
    // active-run guard below then filters it from this snapshot.
    const transcript = await readTranscript(harness, agent.id, options);
    const view = await conversation.viewState(BACKGROUND_CONTEXT);

    try {
      // SAFETY: pi-durable owns this document key and serializes it as LiveState.
      const live = view.value.docs["pi.live"] as LiveState | undefined;

      const messages = await visibleMessages(
        harness,
        [conversation.id],
        transcript.messages,
      );

      return {
        conversationId,
        ...transcript,
        messages,
        live: publicLive(live),
        partial: "",
        usage: view.value.docs["pi.usage"],
        status: live?.run ? "running" : "idle",
        updatedAt: Date.now(),
      };
    } finally {
      view.dispose();
    }
  }

  async history(agent: Agent, options: HistoryOptions = {}) {
    const { harness } = await this.open(agent);

    return this.visible(harness, options, () =>
      readTranscript(harness, agent.id, options),
    );
  }

  /** The jobs of `kind` the bot started from its chat, oldest first; none for a bot that never ran one. */
  async jobs(agent: Agent, kind: JobKindName) {
    const { harness } = await this.open(agent);
    const root = await harness.root(BACKGROUND_CONTEXT);

    return (await JOB_READERS[kind].list(harness, root.id)).map((job) => ({
      name: job.name,
      conversationId: formatEntryId(agent.id, Number(job.conversationId)),
      status: job.status,
      ...(job.model && { model: job.model }),
      ...(job.usage && { usage: job.usage }),
      ...(job.question && { question: job.question }),
    }));
  }

  /** Sends an answer to a job's open question; false when the job no longer waits on it. */
  async answerJob(
    agent: Agent,
    kind: string,
    answer: { name: string; questionId: string; text: string; by?: string },
  ) {
    if (!isJobKind(kind)) return false;
    const { harness } = await this.open(agent);
    const root = await harness.root(BACKGROUND_CONTEXT);

    return JOB_READERS[kind].answer(harness, root.id, {
      agentId: agent.id,
      ...answer,
    });
  }

  /** What the jobs of every kind did for the chat turn answering `submissionId`; undefined when it touched none. */
  async turnWork(
    agent: Agent,
    submissionId: string,
  ): Promise<TurnWork | undefined> {
    const { harness } = await this.open(agent);
    const root = await harness.root(BACKGROUND_CONTEXT);

    return mergeTurnWork(
      (
        await Promise.all(
          Object.values(JOB_READERS).map((kind) =>
            kind.turnWork(harness, root.id, submissionId),
          ),
        )
      ).filter((work) => work !== undefined),
    );
  }

  /** One job's transcript, paged like the chat's. */
  async jobHistory(
    agent: Agent,
    kind: JobKindName,
    name: string,
    options: HistoryOptions = {},
  ) {
    const { harness } = await this.open(agent);
    const root = await harness.root(BACKGROUND_CONTEXT);

    const job = (await JOB_READERS[kind].list(harness, root.id)).find(
      (each) => each.name === name,
    );

    if (!job)
      throw new NotFound({
        message: `${jobKindTitle(JOB_KINDS[kind])} not found`,
      });

    return this.visible(
      harness,
      options,
      () =>
        readConversationTranscript(
          harness,
          agent.id,
          job.conversationId,
          options,
        ),
      false,
    );
  }

  /** `hideActive`: a chat streams its active turn separately; a job has no stream, so its finished steps show. */
  private async visible(
    harness: Harness,
    options: HistoryOptions,
    read: () => Promise<TranscriptPage>,
    hideActive = true,
  ) {
    try {
      const transcript = await read();

      if (options.includeActiveAssistant) return transcript;

      if (!hideActive)
        return {
          ...transcript,
          messages: hideIncompleteAssistant(transcript.messages),
        };

      const chats = await conversations(harness);

      return {
        ...transcript,
        messages: await visibleMessages(
          harness,
          chats.map((chat) => chat.id),
          transcript.messages,
        ),
      };
    } catch (error) {
      throw new InvalidInput({
        message:
          error instanceof Error ? error.message : "Invalid history cursor",
      });
    }
  }

  /** Assistant text answering one submission; later chat turns stay out of view. */
  async response(
    agent: Agent,
    conversationId: string,
    submissionId: string,
  ): Promise<string[]> {
    const turn = await this.settledTurn(agent, conversationId, submissionId);

    if (!turn) return [];

    return readResponse(turn.conversation, turn.entry);
  }

  async watch(
    agent: Agent,
    conversationId: string,
    callback: RuntimeWatch,
    options: { limit?: number | undefined } = {},
  ): Promise<() => Promise<void>> {
    const stream = await watchEvents(
      (await this.open(agent)).harness,
      localConversationId(agent.id, conversationId),
      BACKGROUND_CONTEXT,
    );

    try {
      await callback(await this.snapshot(agent, conversationId, options));
      stream.start(async () =>
        callback(await this.snapshot(agent, conversationId, options)),
      );

      return async () => {
        await stream.stop();
      };
    } catch (error) {
      await stream.stop();
      throw error;
    }
  }

  async abort(agent: Agent, conversationId: string): Promise<void> {
    const conversation = await (
      await this.open(agent)
    ).harness.conversation(
      localConversationId(agent.id, conversationId),
      BACKGROUND_CONTEXT,
    );

    await conversation?.abort(BACKGROUND_CONTEXT);
  }

  async deleteAgent(agentId: string): Promise<void> {
    const pending = this.records.get(agentId);
    this.records.delete(agentId);

    if (pending) await (await pending).harness.close(BACKGROUND_CONTEXT);

    for (const suffix of ["", "-wal", "-shm"])
      await rm(`${this.dataDir}/${agentId}.sqlite${suffix}`, { force: true });
  }

  async close(): Promise<void> {
    this.closed = true;
    const records = await Promise.allSettled(this.records.values());
    await Promise.all(
      records
        .filter((record) => record.status === "fulfilled")
        .map((record) => record.value.harness.close(BACKGROUND_CONTEXT)),
    );
    this.records.clear();
  }
}

/** The account's bots on Pi Durable, each with the memory, models and tools Crumble gives it. */
export class BotRuntime extends Context.Service<BotRuntime, AgentRuntime>()(
  "crumble/bots/BotRuntime",
) {
  /** Over `dataDir`'s harness files; `options` are what features outside the bots give every bot. */
  static layer(
    dataDir: string,
    options: Pick<RuntimeCallbacks, "taskExtensions" | "env">,
  ) {
    return Layer.effect(
      BotRuntime,
      Effect.gen(function* () {
        const agents = yield* AgentRepository;
        const settings = yield* SettingsRepository;
        const memory = yield* BotMemory;
        const extensions = yield* BotExtensions;
        const models = yield* ProviderModels;
        const skillLibrary = yield* BotSkills;

        return yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new AgentRuntime(dataDir, {
                ...options,
                models,
                skillLibrary,
                currentAgent: (agent) => Effect.runSync(agents.get(agent.id)),
                ownerTimezone: () => {
                  const timezone = Effect.runSync(settings.get(OWNER_TIMEZONE));

                  return Predicate.isString(timezone) ? timezone : undefined;
                },
                visionModel: () =>
                  Effect.runSync(
                    chosenVisionModel.pipe(
                      Effect.provideService(SettingsRepository, settings),
                    ),
                  ),
                extensions: (agent) => extensions.forAgent(agent),
                listMemory: (agentId) =>
                  Effect.runPromise(memory.list(agentId)),
                createMemory: (agentId, content, shared, context) =>
                  Effect.runPromise(
                    memory.create(agentId, content, shared, context),
                  ),
                updateMemory: (agentId, id, content, context) =>
                  Effect.runPromise(
                    memory.update(agentId, id, content, context),
                  ),
                deleteMemory: (agentId, id, context) =>
                  Effect.runPromise(memory.delete(agentId, id, context)),
              }),
          ),
          (runtime) => Effect.promise(() => runtime.close()),
        );
      }),
    );
  }
}
