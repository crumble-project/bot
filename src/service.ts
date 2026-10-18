import { Store } from "./store";
import { AgentRuntime } from "./runtime";
import {
  AppError,
  type Agent,
  type Conversation,
  type Execution,
} from "./domain";
import {
  latestMessagePreview,
  type BotMessageEvent,
  type MessageOrigin,
} from "./transcript";
import {
  attachmentDigest,
  prepareAttachments,
  type AttachmentInput,
} from "./attachments";

export const delegationRequest = (sourceAgentId: string, taskId: string) =>
  `delegate:${sourceAgentId}:${taskId}`;

/** A finished reply anywhere on the server, for clients that notify their owner. */
export type ReplyActivity = {
  type: "reply";
  agentId: string;
  agentName: string;
  entryId: string | null;
  origin: string;
  preview: string;
};
export type ChatPreviewActivity = {
  type: "chat-preview";
  agentId: string;
  agentName: string;
  lastMessage: string;
};

export class CrumbleService {
  private monitoring = new Map<string, Promise<void>>();
  private closing = false;
  private listeners = new Map<string, Set<() => void>>();
  private activityListeners = new Set<
    (event: ReplyActivity | ChatPreviewActivity) => void
  >();
  private chatOpening = new Map<string, Promise<Conversation>>();
  constructor(
    readonly store: Store,
    readonly runtime: AgentRuntime,
  ) {}

  agent(id: string): Agent {
    const agent = this.store.getAgent(id);
    if (!agent) throw new AppError(404, "Agent not found");
    return agent;
  }

  conversation(id: string) {
    const conversation = this.store.getConversation(id);
    if (!conversation || conversation.archived)
      throw new AppError(404, "Conversation not found");
    return { conversation, agent: this.agent(conversation.agentId) };
  }

  subscribe(conversationId: string, callback: () => void) {
    const listeners = this.listeners.get(conversationId) ?? new Set();
    listeners.add(callback);
    this.listeners.set(conversationId, listeners);
    return () => {
      listeners.delete(callback);
      if (!listeners.size) this.listeners.delete(conversationId);
    };
  }

  onActivity(callback: (event: ReplyActivity | ChatPreviewActivity) => void) {
    this.activityListeners.add(callback);
    return () => {
      this.activityListeners.delete(callback);
    };
  }

  /** Reads existing durable history for sidebar summaries without creating a chat. */
  async agentPreviews() {
    return Promise.all(
      this.store.listAgents().map(async (agent) => {
        const conversation = this.store.listConversations(agent.id, true)[0];
        if (!conversation) return { agent, lastMessage: "" };
        const history = await this.runtime.history(agent, { limit: 200 });
        return { agent, lastMessage: latestMessagePreview(history.messages) };
      }),
    );
  }

  private async announcePreview(agentId: string, conversationId: string) {
    if (!this.activityListeners.size) return;
    const agent = this.store.getAgent(agentId);
    if (!agent) return;
    const { messages } = await this.snapshot(conversationId);
    const lastMessage = latestMessagePreview(messages);
    const event: ChatPreviewActivity = {
      type: "chat-preview",
      agentId: agent.id,
      agentName: agent.name,
      lastMessage,
    };
    for (const listener of this.activityListeners) listener(event);
  }

  /** Tells activity listeners which bot answered and how its reply begins. */
  private async announceReply(execution: Execution) {
    if (!this.activityListeners.size) return;
    const agent = this.store.getAgent(execution.agentId);
    if (!agent) return;
    const { messages } = await this.snapshot(execution.conversationId);
    const lastMessage = latestMessagePreview(messages);
    for (const listener of this.activityListeners)
      listener({
        type: "chat-preview",
        agentId: agent.id,
        agentName: agent.name,
        lastMessage,
      });
    const reply = messages.findLast(
      (message) => message.role === "assistant" && message.content.trim(),
    );
    const event: ReplyActivity = {
      type: "reply",
      agentId: agent.id,
      agentName: agent.name,
      entryId: reply?.entryId ?? null,
      origin: this.origin(execution).kind,
      preview: reply?.content.trim().slice(0, 240) ?? "",
    };
    for (const listener of this.activityListeners) listener(event);
  }

  private changed(conversationId: string) {
    for (const listener of this.listeners.get(conversationId) ?? []) listener();
  }

  async snapshot(conversationId: string) {
    const { agent, conversation } = this.conversation(conversationId);
    const snapshot = await this.runtime.snapshot(agent, conversationId);
    const latest = this.store
      .listExecutions(agent.id)
      .find((execution) => execution.conversationId === conversationId);
    return {
      ...snapshot,
      agentId: agent.id,
      conversation,
      error: latest?.status === "failed" ? latest.error : null,
    };
  }

  /** The bot's one continuous chat, created on first use and stable across restarts. */
  async chat(agentId: string): Promise<Conversation> {
    const opening = this.chatOpening.get(agentId);
    if (opening) return opening;
    const promise = (async () => {
      const agent = this.agent(agentId);
      const saved = this.store.getSetting<string>(`chat:${agentId}`);
      const existing = saved ? this.store.getConversation(saved) : undefined;
      if (existing?.agentId === agentId)
        return existing.archived
          ? this.store.restoreConversation(existing.id)!
          : existing;
      // Upgrades from session-based installs continue the most recent session's working context.
      const legacy = this.store.listConversations(agentId, true)[0];
      const chat = legacy
        ? legacy.archived
          ? this.store.restoreConversation(legacy.id)!
          : legacy
        : this.store.createConversation(
            { agentId, title: agent.name },
            await this.runtime.openChat(agent),
          );
      this.store.setSetting(`chat:${agentId}`, chat.id);
      return chat;
    })();
    this.chatOpening.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.chatOpening.delete(agentId);
    }
  }

  async recordBotMessage(
    agentId: string,
    event: BotMessageEvent,
    requestId: string,
  ) {
    const chat = await this.chat(agentId);
    await this.runtime.recordBotMessage(
      this.agent(agentId),
      chat.id,
      event,
      requestId,
    );
    this.changed(chat.id);
    void this.announcePreview(agentId, chat.id).catch((error) =>
      console.error("Chat preview announcement failed", agentId, error),
    );
  }

  async chatSnapshot(agentId: string) {
    return this.snapshot((await this.chat(agentId)).id);
  }

  async history(agentId: string, options: { before?: string; limit?: number }) {
    return this.runtime.history(this.agent(agentId), options);
  }

  async sendChat(
    agentId: string,
    content: string,
    requestId: string,
    replyTo?: string,
    attachments: AttachmentInput[] = [],
  ) {
    return this.send((await this.chat(agentId)).id, content, requestId, {
      replyTo,
      attachments,
    });
  }

  async send(
    conversationId: string,
    content: string,
    requestId: string,
    options: {
      scheduleId?: string;
      replyTo?: string;
      attachments?: AttachmentInput[];
    } = {},
  ) {
    const { agent } = this.conversation(conversationId);
    if (!agent.enabled)
      throw new AppError(409, "Enable this agent before starting work");
    const replyTo = options.replyTo ?? null;
    const attachments = options.attachments ?? [];
    // Validate before anything is stored, so a bad file never leaves a failed execution behind.
    prepareAttachments(attachments);
    const attachmentsDigest = attachmentDigest(attachments);
    let execution = this.store.findExecution(conversationId, requestId);
    if (
      execution &&
      (execution.prompt !== content ||
        (execution.replyTo ?? null) !== replyTo ||
        (execution.attachmentsDigest ?? null) !== attachmentsDigest)
    )
      throw new AppError(
        409,
        "Request ID already used for a different message",
      );
    execution ??= this.store.createExecution({
      agentId: agent.id,
      conversationId,
      scheduleId: options.scheduleId ?? null,
      requestId,
      prompt: content,
      replyTo,
      attachments,
      attachmentsDigest,
      submissionId: null,
      status: "pending",
      error: null,
    });
    await this.admit(execution);
    this.changed(conversationId);
    void this.announcePreview(execution.agentId, conversationId).catch(
      (error) =>
        console.error("Chat preview announcement failed", execution.id, error),
    );
    return this.store.getExecution(execution.id)!;
  }

  private origin(execution: Execution): MessageOrigin {
    if (execution.scheduleId)
      return {
        kind: "task",
        name:
          this.store.getSchedule(execution.scheduleId)?.name ??
          "Scheduled task",
      };
    const [prefix, sourceAgentId] = execution.requestId.split(":");
    if (prefix === "delegate" && sourceAgentId)
      return {
        kind: "bot",
        agentId: sourceAgentId,
        name: this.store.getAgent(sourceAgentId)?.name ?? "Another bot",
      };
    return { kind: "owner" };
  }

  private async admit(execution: Execution) {
    if (["done", "cancelled"].includes(execution.status)) return;
    // Admission can fail after Pi has committed but before the host gets its ID.
    // Reuse the durable request ID; never create another user turn to recover it.
    if (execution.status === "failed" && execution.submissionId) return;
    const agent = this.agent(execution.agentId);
    if (!agent.enabled) {
      await this.runtime.abort(agent, execution.conversationId);
      this.store.updateExecution(execution.id, { status: "cancelled" });
      this.changed(execution.conversationId);
      return;
    }
    try {
      const submissionId =
        execution.submissionId ??
        (await this.runtime.submit(
          agent,
          execution.conversationId,
          execution.prompt,
          execution.requestId,
          {
            replyTo: execution.replyTo ?? undefined,
            origin: this.origin(execution),
            attachments: this.store.executionAttachments(execution.id),
          },
        ));
      this.store.updateExecution(execution.id, {
        submissionId,
        status: "running",
      });
      this.store.clearExecutionAttachments(execution.id);
      if (!this.monitoring.has(execution.id)) {
        const monitor = this.runtime
          .wait(submissionId, agent)
          .then((result) => {
            if (this.closing) return;
            const current = this.store.getExecution(execution.id);
            if (!current || current.status === "cancelled") return;
            this.store.updateExecution(execution.id, {
              status: result.status === "done" ? "done" : "failed",
              error:
                result.status === "done"
                  ? null
                  : "detail" in result
                    ? String(result.detail ?? result.reason)
                    : "The agent could not answer this input",
            });
            this.changed(execution.conversationId);
            if (result.status === "done")
              void this.announceReply(execution).catch((error) =>
                console.error("Reply announcement failed", execution.id, error),
              );
          })
          .catch((error) => {
            if (this.closing) return;
            if (this.store.getExecution(execution.id))
              this.store.updateExecution(execution.id, {
                status: "failed",
                error: String(error.message ?? error),
              });
            this.changed(execution.conversationId);
          })
          .finally(() => this.monitoring.delete(execution.id));
        this.monitoring.set(execution.id, monitor);
      }
    } catch (error) {
      this.store.updateExecution(execution.id, {
        status: "failed",
        error: String(error instanceof Error ? error.message : error),
      });
      this.changed(execution.conversationId);
      throw error;
    }
  }

  async dispatch(
    agentId: string,
    prompt: string,
    requestId: string,
    scheduleId: string,
  ) {
    const existing = this.store
      .listExecutions(agentId)
      .find((e) => e.requestId === requestId);
    if (existing) {
      await this.admit(existing);
      return existing;
    }
    const chat = await this.chat(agentId);
    return this.send(chat.id, prompt, requestId, { scheduleId });
  }

  async recover() {
    for (const execution of this.store
      .listExecutions()
      .filter((e) => e.status === "pending" || e.status === "running")) {
      try {
        await this.admit(execution);
      } catch (error) {
        console.error("Execution recovery failed", execution.id, error);
      }
    }
  }

  async compact(agentId: string) {
    const agent = this.agent(agentId);
    const chat = await this.chat(agentId);
    const taskId = await this.runtime.compact(agent, chat.id);
    this.changed(chat.id);
    return taskId;
  }

  async abortChat(agentId: string) {
    await this.abort((await this.chat(agentId)).id);
  }

  async abort(conversationId: string) {
    const { agent } = this.conversation(conversationId);
    const active = this.store
      .listExecutions(agent.id)
      .filter(
        (execution) =>
          execution.conversationId === conversationId &&
          ["pending", "running"].includes(execution.status),
      );
    await this.runtime.abort(agent, conversationId);
    for (const execution of active) {
      if (this.store.getExecution(execution.id)?.status !== "done")
        this.store.updateExecution(execution.id, { status: "cancelled" });
    }
    this.changed(conversationId);
  }

  async deleteAgent(id: string) {
    this.agent(id);
    for (const conversation of this.store.listConversations(id))
      await this.abort(conversation.id);
    await this.runtime.deleteAgent(id);
    this.store.deleteAgent(id);
  }

  async close() {
    this.closing = true;
    await this.runtime.close();
    await Promise.allSettled(this.monitoring.values());
    this.store.close();
  }
}
