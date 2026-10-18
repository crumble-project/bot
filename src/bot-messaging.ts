import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  type Context,
} from "@earendil-works/chord/context";
import { AppError, type Agent, type Execution } from "./domain";
import { delegationRequest, type CrumbleService } from "./service";

type Receipt = { sourceAgentId: string; targetAgentId: string };

type MessageRequest = {
  targetAgentId: string;
  recipient: string;
  message: string;
};

const active = (execution: Execution) =>
  execution.status === "pending" || execution.status === "running";

const normalize = (name: string) => name.normalize("NFKC").toLowerCase();

/** Bot addressing and exchanges over the existing durable execution transport. */
export class BotMessaging {
  constructor(private readonly service: CrumbleService) {}

  recipients(sourceId: string) {
    const source = this.source(sourceId);

    return this.service.store
      .listAgents()
      .filter(
        (agent) =>
          agent.id !== source.id &&
          agent.enabled &&
          source.delegates.includes(agent.id),
      )
      .map(({ id, name, description }) => ({ id, name, description }));
  }

  async send(
    sourceId: string,
    input: {
      recipient: string;
      message: string;
      requestId: string;
    },
    context: Context = BACKGROUND_CONTEXT,
  ) {
    context.abortSignal?.throwIfAborted();
    const source = this.source(sourceId);
    const message = input.message.trim();

    if (!message || message.length > 32000)
      throw new AppError(400, "A bot message must contain 1–32000 characters");

    if (!input.requestId)
      throw new AppError(400, "A bot message needs a request ID");
    this.assertCanSend(source.id);

    const requestId = delegationRequest(source.id, input.requestId);
    const key = `bot-message-request:${requestId}`;
    const saved = this.service.store.getSetting<MessageRequest>(key);
    const recipient = normalize(input.recipient.trim().replace(/^@/, ""));

    // An in-flight tool keeps its resolved destination if the bot is renamed.
    const target =
      saved?.recipient === recipient
        ? this.service.agent(saved.targetAgentId)
        : this.resolve(input.recipient);

    this.authorize(source, target);

    if (
      saved &&
      (saved.targetAgentId !== target.id || saved.message !== message)
    )
      throw new AppError(
        409,
        "Request ID already used for a different bot message",
      );

    // Reserve the destination before awaiting chat admission. A replay cannot send
    // the same tool invocation to a second bot or change its message.
    if (!saved)
      this.service.store.setSetting(key, {
        targetAgentId: target.id,
        recipient,
        message,
      });
    const chat = await this.service.chat(target.id);
    context.abortSignal?.throwIfAborted();
    // Opening a chat may yield: recheck permissions and capacity immediately before send.
    this.authorize(this.source(source.id), this.service.agent(target.id));
    this.assertCanSend(source.id);
    const existing = this.service.store.findExecution(chat.id, requestId);

    if (
      !existing &&
      this.service.store.listExecutions(target.id).filter(active).length >= 4
    )
      throw new AppError(
        409,
        "This agent already has four active tasks; try again later",
      );
    const execution = await this.service.send(chat.id, message, requestId);
    this.service.store.setSetting(`delegation-receipt:${execution.id}`, {
      sourceAgentId: source.id,
      targetAgentId: target.id,
    });
    await this.record(source.id, source.id, execution, "sent", message);
    await this.record(target.id, source.id, execution, "sent", message);

    return this.receipt(execution);
  }

  async result(
    sourceId: string,
    executionId: string,
    options: {
      waitMs?: number;
      context?: Context;
    } = {},
  ) {
    let execution = this.exchange(sourceId, executionId);
    const context = options.context ?? BACKGROUND_CONTEXT;
    context.abortSignal?.throwIfAborted();
    const waitMs = Math.min(60000, Math.max(0, options.waitMs ?? 0));

    if (active(execution) && execution.submissionId && waitMs > 0) {
      const timeout = new AbortController();
      const reason = new Error("Bot reply wait timed out");
      const timer = setTimeout(() => timeout.abort(reason), waitMs);

      try {
        await this.service.runtime.wait(
          execution.submissionId,
          this.service.agent(execution.agentId),
          withAbortSignal(timeout.signal, context),
        );
      } catch (error) {
        context.abortSignal?.throwIfAborted();

        if (!timeout.signal.aborted || error !== reason) throw error;
      } finally {
        clearTimeout(timer);
      }

      execution = this.exchange(sourceId, executionId);
    }

    // Only a completed answer belongs to the caller. Partial output and other
    // turns in the recipient's chat remain private.
    const response =
      execution.status === "done" && execution.submissionId
        ? await this.service.runtime.response(
            this.service.agent(execution.agentId),
            execution.conversationId,
            execution.submissionId,
          )
        : [];

    this.exchange(sourceId, executionId);

    if (
      execution.status === "done" ||
      execution.status === "failed" ||
      execution.status === "cancelled"
    ) {
      await this.record(
        sourceId,
        sourceId,
        execution,
        execution.status,
        response.join("\n\n") ||
          execution.error ||
          (execution.status === "done"
            ? "The bot returned no text answer."
            : "The bot exchange was cancelled."),
      );
    }

    this.exchange(sourceId, executionId);

    return { ...this.receipt(execution), error: execution.error, response };
  }

  private async record(
    transcriptAgentId: string,
    sourceId: string,
    execution: Execution,
    status: "sent" | "done" | "failed" | "cancelled",
    content: string,
  ) {
    const source = this.service.agent(sourceId);
    const target = this.service.agent(execution.agentId);
    const [from, to] = status === "done" ? [target, source] : [source, target];
    await this.service.recordBotMessage(
      transcriptAgentId,
      {
        content,
        communication: {
          executionId: execution.id,
          fromAgentId: from.id,
          fromName: from.name,
          toAgentId: to.id,
          toName: to.name,
          status,
        },
      },
      `bot-message:${execution.id}:${status}`,
    );
  }

  private source(sourceId: string) {
    const source = this.service.agent(sourceId);

    if (!source.enabled || !source.tools.includes("delegate"))
      throw new AppError(
        403,
        "This agent has no permission to message other bots",
      );

    return source;
  }

  private resolve(recipient: string) {
    const reference = recipient.trim().replace(/^@/, "");
    const byId = this.service.store.getAgent(reference);

    if (byId) return byId;

    const matches = this.service.store
      .listAgents()
      .filter((agent) => normalize(agent.name) === normalize(reference));

    if (!matches.length)
      throw new AppError(
        404,
        "Bot not found; use list_bots to find a recipient",
      );

    if (matches.length > 1)
      throw new AppError(
        409,
        "Bot name is ambiguous; use the ID from list_bots",
      );

    return matches[0]!;
  }

  private assertCanSend(sourceId: string) {
    if (
      this.service.store
        .listExecutions(sourceId)
        .some(
          (execution) =>
            active(execution) && execution.requestId.startsWith("delegate:"),
        )
    )
      throw new AppError(
        409,
        "Delegated tasks cannot start further delegations",
      );
  }

  private authorize(source: Agent, target: Agent) {
    if (!target.enabled || target.id === source.id)
      throw new AppError(400, "Choose another enabled agent");

    if (!source.delegates.includes(target.id))
      throw new AppError(
        403,
        "This agent has no permission to delegate to that agent",
      );
  }

  private exchange(sourceId: string, executionId: string) {
    const receipt = this.service.store.getSetting<Receipt>(
      `delegation-receipt:${executionId}`,
    );

    const source = this.source(sourceId);

    if (
      receipt?.sourceAgentId !== source.id ||
      !source.delegates.includes(receipt.targetAgentId)
    )
      throw new AppError(404, "Delegation receipt not found");
    const execution = this.service.store.getExecution(executionId);

    if (!execution || execution.agentId !== receipt.targetAgentId)
      throw new AppError(404, "Delegation execution not found");

    return execution;
  }

  private receipt(execution: Execution) {
    return {
      executionId: execution.id,
      agentId: execution.agentId,
      agent: this.service.agent(execution.agentId).name,
      status: execution.status,
    };
  }
}
