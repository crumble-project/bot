import { Store } from "./store";
import { AgentRuntime } from "./runtime";
import { AppError, type Agent, type Execution } from "./domain";

export class CrumbleService {
  private monitoring = new Map<string, Promise<void>>();
  private closing = false;
  private listeners = new Map<string, Set<() => void>>();
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
    if (!conversation || conversation.archived) throw new AppError(404, "Conversation not found");
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
      conversation,
      error: latest?.status === "failed" ? latest.error : null,
    };
  }

  async createConversation(agentId: string, title = "New conversation") {
    const agent = this.agent(agentId);
    const id = await this.runtime.createConversation(agent);
    return this.store.createConversation({ agentId, title }, id);
  }

  async send(
    conversationId: string,
    content: string,
    requestId: string,
    scheduleId: string | null = null,
  ) {
    const { conversation, agent } = this.conversation(conversationId);
    if (!agent.enabled)
      throw new AppError(409, "Enable this agent before starting work");
    let execution = this.store.findExecution(conversationId, requestId);
    if (execution && execution.prompt !== content)
      throw new AppError(
        409,
        "Request ID already used for a different message",
      );
    if (!execution) {
      execution = this.store.createExecution({
        agentId: agent.id,
        conversationId,
        scheduleId,
        requestId,
        prompt: content,
        submissionId: null,
        status: "pending",
        error: null,
      });
    }
    await this.admit(execution);
    this.store.updateConversation(conversationId, {
      title:
        conversation.title === "New conversation"
          ? content.slice(0, 80)
          : conversation.title,
    });
    this.changed(conversationId);
    return this.store.getExecution(execution.id)!;
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
        ));
      this.store.updateExecution(execution.id, {
        submissionId,
        status: "running",
      });
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
    const conversation = await this.createConversation(
      agentId,
      this.store.getSchedule(scheduleId)?.name ?? "Scheduled task",
    );
    return this.send(conversation.id, prompt, requestId, scheduleId);
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

  async archiveConversation(id: string) {
    await this.abort(id);
    this.store.archiveConversation(id);
    this.changed(id);
  }

  async close() {
    this.closing = true;
    await this.runtime.close();
    await Promise.allSettled(this.monitoring.values());
    this.store.close();
  }
}
