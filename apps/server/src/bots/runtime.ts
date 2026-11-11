import { projectJobPage } from "./job-history";
import {
  BOT_MESSAGE_ENTRY,
  CALL_ENTRY,
  contentText,
  MESSAGE_ENTRY,
  type CallEventData,
} from "../transcript/entries";
import type { InputOrigin } from "../transcript/origins";
import {
  BACKGROUND_CONTEXT,
  type Context as PiContext,
} from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  type ConversationId,
  type DocumentReader,
  type Tx,
  defineExtension,
  type EnvTarget,
  type Extension,
  type LiveState,
  watchEvents,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
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
import { JOB_KINDS, jobKindTitle, type JobKindName } from "../shared/job-kinds";
import type { Agent } from "../contract/agents";
import {
  formatEntryId,
  localConversationId,
  parseEntryId,
  positiveId,
} from "../shared/entry-ids";
import { HarnessFiles } from "../shared/harness-files";
import { isCallOnly } from "../shared/chat-only";
import type { defineAnchorTask } from "../shared/anchor-task";
import { ProviderModels } from "../providers/providers";
import { BotMemory } from "../memory/bot-memory";
import { memoryExtension, type MemoryStore } from "../memory/memory-tool";
import { SettingsRepository } from "../shared/settings-repository";
import { AgentRepository } from "../bot-store/agent-repository";
import { BotExtensions } from "../bot-ports/bot-extensions";
import {
  CHAT_STYLE,
  type BotTool,
  type ConversationKind,
  type ConversationStyle,
} from "../bot-ports/conversation-kind";
import {
  clockInstructions,
  conversationInstructions,
  jobKnowledge,
} from "./prompts";
import { SkillReads, skillTool } from "../skills/skill-library";
import { BotSkills } from "../skills/skills";
import { skillManageTool } from "../skills/skill-manage";
import type { AttachmentInput } from "../shared/attachment-rules";
import { prepareAttachments } from "../shared/attachments";
import { BOT_TOOL } from "../contract/tools";
import {
  prepareReply,
  readAttachment,
  readResponse,
  readConversationTranscript,
  readTranscript,
  type BotMessageEvent,
  type PageOptions,
  type TranscriptMessage,
  type TranscriptPage,
} from "../transcript/transcript";
import { InvalidInput, NotFound } from "../shared/errors";
import {
  chosenVisionModel,
  describesImages,
  readsImages,
  visionExtension,
  type VisionModelRef,
} from "../vision/vision";

export const OWNER_TIMEZONE = "owner-timezone";

export type RuntimeCallbacks = MemoryStore & {
  models: Models;
  currentAgent: (agent: Agent) => Agent | null;
  ownerTimezone: () => string | undefined;
  skillLibrary: BotSkills["Service"];
  visionModel: () => VisionModelRef | undefined;
  extensions: (agent: Agent) => Extension[] | Promise<Extension[]>;
  jobExtensions: (agent: Agent) => Extension[] | Promise<Extension[]>;
  conversationKinds: () => ConversationKind[];
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

/**
 * Options for a chat snapshot. `partial` opts into the in-flight reply text, which snapshots hide by default. `own`
 * reads the given conversation's transcript; without it a snapshot reads the bot chat's, whatever conversation it is.
 */
export type SnapshotOptions = {
  limit?: number | undefined;
  partial?: boolean | undefined;
  own?: boolean | undefined;
};

export type RuntimeWatch = (snapshot: RuntimeSnapshot) => void | Promise<void>;

type HarnessRecord = {
  harness: Harness;
  models: Models;
  choices: { agent: Agent };
  memory: BotTool;
  skill: BotTool;
  skillManage: BotTool;
  memoryExtension: Extension;
  skillExtension: Extension;
  visionExtension: Extension;
  askAboutImage: BotTool;
  kinds: ConversationKind[];
  jobKnowledgeExtension: Extension;
  registry: ReturnType<typeof createRegistry>;
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
  origin?: InputOrigin;
  attachments?: Array<{ kind: string; [key: string]: JsonValue }>;
};

function entryMetadata(
  requestId: string | undefined,
  origin: InputOrigin | undefined,
  attachments: Array<{ kind: string; [key: string]: JsonValue }>,
) {
  const metadata: EntryMetadata = {};

  if (requestId) metadata.requestId = requestId;

  if (origin) metadata.origin = origin;

  if (attachments.length) metadata.attachments = attachments;

  return metadata;
}

export type PreparedInput = {
  modelContent: string;
  data: Record<string, JsonValue>;
};

type HistoryOptions = PageOptions & {
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
 * What clients may show of the bot's chat. A model can commit a tool-calling assistant entry before its tool round
 * completes, so assistant entries after an active input stay hidden until the run settles and no text segment leaks
 * mid-turn. Entry IDs are global across the bot's conversations, so only inputs of its chat count.
 */
async function visibleMessages(
  harness: Harness,
  chat: ConversationId,
  messages: TranscriptMessage[],
) {
  const { submissions } = await harness.inspect(BACKGROUND_CONTEXT);

  const cutoffs = submissions.flatMap((submission) =>
    submission.type === "input" &&
    submission.status === "placed" &&
    submission.conversationId === chat
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

const JOB_READERS: Record<JobKindName, JobKind> = {
  coding: defineJobKind(JOB_KINDS.coding),
  desktop: defineJobKind(JOB_KINDS.desktop),
};

const isJobKind = (kind: string): kind is JobKindName =>
  Object.hasOwn(JOB_READERS, kind);

function numericId(value: string): never {
  const id = positiveId(value);

  if (id === undefined) throw new Error("Invalid durable record ID");

  // SAFETY: validated decimal IDs are branded by pi-durable at this boundary.
  return id as never;
}

async function styleOf(
  kinds: ConversationKind[],
  reader: DocumentReader,
  conversationId: ConversationId,
  context: PiContext,
): Promise<ConversationStyle> {
  for (const kind of kinds) {
    const style = await kind.recognize(reader, conversationId, context);

    if (style) return style;
  }

  return CHAT_STYLE;
}

async function ensureModel(
  models: Models,
  choice: Pick<Agent, "provider" | "model">,
) {
  if (!models.getModel(choice.provider, choice.model))
    await models.refresh({ providers: [choice.provider] });
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

function modelToolsOf(tools: BotTool[]) {
  if (!tools.some((tool) => tool.name === CODEMODE_TOOL_NAME)) return tools;

  return tools.filter(
    (tool) => tool.callers !== undefined && !tool.callers.includes("tools"),
  );
}

async function ensureAgentModels(models: Models, agent: Agent) {
  // Dynamic catalogs (Melious) list models only after a refresh with the saved key.
  await ensureModel(models, agent);

  // The desktop job model may come from another provider with a dynamic catalog.
  if (agent.desktopModel) await ensureModel(models, agent.desktopModel);
}

export class AgentRuntime {
  private readonly skillReads = new SkillReads();
  private readonly records: HarnessFiles<HarnessRecord>;
  constructor(
    dataDir: string,
    private readonly callbacks: RuntimeCallbacks,
  ) {
    this.records = new HarnessFiles(dataDir, "Runtime is closed");
  }

  private open(agent: Agent) {
    return this.records.get(agent.id, (storage) =>
      this.openRecord(agent, storage),
    );
  }

  async documents(agent: Agent) {
    return (await this.open(agent)).harness;
  }

  private skillTools(agent: Agent) {
    const currentAgent = () => {
      const current = this.callbacks.currentAgent(agent);

      if (!current?.enabled)
        throw new Error("Skill access is disabled for this bot");

      return current;
    };

    const library = this.callbacks.skillLibrary;

    const skill = skillTool({
      skills: async () => Effect.runPromise(library.available(currentAgent())),
      used: async (loaded, runKey) => {
        this.skillReads.mark(runKey, loaded.id);
        await Effect.runPromise(library.used(loaded));
      },
    });

    const skillManage = skillManageTool({
      library,
      reads: this.skillReads,
      agent: currentAgent,
    });

    return { skill, skillManage };
  }

  private async extensionsOf(agent: Agent) {
    const next = await this.callbacks.extensions(agent);

    const installed = [...next, ...(await this.callbacks.jobExtensions(agent))];

    return { next, installed };
  }

  private toolExtensions(agent: Agent) {
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

    registry.install(memoryTools);
    registry.install(skillExtension);

    return {
      memory,
      skill,
      skillManage,
      memoryExtension: memoryTools,
      skillExtension,
      registry,
    };
  }

  private jobKnowledgeExtensionOf(
    skill: BotTool,
    choices: HarnessRecord["choices"],
  ) {
    return defineExtension({
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
  }

  private openHarness(
    storage: Parameters<typeof Harness.open>[0],
    parts: Pick<HarnessRecord, "registry" | "kinds" | "choices">,
  ) {
    const { registry, kinds, choices } = parts;
    const configuredModels = inferenceModels(this.callbacks.models, choices);

    return Harness.open(
      storage,
      {
        models: configuredModels,
        registry,
        env: async (target, context) =>
          (await styleOf(kinds, target.read, target.conversationId, context))
            .noEnvironment
            ? undefined
            : this.callbacks.env(choices.agent, target, context),
      },
      BACKGROUND_CONTEXT,
    );
  }

  private async openRecord(
    agent: Agent,
    storage: Parameters<typeof Harness.open>[0],
  ): Promise<HarnessRecord> {
    const { models } = this.callbacks;
    const tools = this.toolExtensions(agent);
    const { registry } = tools;

    // Hooks and tools run only once the harness is open; until then nothing calls them.
    let opened: Harness | undefined;

    const vision = visionExtension({
      harness: () => opened,
      visionModel: () => this.callbacks.visionModel(),
    });

    registry.install(vision.extension);
    const kinds = this.callbacks.conversationKinds();

    for (const kind of kinds) registry.install(kind.extension);
    const choices = { agent };

    const jobKnowledgeExtension = this.jobKnowledgeExtensionOf(
      tools.skill,
      choices,
    );

    registry.install(jobKnowledgeExtension);

    const { installed: extensions } = await this.extensionsOf(agent);

    for (const extension of extensions) registry.install(extension);

    const harness = await this.openHarness(storage, {
      registry,
      kinds,
      choices,
    });

    opened = harness;

    if (agent.enabled) harness.resume();

    return {
      ...tools,
      harness,
      models,
      choices,
      visionExtension: vision.extension,
      askAboutImage: vision.ask,
      jobKnowledgeExtension,
      kinds,
      extensions,
    };
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

  private async availableSkills(agent: Agent) {
    return Effect.runPromise(this.callbacks.skillLibrary.available(agent));
  }

  private conversationParts(
    record: HarnessRecord,
    agent: Agent,
    skillCount: number,
    offered: Extension[],
  ) {
    return {
      memory: agent.tools.includes(BOT_TOOL.memory) ? [record.memory] : [],
      skill: skillCount > 0 ? [record.skill] : [],
      skillManage: record.skillManage,
      vision: this.describesImagesFor(record, agent)
        ? [record.askAboutImage]
        : [],
      memoryExtension: record.memoryExtension,
      skillExtension: record.skillExtension,
      visionExtension: record.visionExtension,
      offered,
    };
  }

  private async styleFor(
    record: HarnessRecord,
    agent: Agent,
    localId: ConversationId,
  ) {
    const style = await styleOf(
      record.kinds,
      record.harness,
      localId,
      BACKGROUND_CONTEXT,
    );

    const model = style.model?.(agent);

    if (model) await ensureModel(record.models, model);

    return { style, model };
  }

  private async configure(
    record: HarnessRecord,
    agent: Agent,
    conversationId: string,
  ) {
    record.choices.agent = agent;

    await ensureAgentModels(record.models, agent);
    const offered = await this.installExtensions(record, agent);

    const localId = localConversationId(agent.id, conversationId);
    const { style, model } = await this.styleFor(record, agent, localId);
    const skills = await this.availableSkills(agent);

    const parts = this.conversationParts(record, agent, skills.length, offered);

    const tools = style.tools(parts);

    const conversation = await record.harness.conversation(
      localId,
      BACKGROUND_CONTEXT,
    );

    if (!conversation) throw new Error("Conversation not found");
    const memory = await this.callbacks.listMemory(agent.id);
    const clock = clockInstructions(this.callbacks.ownerTimezone);

    await conversation.configure(
      {
        model: modelRef(model ?? agent),
        thinkingLevel: agent.inference?.thinkingLevel ?? "off",
        extensions: style.extensions?.(parts) ?? {
          remove: [record.jobKnowledgeExtension, ...offered.filter(isCallOnly)],
        },
        instructions: conversationInstructions(
          agent,
          skills,
          memory,
          style.prompt ?? {},
          clock,
        ),
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

  async openAnchored(
    agent: Agent,
    anchor: ReturnType<typeof defineAnchorTask>,
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

  async contextWindow(agent: Agent, choice: Pick<Agent, "provider" | "model">) {
    const { models } = await this.open(agent);
    await ensureModel(models, choice);

    return models.getModel(choice.provider, choice.model)?.contextWindow;
  }

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

  private describesImagesFor(record: HarnessRecord, agent: Agent) {
    return describesImages(
      this.callbacks.visionModel(),
      record.models.getModel(agent.provider, agent.model),
    );
  }

  async acceptsImages(agent: Agent) {
    const { models } = await this.open(agent);
    await ensureModel(models, agent);

    return (
      readsImages(models.getModel(agent.provider, agent.model)) ||
      this.callbacks.visionModel() !== undefined
    );
  }

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

  async prepareInput(
    agent: Agent,
    text: string,
    replyTo: string | undefined,
  ): Promise<PreparedInput> {
    if (!replyTo) return { modelContent: text, data: { text } };
    const { harness } = await this.open(agent);

    return prepareReply(harness, agent.id, replyTo, text);
  }

  async submit(
    agent: Agent,
    conversationId: string,
    text: string,
    requestId?: string,
    options: {
      input?: PreparedInput | undefined;
      origin?: InputOrigin;
      attachments?: AttachmentInput[] | undefined;
    } = {},
  ): Promise<string> {
    const record = await this.open(agent);
    const attached = prepareAttachments(options.attachments ?? []);
    const prepared = options.input ?? { modelContent: text, data: { text } };
    const conversation = await this.configure(record, agent, conversationId);
    const model = record.models.getModel(agent.provider, agent.model);

    assertImageSupport(
      agent,
      model,
      attached.info,
      this.callbacks.visionModel(),
    );

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

  async recordBotMessage(
    agent: Agent,
    conversationId: string,
    event: BotMessageEvent,
    requestId: string,
  ) {
    await this.record(agent, conversationId, requestId, {
      kind: BOT_MESSAGE_ENTRY,
      data: { ...event, timestamp: Date.now() },
    });
  }

  async recordCallEvent(
    agent: Agent,
    conversationId: string,
    event: CallEventData,
    requestId: string,
  ) {
    await this.record(agent, conversationId, requestId, {
      kind: CALL_ENTRY,
      data: { ...event, timestamp: Date.now() },
    });
  }

  /** A data-only entry: the model never sees it, and it lands at once, even mid-turn. */
  private async record(
    agent: Agent,
    conversationId: string,
    requestId: string,
    entry: { kind: string; data: JsonValue },
  ) {
    const conversation = await (
      await this.open(agent)
    ).harness.conversation(
      localConversationId(agent.id, conversationId),
      BACKGROUND_CONTEXT,
    );

    if (!conversation) throw new Error("Conversation not found");
    await conversation.submit(
      { type: "write", requestId, entry },
      BACKGROUND_CONTEXT,
    );
  }

  async attachment(agent: Agent, entryId: string, index: number) {
    const { harness } = await this.open(agent);

    return readAttachment(harness, agent.id, entryId, index);
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
    options: SnapshotOptions = {},
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
    const transcript = options.own
      ? await readConversationTranscript(
          harness,
          agent.id,
          conversation.id,
          options,
        )
      : await readTranscript(harness, agent.id, options);

    const view = await conversation.viewState(BACKGROUND_CONTEXT);

    try {
      // SAFETY: pi-durable owns this document key and serializes it as LiveState.
      const live = view.value.docs["pi.live"] as LiveState | undefined;

      const messages = await visibleMessages(
        harness,
        conversation.id,
        transcript.messages,
      );

      return {
        conversationId,
        ...transcript,
        messages,
        live: publicLive(live),
        partial: options.partial
          ? contentText(live?.generation?.message?.content)
          : "",
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

    const page = await this.visible(
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

    return projectJobPage(page, options.before, (before) =>
      this.visible(
        harness,
        {},
        () =>
          readConversationTranscript(harness, agent.id, job.conversationId, {
            limit: 200,
            before,
          }),
        false,
      ),
    );
  }

  /** A conversation's own transcript, such as an outside call's, with unfinished assistant entries hidden. */
  async conversationHistory(
    agent: Agent,
    conversationId: string,
    options: HistoryOptions = {},
  ) {
    const { harness } = await this.open(agent);

    return this.visible(
      harness,
      options,
      () =>
        readConversationTranscript(
          harness,
          agent.id,
          localConversationId(agent.id, conversationId),
          options,
        ),
      false,
    );
  }

  private async visible(
    harness: Harness,
    options: HistoryOptions,
    read: () => Promise<TranscriptPage>,
    hideActive = true,
  ) {
    const transcript = await read();

    if (options.includeActiveAssistant) return transcript;

    if (!hideActive)
      return {
        ...transcript,
        messages: hideIncompleteAssistant(transcript.messages),
      };

    const chat = await harness.root(BACKGROUND_CONTEXT);

    return {
      ...transcript,
      messages: await visibleMessages(harness, chat.id, transcript.messages),
    };
  }

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
    options: SnapshotOptions = {},
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

  deleteAgent(agentId: string) {
    return this.records.delete(agentId);
  }

  close() {
    return this.records.close();
  }
}

export class BotRuntime extends Context.Service<BotRuntime, AgentRuntime>()(
  "crumble/bots/BotRuntime",
) {
  static layer(
    dataDir: string,
    options: Pick<
      RuntimeCallbacks,
      "jobExtensions" | "conversationKinds" | "env"
    >,
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
