import { Effect, Layer } from "effect";
import { Bots } from "../bots/bots";
import { JOB_KINDS } from "../shared/job-kinds";
import { ChatAttention } from "../push/chat-attention";
import {
  HeldActions,
  type HeldAction,
  type HeldActionSurface,
} from "./held-actions";

export const heldActionNotices = Layer.effectDiscard(
  Effect.gen(function* () {
    const bots = yield* Bots;
    const held = yield* HeldActions;
    const attention = yield* ChatAttention;

    const announce = Effect.fn("HeldActions.announce")(function* (
      action: HeldAction,
      surface: HeldActionSurface,
    ) {
      const agent = yield* bots.agent(action.agentId);
      const chat = yield* bots.chat(agent.id);

      yield* attention.register({
        eventId: action.id,
        chat: { kind: "bot", id: agent.id },
        ...surface,
        surface: { kind: "held-action", actionId: action.id },
      });
      yield* bots.changed(chat.id);
      yield* bots.announce({
        type: "reply",
        executionId: action.id,
        agentId: agent.id,
        agentName: agent.name,
        entryId: null,
        origin: JOB_KINDS.desktop.kind,
        jobName: action.job,
        waitingFor: "approval",
        preview: `Waiting for your approval: ${action.action}`,
        createdAt: action.heldAt,
      });
    });

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        held.onHeld((action, surface) =>
          Effect.runFork(
            announce(action, surface).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Held action notice failed", cause),
              ),
            ),
          ),
        ),
      ),
      (stop) => Effect.sync(stop),
    );
  }),
);
