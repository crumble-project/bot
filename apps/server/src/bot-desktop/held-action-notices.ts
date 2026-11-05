import { Effect, Layer } from "effect";
import { Bots } from "../bots/bots";
import { JOB_KINDS } from "../shared/job-kinds";
import { HeldActions, type HeldAction } from "./held-actions";

/** Announces each desktop job action held for the owner's approval, so clients notify the owner who must decide. */
export const heldActionNotices = Layer.effectDiscard(
  Effect.gen(function* () {
    const bots = yield* Bots;
    const held = yield* HeldActions;

    const announce = Effect.fn("HeldActions.announce")(function* (
      action: HeldAction,
    ) {
      const agent = yield* bots.agent(action.agentId);

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
        held.onHeld((action) =>
          Effect.runFork(
            announce(action).pipe(
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
