import { pi } from "../shared/app-errors";
import { Cause, Effect, FiberMap } from "effect";
import type { Agent, Execution } from "../shared/domain";
import { errorText } from "../shared/errors";
import { parseRequestId } from "../shared/request-ids";
import { frameInput } from "./input-framing";
import type { botsActivity } from "./bots-activity";
import { type BotsContext } from "./bots-context";
import type { botsLookup } from "./bots-lookup";
import type { botsMonitor } from "./bots-outcomes";
import type { botsReads } from "./bots-reads";

type AdmissionDeps = {
  lookup: ReturnType<typeof botsLookup>;
  reads: ReturnType<typeof botsReads>;
  notifications: ReturnType<typeof botsActivity>;
  monitor: ReturnType<typeof botsMonitor>["monitor"];
};

/** Submits one admitted execution to the runtime, or cancels it when its bot is disabled. */
const botsSubmissionSteps = (context: BotsContext, deps: AdmissionDeps) => {
  const { executions, runtime, events } = context;
  const { origin } = deps.reads;

  // A pruned event leaves the automation's prompt alone.
  const eventInput = Effect.fnUntraced(function* (execution: Execution) {
    const request = parseRequestId(execution.requestId);

    if (request.kind !== "event") return undefined;

    return (yield* events.eventWithSource(request.eventId)) ?? undefined;
  });

  const { settle } = deps.notifications;

  const submit = Effect.fnUntraced(function* (
    execution: Execution,
    owner: Agent,
  ) {
    if (execution.submissionId) return execution.submissionId;

    const from = yield* origin(execution);
    const attachments = yield* executions.attachments(execution.id);

    const event =
      from.kind === "event" ? yield* eventInput(execution) : undefined;

    const prepared = yield* pi(() =>
      runtime.prepareInput(
        owner,
        execution.prompt,
        execution.replyTo ?? undefined,
      ),
    );

    const modelContent = frameInput(
      prepared.modelContent,
      from,
      execution.requestId,
      event,
    );

    return yield* pi(() =>
      runtime.submit(
        owner,
        execution.conversationId,
        execution.prompt,
        execution.requestId,
        {
          input: { ...prepared, modelContent },
          origin: from,
          attachments,
        },
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

  return { submit, cancelled };
};

/** Records an execution whose admission failed with anything but an interrupt. */
const admissionFailure =
  (notifications: ReturnType<typeof botsActivity>) =>
  (execution: Execution, cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : notifications.settle(execution, {
          status: "failed",
          error: errorText(Cause.squash(cause)),
        });

/** Stores the submission, then watches it with the monitor the bots keep per execution. */
const botsSubmissionRun = (
  context: BotsContext,
  deps: AdmissionDeps,
  submit: ReturnType<typeof botsSubmissionSteps>["submit"],
) => {
  const { executions, monitors } = context;
  const failed = admissionFailure(deps.notifications);

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

  return { run };
};

/** Admits one execution: starts it once, or recovers it under its durable request ID. */
export const botsAdmission = (context: BotsContext, deps: AdmissionDeps) => {
  const { agent } = deps.lookup;
  const steps = botsSubmissionSteps(context, deps);
  const { run } = botsSubmissionRun(context, deps, steps.submit);

  const admit = Effect.fnUntraced(function* (execution: Execution) {
    if (execution.status === "done" || execution.status === "cancelled") return;

    // Admission can fail after Pi has committed but before the host gets its ID.
    // Reuse the durable request ID; never create another user turn to recover it.
    if (execution.status === "failed" && execution.submissionId) return;
    const owner = yield* agent(execution.agentId);

    if (!owner.enabled) return yield* steps.cancelled(execution, owner);

    yield* run(execution, owner);
  });

  return { admit };
};
