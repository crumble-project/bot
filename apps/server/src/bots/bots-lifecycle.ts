import { logged, pi } from "../shared/app-errors";
import type { Execution } from "../shared/domain";
import { Effect } from "effect";
import type { BotsChat } from "./bots-chat";
import type { BotsContext } from "./bots-context";
import type { BotsLookup } from "./bots-lookup";
import type { BotsNotifications } from "./bots-notifications";

type LifecycleDeps = {
  lookup: BotsLookup;
  chat: BotsChat["chat"];
  notifications: BotsNotifications;
  admit: (execution: Execution) => Effect.Effect<void, unknown>;
};

/** What ends or repairs a bot's work: cancelling, compacting, recovering, and deleting. */
export const botsLifecycle = (context: BotsContext, deps: LifecycleDeps) => {
  const { agents, conversations, deletion, executions, runtime } = context;
  const { agent, conversation } = deps.lookup;
  const { changed, record, settled } = deps.notifications;
  const { admit, chat } = deps;

  /** Stops a chat's running executions. */
  const abort = Effect.fn("Bots.abort")(function* (conversationId: string) {
    const { agent: owner } = yield* conversation(conversationId);

    const running = (yield* executions.active(owner.id)).filter(
      (execution) => execution.conversationId === conversationId,
    );

    // Cancelled before the runtime stops, so the aborted wait doesn't record the runs as failed first.
    for (const execution of running)
      yield* record(execution, { status: "cancelled" });

    yield* pi(() => runtime.abort(owner, conversationId));
    yield* changed(conversationId);

    for (const execution of running) yield* settled(execution.id);
  });

  /** Stops everything the bot runs, in its chat and in its other conversations. */
  const stopAgent = Effect.fn("Bots.stopAgent")(function* (agentId: string) {
    for (const each of yield* conversations.list(agentId))
      yield* abort(each.id);
  });

  const abortChat = (agentId: string) =>
    chat(agentId).pipe(Effect.flatMap((opened) => abort(opened.id)));

  const compact = Effect.fn("Bots.compact")(function* (agentId: string) {
    const owner = yield* agent(agentId);
    const opened = yield* chat(agentId);
    const taskId = yield* pi(() => runtime.compact(owner, opened.id));
    yield* changed(opened.id);

    return taskId;
  });

  const recover = Effect.gen(function* () {
    for (const execution of yield* executions.active())
      yield* admit(execution).pipe(
        logged("Execution recovery failed", execution.id),
      );
  });

  const deleteAgent = Effect.fn("Bots.deleteAgent")(function* (id: string) {
    yield* agent(id);
    yield* stopAgent(id);

    const clear = yield* deletion.prepare(id);

    yield* pi(() => runtime.deleteAgent(id));
    yield* agents.delete(id);
    yield* clear;
  });

  return { abort, abortChat, stopAgent, compact, recover, deleteAgent };
};
