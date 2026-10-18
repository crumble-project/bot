import {
  BACKGROUND_CONTEXT,
  type Context,
} from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { Type, type Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { rm } from "node:fs/promises";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
  type LiveState,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { AppError, type Agent } from "./domain";
import { meliousProvider } from "./providers";
import { prepareAttachments, type AttachmentInput } from "./attachments";
import {
  prepareReply,
  readAttachment,
  readResponse,
  readTranscript,
  type MessageOrigin,
  type BotMessageEvent,
  type TranscriptMessage,
} from "./transcript";

export type MemoryRecord = {
  id: string;
  content: string;
  /** Shared memories are also seen by the other bots that use shared memory. */
  shared?: boolean;
  createdAt?: string;
  updatedAt?: string;
};
export type RuntimeCallbacks = {
  models?:
    | Models
    | ((agent: Agent, credentials?: unknown) => Models | Promise<Models>);
  credentials?: (
    provider: Agent["provider"],
  ) => string | undefined | Promise<string | undefined>;
  currentAgent?: (agentId: string) => Agent | null;
  listMemory?: (agentId: string) => MemoryRecord[] | Promise<MemoryRecord[]>;
  createMemory?: (
    agentId: string,
    content: string,
    shared: boolean,
  ) => MemoryRecord | Promise<MemoryRecord>;
  updateMemory?: (
    agentId: string,
    id: string,
    content: string,
  ) => MemoryRecord | Promise<MemoryRecord>;
  deleteMemory?: (agentId: string, id: string) => void | Promise<void>;
  /** Shared skills from the library the agent uses, added after its own skills. */
  sharedSkills?: (agent: Agent) => Agent["skills"];
  /** Repository-backed skills applied to every agent before shared and personal skills. */
  commonSkills?: () => Agent["skills"];
  extensions?: (agent: Agent) => Extension[] | Promise<Extension[]>;
};
export type RuntimeMessage = TranscriptMessage;
export type RuntimeSnapshot = {
  conversationId: string;
  messages: RuntimeMessage[];
  live: unknown;
  partial: string;
  usage: unknown;
  hasMore: boolean;
  oldestEntryId: string | null;
  status: "idle" | "running" | "failed";
  updatedAt: number;
};
export type RuntimeWatch = (snapshot: RuntimeSnapshot) => void | Promise<void>;
type HarnessRecord = {
  harness: Harness;
  models: Models;
  choices: { agent: Agent };
  memory: ReturnType<typeof defineTool>;
  registry: ReturnType<typeof createRegistry>;
  extensions: Extension[];
};

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

// The owner wants plain replies; memory and tool use stay behind the scenes.
const MEMORY_GUIDANCE =
  "Use your persistent memory and tools silently. Do not mention your memory, what it contains, or that you loaded or checked it unless the owner asks. The memory below is already loaded; do not call the memory tool just to read it.";

export const conversationReference = (agentId: string, localId: number) =>
  `${agentId}:${localId}`;
function numericId(value: string): never {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Invalid durable record ID");
  return Number(value) as never;
}
function localConversationId(agentId: string, reference: string): never {
  const prefix = `${agentId}:`;
  if (!reference.startsWith(prefix))
    throw new Error("Conversation belongs to a different agent");
  return numericId(reference.slice(prefix.length));
}

/** Dynamic reads let a newly saved or rotated API key take effect without restarting agents. */
export function providerModels(credentials?: RuntimeCallbacks["credentials"]) {
  const models = builtinModels({
    credentials: {
      read: async (providerId) => {
        const key = await credentials?.(providerId as Agent["provider"]);
        return key ? { type: "api_key" as const, key } : undefined;
      },
      list: async () => [],
      modify: async () => {
        throw new Error(
          "Provider credentials are managed through Crumble settings",
        );
      },
      delete: async () => {
        throw new Error(
          "Provider credentials are managed through Crumble settings",
        );
      },
    },
  });
  models.setProvider(meliousProvider());
  return models;
}

export class AgentRuntime {
  private readonly records = new Map<string, Promise<HarnessRecord>>();
  private closed = false;
  constructor(
    private readonly dataDir: string,
    private readonly callbacks: RuntimeCallbacks = {},
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

  private async openRecord(agent: Agent): Promise<HarnessRecord> {
    const storage = await openNodeSqliteStorage(
      `${this.dataDir}/${agent.id}.sqlite`,
    );
    try {
      const models =
        typeof this.callbacks.models === "function"
          ? await this.callbacks.models(
              agent,
              await this.callbacks.credentials?.(agent.provider),
            )
          : (this.callbacks.models ??
            providerModels(this.callbacks.credentials));
      const memory = defineTool({
        name: "memory",
        description:
          "Read and manage this agent’s persistent memory. When the agent uses shared memory, `list` also returns shared memories (marked `shared`), which other agents see too; create one with `shared: true` only for what every agent should know.",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("list"),
            Type.Literal("create"),
            Type.Literal("update"),
            Type.Literal("delete"),
          ]),
          id: Type.Optional(Type.String({ minLength: 1 })),
          content: Type.Optional(
            Type.String({ minLength: 1, maxLength: 32000 }),
          ),
          shared: Type.Optional(Type.Boolean()),
        }),
        // Writes are not replay-safe: interrupted calls report an interruption instead of duplicating a memory.
        replay: "unsafe",
        execute: async (args) => {
          const current = this.callbacks.currentAgent
            ? this.callbacks.currentAgent(agent.id)
            : agent;
          if (!current?.enabled || !current.tools.includes("memory"))
            throw new Error("Memory access is disabled for this agent");
          let result: unknown;
          if (args.action === "list")
            result = (await this.callbacks.listMemory?.(agent.id)) ?? [];
          else if (args.action === "create") {
            if (!args.content?.trim() || !this.callbacks.createMemory)
              throw new Error("Memory content is required");
            result = await this.callbacks.createMemory(
              agent.id,
              args.content,
              args.shared === true,
            );
          } else if (args.action === "update") {
            if (
              !args.id ||
              !args.content?.trim() ||
              !this.callbacks.updateMemory
            )
              throw new Error("Memory ID and content are required");
            result = await this.callbacks.updateMemory(
              agent.id,
              args.id,
              args.content,
            );
          } else {
            if (!args.id || !this.callbacks.deleteMemory)
              throw new Error("Memory ID is required");
            await this.callbacks.deleteMemory(agent.id, args.id);
            result = { deleted: true };
          }
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      });
      const registry = createRegistry();
      registry.install(defineExtension({ name: "memory", tools: [memory] }));
      const extensions = (await this.callbacks.extensions?.(agent)) ?? [];
      for (const extension of extensions) registry.install(extension);
      const choices = { agent };
      const configuredModels = new Proxy(models, {
        get(target, property) {
          if (property === "streamSimple")
            return (...args: Parameters<Models["streamSimple"]>) => {
              const inference = choices.agent.inference;
              return target.streamSimple(args[0], args[1], {
                ...args[2],
                ...(inference?.temperature !== undefined
                  ? { temperature: inference.temperature }
                  : {}),
                ...(inference?.maxOutputTokens !== undefined
                  ? { maxTokens: inference.maxOutputTokens }
                  : {}),
              });
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const harness = await Harness.open(
        storage,
        { models: configuredModels, registry },
        BACKGROUND_CONTEXT,
      );
      if (agent.enabled) harness.resume();
      return { harness, models, choices, memory, registry, extensions };
    } catch (error) {
      await storage.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  private async configure(
    record: HarnessRecord,
    agent: Agent,
    conversationId: string,
  ) {
    record.choices.agent = agent;
    // Dynamic catalogs (Melious) list models only after a refresh with the saved key.
    if (!record.models.getModel(agent.provider, agent.model))
      await record.models.refresh({ providers: [agent.provider] });
    const next = (await this.callbacks.extensions?.(agent)) ?? [];
    for (const previous of record.extensions)
      if (!next.some((extension) => extension.name === previous.name))
        record.registry.uninstall(previous);
    for (const extension of next) record.registry.install(extension);
    record.extensions = next;
    const tools = [
      ...(agent.tools.includes("memory") ? [record.memory] : []),
      ...next.flatMap((extension) => extension.tools ?? []),
    ];
    // With code mode the model writes one script that calls the other tools, instead of calling them itself.
    const codemode = tools.find((tool) => tool.name === CODEMODE_TOOL_NAME);
    const conversation = await record.harness.conversation(
      localConversationId(agent.id, conversationId),
      BACKGROUND_CONTEXT,
    );
    if (!conversation) throw new Error("Conversation not found");
    const memory = (await this.callbacks.listMemory?.(agent.id)) ?? [];
    const lines = (items: MemoryRecord[]) =>
      items.map((item) => `- ${item.content}`).join("\n");
    const shared = memory.filter((item) => item.shared);
    const skills = [
      ...(this.callbacks.commonSkills?.() ?? []),
      ...(this.callbacks.sharedSkills?.(agent) ?? []),
      ...agent.skills,
    ];
    const now = new Date();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const clock = `Current server time (UTC): ${now.toISOString()}\nServer timezone: ${timezone}\nServer local time: ${now.toLocaleString("sv-SE", { timeZone: timezone, hour12: false })}\nUse this fresh clock for dates and relative times. The owner's timezone may differ from the server or external tools; use their known timezone, or ask if it is unknown. For one-time schedules, runAt must include Z (UTC) or an explicit offset such as +02:00. The timezone field controls recurring cron schedules; it does not reinterpret a one-time runAt timestamp.`;
    await conversation.configure(
      {
        model: { provider: agent.provider, modelId: agent.model },
        thinkingLevel: agent.inference?.thinkingLevel ?? "off",
        instructions: `${agent.instructions}${skills.map((skill) => `\n\n## ${skill.name}\n${skill.instructions}`).join("")}\n\n${clock}\n\n${MEMORY_GUIDANCE}\n\nPersistent memory:\n${lines(memory.filter((item) => !item.shared))}${shared.length ? `\n\nShared memory (other agents see it too):\n${lines(shared)}` : ""}`,
        tools,
        modelTools: codemode ? [codemode] : tools,
      },
      BACKGROUND_CONTEXT,
    );
    return conversation;
  }

  async createConversation(agent: Agent): Promise<string> {
    const record = await this.open(agent);
    const conversation = await record.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    const reference = conversationReference(agent.id, conversation.id);
    await this.configure(record, agent, reference);
    return reference;
  }

  async openChat(agent: Agent): Promise<string> {
    const record = await this.open(agent);
    const root = await record.harness.root(BACKGROUND_CONTEXT);
    const reference = conversationReference(agent.id, Number(root.id));
    await this.configure(record, agent, reference);
    return reference;
  }

  async compact(agent: Agent, conversationId: string): Promise<string> {
    const conversation = await this.configure(
      await this.open(agent),
      agent,
      conversationId,
    );
    return String(await conversation.compact(undefined, BACKGROUND_CONTEXT));
  }

  async submit(
    agent: Agent,
    conversationId: string,
    text: string,
    requestId?: string,
    options: {
      replyTo?: string;
      origin?: MessageOrigin;
      attachments?: AttachmentInput[];
    } = {},
  ): Promise<string> {
    const record = await this.open(agent);
    const attached = prepareAttachments(options.attachments ?? []);
    let prepared: { modelContent: string; data: Record<string, JsonValue> } = {
      modelContent: text,
      data: { text },
    };
    if (options.replyTo)
      try {
        prepared = await prepareReply(
          record.harness,
          agent.id,
          options.replyTo,
          text,
        );
      } catch (error) {
        throw new AppError(
          400,
          error instanceof Error ? error.message : "Invalid reply target",
        );
      }
    const conversation = await this.configure(record, agent, conversationId);
    const model = record.models.getModel(agent.provider, agent.model);
    // Catalogs that list no modalities are trusted; the provider reports anything it refuses.
    if (
      attached.info.some((item) => item.kind === "image") &&
      model?.input &&
      !model.input.includes("image")
    )
      throw new AppError(
        400,
        `${agent.model} can't read images. Choose a model that accepts images in the agent's profile.`,
      );
    if (options.origin?.kind === "bot") {
      prepared.modelContent = `Message from bot ${JSON.stringify(options.origin.name ?? "Another bot")} (${options.origin.agentId ?? "unknown"}):\n\n${prepared.modelContent}\n\nReply to this bot's message. Your answer will be returned to the requesting bot.`;
    }
    const content = attached.blocks.length
      ? [
          ...(prepared.modelContent.trim()
            ? [{ type: "text" as const, text: prepared.modelContent }]
            : []),
          ...attached.blocks,
        ]
      : prepared.modelContent;
    const submission = await conversation.submit(
      {
        type: "input",
        content,
        requestId,
        entry: {
          kind: "crumble.message",
          data: {
            ...prepared.data,
            ...(requestId ? { requestId } : {}),
            ...(options.origin ? { origin: options.origin } : {}),
            ...(attached.info.length ? { attachments: attached.info } : {}),
          },
        },
      },
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
          kind: "crumble.bot-message",
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
      throw new AppError(
        404,
        error instanceof Error ? error.message : "Attachment not found",
      );
    }
  }

  async wait(
    submissionId: string,
    agent: Agent,
    context: Context = BACKGROUND_CONTEXT,
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
    options: { limit?: number } = {},
  ): Promise<RuntimeSnapshot> {
    const { harness } = await this.open(agent);
    const conversation = await harness.conversation(
      localConversationId(agent.id, conversationId),
      BACKGROUND_CONTEXT,
    );
    if (!conversation) throw new Error("Conversation not found");
    const view = await conversation.viewState(BACKGROUND_CONTEXT);
    try {
      const live = view.value.docs["pi.live"] as unknown as
        LiveState | undefined;
      return {
        conversationId,
        ...(await readTranscript(harness, agent.id, options)),
        live,
        partial: contentText(live?.generation?.message?.content),
        usage: view.value.docs["pi.usage"],
        status: live?.run ? "running" : "idle",
        updatedAt: Date.now(),
      };
    } finally {
      view.dispose();
    }
  }

  async history(
    agent: Agent,
    options: { before?: string; limit?: number } = {},
  ) {
    try {
      return await readTranscript(
        (await this.open(agent)).harness,
        agent.id,
        options,
      );
    } catch (error) {
      throw new AppError(
        400,
        error instanceof Error ? error.message : "Invalid history cursor",
      );
    }
  }

  /** Assistant text answering one submission; later chat turns stay out of view. */
  async response(
    agent: Agent,
    conversationId: string,
    submissionId: string,
  ): Promise<string[]> {
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
    if (!status?.entry || !conversation) return [];
    return readResponse(conversation, Number(status.entry));
  }

  async watch(
    agent: Agent,
    conversationId: string,
    callback: RuntimeWatch,
    options: { limit?: number } = {},
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
