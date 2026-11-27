import { Effect } from "effect";
import type { BotStatus } from "../contract/bot-status";
import { logged } from "../shared/app-errors";
import { activeExecution } from "../shared/domain";
import { chatQuestionOpen } from "../transcript/chat-question";
import { turnSource } from "../transcript/origins";
import type { AppError } from "../shared/errors";
import type { ChatSnapshot } from "./bots";
import type { BotsContext } from "./bots-context";

export type BotStatusChange = { agentId: string; status: BotStatus };

type StatusDeps = {
  snapshot: (
    conversationId: string,
    options?: {
      limit?: number | undefined;
      partial?: boolean | undefined;
    },
  ) => Effect.Effect<ChatSnapshot, AppError>;
};

export type BotsStatus = ReturnType<typeof botsStatus>;

const COALESCE = "50 millis";
const POLL = "1 second";
const CHAT_WINDOW = 200;

export const botsStatus = (context: BotsContext, deps: StatusDeps) => {
  const { agents, conversations, executions, needs, scope, statusListeners } =
    context;

  const inflight = new Map<string, boolean>();
  const polling = new Set<string>();
  let stopNeeds: (() => void) | undefined;

  const answeringOwner = Effect.fnUntraced(function* (conversationId: string) {
    const latest = yield* executions.latestIn(conversationId);

    return (
      latest !== null &&
      activeExecution(latest) &&
      turnSource(latest).kind === "owner"
    );
  });

  const compute = Effect.fnUntraced(function* (
    agentId: string,
  ): Effect.fn.Return<{ status: BotStatus; running: boolean }> {
    const need = yield* needs.current(agentId);

    if (need === "blocked" || need === "question") {
      return { status: need, running: false };
    }
    const [chat] = yield* conversations.list(agentId, true);

    const snapshot = chat
      ? yield* deps
          .snapshot(chat.id, { limit: CHAT_WINDOW, partial: true })
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
      : undefined;

    if (!chat || !snapshot) {
      return {
        status: need === "working" ? "working" : "idle",
        running: false,
      };
    }
    const { working, error, messages } = snapshot;
    const running = working !== "idle" && working !== "failed";

    if (chatQuestionOpen(messages, yield* answeringOwner(chat.id))) {
      return { status: "question", running };
    }

    if (working === "failed" || error !== null) {
      return { status: "failed", running };
    }

    if (working === "thinking") {
      return { status: "thinking", running };
    }

    return {
      status: running || need === "working" ? "working" : "idle",
      running,
    };
  });

  const statusOf = (agentId: string): Effect.Effect<BotStatus> =>
    Effect.map(compute(agentId), ({ status }) => status);

  const announce = Effect.fnUntraced(function* (agentId: string) {
    if (!statusListeners.size || !(yield* agents.get(agentId))) {
      return;
    }
    const { status, running } = yield* compute(agentId);

    for (const listener of statusListeners) {
      listener({ agentId, status });
    }

    if (running) {
      yield* poll(agentId);
    }
  });

  const release = (agentId: string) => {
    if (inflight.get(agentId)) {
      inflight.set(agentId, false);

      return true;
    }
    inflight.delete(agentId);

    return false;
  };

  const settle = (agentId: string): Effect.Effect<void> =>
    Effect.sleep(COALESCE).pipe(
      Effect.andThen(Effect.sync(() => inflight.set(agentId, false))),
      Effect.andThen(announce(agentId)),
      logged("Bot status announcement failed", agentId),
      Effect.andThen(
        Effect.suspend(() =>
          release(agentId) ? settle(agentId) : Effect.void,
        ),
      ),
      Effect.onInterrupt(() => Effect.sync(() => inflight.delete(agentId))),
    );

  const refresh = (agentId: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!statusListeners.size) {
        return Effect.void;
      }

      if (inflight.has(agentId)) {
        inflight.set(agentId, true);

        return Effect.void;
      }
      inflight.set(agentId, false);

      return settle(agentId).pipe(Effect.forkIn(scope), Effect.asVoid);
    });

  const poll = (agentId: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (polling.has(agentId)) {
        return Effect.void;
      }
      polling.add(agentId);

      return Effect.sleep(POLL).pipe(
        Effect.ensuring(Effect.sync(() => polling.delete(agentId))),
        Effect.andThen(refresh(agentId)),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    });

  const conversationChanged = Effect.fnUntraced(function* (
    conversationId: string,
  ) {
    if (!statusListeners.size) {
      return;
    }
    const found = yield* conversations.get(conversationId);

    if (found) {
      yield* refresh(found.agentId);
    }
  });

  const onBotStatus = (callback: (event: BotStatusChange) => void) => {
    statusListeners.add(callback);

    if (!stopNeeds) {
      stopNeeds = needs.onChanged((agentId) =>
        Effect.runFork(refresh(agentId)),
      );
    }

    return () => {
      statusListeners.delete(callback);

      if (!statusListeners.size) {
        stopNeeds?.();
        stopNeeds = undefined;
      }
    };
  };

  const requestStatuses = Effect.flatMap(agents.list, (listed) =>
    Effect.forEach(listed, (each) => refresh(each.id), { discard: true }),
  );

  return { statusOf, requestStatuses, conversationChanged, onBotStatus };
};
