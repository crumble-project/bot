import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
import type { Agent } from "./domain";

export type MemoryRecord = {
  id: string;
  content: string;
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
  ) => MemoryRecord | Promise<MemoryRecord>;
  updateMemory?: (
    agentId: string,
    id: string,
    content: string,
  ) => MemoryRecord | Promise<MemoryRecord>;
  deleteMemory?: (agentId: string, id: string) => void | Promise<void>;
  extensions?: (agent: Agent) => Extension[] | Promise<Extension[]>;
};
export type RuntimeMessage = {
  role: string;
  content: string;
  blocks?: unknown;
  entryId?: string;
  timestamp?: number;
};
export type RuntimeSnapshot = {
  conversationId: string;
  messages: RuntimeMessage[];
  live: unknown;
  partial: string;
  usage: unknown;
  status: "idle" | "running" | "failed";
  updatedAt: number;
};
export type RuntimeWatch = (snapshot: RuntimeSnapshot) => void | Promise<void>;
type HarnessRecord = {
  harness: Harness;
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
        description: "Read and manage this agent’s persistent memory.",
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
            result = await this.callbacks.createMemory(agent.id, args.content);
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
      return { harness, choices, memory, registry, extensions };
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
    const conversation = await record.harness.conversation(
      localConversationId(agent.id, conversationId),
      BACKGROUND_CONTEXT,
    );
    if (!conversation) throw new Error("Conversation not found");
    const memory = (await this.callbacks.listMemory?.(agent.id)) ?? [];
    await conversation.configure(
      {
        model: { provider: agent.provider, modelId: agent.model },
        thinkingLevel: agent.inference?.thinkingLevel ?? "off",
        instructions: `${agent.instructions}${agent.skills.map((skill) => `\n\n## ${skill.name}\n${skill.instructions}`).join("")}\n\nPersistent memory:\n${memory.map((item) => `- ${item.content}`).join("\n")}`,
        tools,
        modelTools: tools,
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

  async submit(
    agent: Agent,
    conversationId: string,
    text: string,
    requestId?: string,
  ): Promise<string> {
    const conversation = await this.configure(
      await this.open(agent),
      agent,
      conversationId,
    );
    return String(
      (
        await conversation.submit(
          { type: "input", content: text, requestId },
          BACKGROUND_CONTEXT,
        )
      ).id,
    );
  }

  async wait(submissionId: string, agent: Agent) {
    const submission = await (
      await this.open(agent)
    ).harness.submission(numericId(submissionId), BACKGROUND_CONTEXT);
    if (!submission) throw new Error("Submission not found");
    return submission.wait(BACKGROUND_CONTEXT);
  }

  async snapshot(
    agent: Agent,
    conversationId: string,
  ): Promise<RuntimeSnapshot> {
    const conversation = await (
      await this.open(agent)
    ).harness.conversation(
      localConversationId(agent.id, conversationId),
      BACKGROUND_CONTEXT,
    );
    if (!conversation) throw new Error("Conversation not found");
    const view = await conversation.viewState(BACKGROUND_CONTEXT);
    try {
      const messages: RuntimeMessage[] = [];
      for (const entry of view.value.entries)
        for (const message of entry.model ?? [])
          messages.push({
            role: message.role,
            content: contentText(message.content),
            blocks: message.content,
            entryId: String(entry.id),
          });
      const live = view.value.docs["pi.live"] as unknown as
        LiveState | undefined;
      return {
        conversationId,
        messages,
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

  async watch(
    agent: Agent,
    conversationId: string,
    callback: RuntimeWatch,
  ): Promise<() => Promise<void>> {
    const stream = await watchEvents(
      (await this.open(agent)).harness,
      localConversationId(agent.id, conversationId),
      BACKGROUND_CONTEXT,
    );
    try {
      await callback(await this.snapshot(agent, conversationId));
      stream.start(async () =>
        callback(await this.snapshot(agent, conversationId)),
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
