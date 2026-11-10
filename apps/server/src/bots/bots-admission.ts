import { pi } from "../shared/app-errors";
import { Cause, Effect, FiberMap } from "effect";
import type { Agent } from "../contract/agents";
import type { Execution } from "../shared/domain";
import { errorText } from "../shared/errors";
import { parseRequestId } from "../shared/request-ids";
import type { InputOrigin } from "../transcript/origins";
import { frameInput } from "./input-framing";
import type { BotsContext } from "./bots-context";
import type { BotsLookup } from "./bots-lookup";
import type { BotsNotifications } from "./bots-notifications";

type AdmissionDeps = {
  lookup: BotsLookup;
  origin: (execution: Execution) => Effect.Effect<InputOrigin>;
  notifications: BotsNotifications;
  monitor: (
    execution: Execution,
    submissionId: string,
    owner: Agent,
  ) => Effect.Effect<void>;
};

export const botsAdmission = (context: BotsContext, deps: AdmissionDeps) => {
  const { callNotes, events, executions, monitors, runtime } = context;
  const { agent } = deps.lookup;
  const { settle } = deps.notifications;

  const eventInput = Effect.fnUntraced(function* (execution: Execution) {
    const request = parseRequestId(execution.requestId);

    if (request.kind !== "event") return undefined;

    return (yield* events.eventWithSource(request.eventId)) ?? undefined;
  });

  // An outside call's goal and transcript reach the model, never the stored message.
  const callNote = (execution: Execution) => {
    const request = parseRequestId(execution.requestId);

    return request.kind === "voice-call"
      ? callNotes.note(execution.agentId, request.callId)
      : Effect.succeed(undefined);
  };

  const submit = Effect.fnUntraced(function* (
    execution: Execution,
    owner: Agent,
  ) {
    if (execution.submissionId) return execution.submissionId;

    const origin = yield* deps.origin(execution);
    const attachments = yield* executions.attachments(execution.id);
    const event = yield* eventInput(execution);
    const call = yield* callNote(execution);

    const prepared = yield* pi(() =>
      runtime.prepareInput(
        owner,
        execution.prompt,
        execution.replyTo ?? undefined,
      ),
    );

    const modelContent = frameInput(
      prepared.modelContent,
      origin,
      execution.requestId,
      { event, call },
    );

    return yield* pi(() =>
      runtime.submit(
        owner,
        execution.conversationId,
        execution.prompt,
        execution.requestId,
        { input: { ...prepared, modelContent }, origin, attachments },
      ),
    );
  });

  const cancelled = Effect.fnUntraced(function* (
    execution: Execution,
    owner: Agent,
  ) {
    yield* pi(() => runtime.abort(owner, execution.conversationId));
    yield* settle(execution, { status: "cancelled" });
  });

  const failed = (execution: Execution, cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : settle(execution, {
          status: "failed",
          error: errorText(Cause.squash(cause)),
        });

  const run = (execution: Execution, owner: Agent) =>
    Effect.gen(function* () {
      const submissionId = yield* submit(execution, owner);

      yield* executions.update(execution.id, {
        submissionId,
        status: "running",
      });
      yield* executions.clearAttachments(execution.id);
      yield* FiberMap.run(
        monitors,
        execution.id,
        deps.monitor(execution, submissionId, owner),
        { onlyIfMissing: true },
      );
    }).pipe(Effect.onError((cause) => failed(execution, cause)));

  const admit = Effect.fnUntraced(function* (execution: Execution) {
    if (execution.status === "done" || execution.status === "cancelled") return;

    // Admission can fail after Pi has committed but before the host gets its ID.
    // Reuse the durable request ID; never create another user turn to recover it.
    if (execution.status === "failed" && execution.submissionId) return;
    const owner = yield* agent(execution.agentId);

    if (!owner.enabled) return yield* cancelled(execution, owner);

    yield* run(execution, owner);
  });

  return { admit };
};
