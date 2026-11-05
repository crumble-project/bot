import { activeExecution } from "../shared/domain";
import { pi } from "../shared/app-errors";
import { Effect } from "effect";
import type { botsActivity } from "./bots-activity";
import type { botsAdmission } from "./bots-admission";
import { background, type BotsContext } from "./bots-context";
import type { botsChat } from "./bots-chat";
import type { botsLookup } from "./bots-lookup";

type LifecycleDeps = {
  lookup: ReturnType<typeof botsLookup>;
  chat: ReturnType<typeof botsChat>["chat"];
  notifications: ReturnType<typeof botsActivity>;
  admit: ReturnType<typeof botsAdmission>["admit"];
};

/** Stops a chat's running executions, and everything a bot's chat was running. */
const botsCancellation = (context: BotsContext, deps: LifecycleDeps) => {
  const { conversations, executions, runtime } = context;
  const { conversation } = deps.lookup;
  const { changed, record, settled } = deps.notifications;

  const abort = Effect.fn("Bots.abort")(function* (conversationId: string) {
    const { agent: owner } = yield* conversation(conversationId);

    const running = (yield* executions.list(owner.id)).filter(
      (execution) =>
        execution.conversationId === conversationId &&
        activeExecution(execution),
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

  return {
    abort,
    stopAgent,
    abortChat: (agentId: string) =>
      deps.chat(agentId).pipe(Effect.flatMap((opened) => abort(opened.id))),
  };
};

/** The upkeep a bot needs outside a turn: its compacted chat, recovery of unfinished work, and its deletion. */
const botsMaintenance = (
  context: BotsContext,
  deps: LifecycleDeps & {
    stopAgent: ReturnType<typeof botsCancellation>["stopAgent"];
  },
) => {
  const { agents, executions, runtime } = context;
  const { agent } = deps.lookup;
  const chat = deps.chat;
  const { changed } = deps.notifications;
  const { admit } = deps;

  const compact = Effect.fn("Bots.compact")(function* (agentId: string) {
    const owner = yield* agent(agentId);
    const opened = yield* chat(agentId);
    const taskId = yield* pi(() => runtime.compact(owner, opened.id));
    yield* changed(opened.id);

    return taskId;
  });

  const recover = Effect.gen(function* () {
    for (const execution of (yield* executions.list()).filter(activeExecution))
      yield* admit(execution).pipe(
        background("Execution recovery failed", execution.id),
      );
  });

  const deleteAgent = Effect.fn("Bots.deleteAgent")(function* (id: string) {
    yield* agent(id);
    yield* deps.stopAgent(id);
    yield* pi(() => runtime.deleteAgent(id));
    yield* agents.delete(id);
  });

  return { compact, recover, deleteAgent };
};

/** What ends or repairs a bot's work: cancelling, compacting, recovering, and deleting. */
export const botsLifecycle = (context: BotsContext, deps: LifecycleDeps) => {
  const stop = botsCancellation(context, deps);

  return {
    ...stop,
    ...botsMaintenance(context, { ...deps, stopAgent: stop.stopAgent }),
  };
};
