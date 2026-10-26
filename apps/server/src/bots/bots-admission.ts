import { Cause, Effect, FiberMap } from "effect";
import type { Agent, Execution } from "../shared/domain";
import type { botsActivity } from "./bots-activity";
import { pi, type BotsContext } from "./bots-context";
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
  const { executions, runtime } = context;
  const { origin } = deps.reads;
  const { changed, settled } = deps.notifications;

  const submit = Effect.fnUntraced(function* (
    execution: Execution,
    owner: Agent,
  ) {
    if (execution.submissionId) return execution.submissionId;

    const from = yield* origin(execution);
    const attachments = yield* executions.attachments(execution.id);

    return yield* pi(() =>
      runtime.submit(
        owner,
        execution.conversationId,
        execution.prompt,
        execution.requestId,
        {
          replyTo: execution.replyTo ?? undefined,
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
    yield* executions.update(execution.id, { status: "cancelled" });
    yield* changed(execution.conversationId);
    yield* settled(execution.id);
  });

  return { submit, cancelled };
};

/** Records an execution whose admission failed with anything but an interrupt. */
const botsAdmissionFailure = (
  context: BotsContext,
  notifications: ReturnType<typeof botsActivity>,
) => {
  const { executions } = context;
  const { changed, settled } = notifications;

  return (execution: Execution, cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Effect.gen(function* () {
          const error = Cause.squash(cause);

          yield* executions.update(execution.id, {
            status: "failed",
            error: String(error instanceof Error ? error.message : error),
          });
          yield* changed(execution.conversationId);
          yield* settled(execution.id);
        });
};

/** Stores the submission, then watches it with the monitor the bots keep per execution. */
const botsSubmissionRun = (
  context: BotsContext,
  deps: AdmissionDeps,
  submit: ReturnType<typeof botsSubmissionSteps>["submit"],
) => {
  const { executions, monitors } = context;
  const admissionFailure = botsAdmissionFailure(context, deps.notifications);

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
    }).pipe(Effect.onError((cause) => admissionFailure(execution, cause)));

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
