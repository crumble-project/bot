import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  boundOutput,
  OutputBuffer,
  PROGRESS_BYTES_PER_SECOND,
} from "@earendil-works/chord/output";
import { ExecutionError, toError } from "@earendil-works/pi-durable/env";
import {
  Cause,
  Context,
  DateTime,
  Effect,
  Exit,
  Layer,
  Scope,
  Semaphore,
} from "effect";
import { AgentRepository } from "../bots/agent-repository";
import { BotNotices } from "../bots/bot-notices";
import { Credentials } from "../credentials/credentials";
import type { Schedule, ScriptRun } from "../shared/domain";
import type { AppError } from "../shared/errors";
import { nowIso } from "../shared/time";
import { BotWorkspaces, WORKSPACE_PATH } from "../workspaces/workspace";
import { ScriptRunRepository } from "./script-run-repository";
import { scriptEvent, type ScriptEvent } from "../event-sources/event-payload";

type Outcome = {
  status: Exclude<ScriptRun["status"], "running">;
  exitCode: number | null;
  error: string | null;
};

const OUTPUT_LIMITS = {
  maxBytes: 65536,
  maxLines: 2000,
  retain: "tail",
} as const;

const noticeText = (schedule: Schedule, result: Outcome, output: string) => {
  const tail = boundOutput(output, {
    ...OUTPUT_LIMITS,
    maxBytes: 8192,
  }).text.trimEnd();

  return `${schedule.name}\n\nStatus: ${result.status}\n\nExit code: ${result.exitCode ?? "none"}\n\n\`\`\`\n${tail}\n\`\`\``;
};

export class ScriptRuns extends Context.Service<
  ScriptRuns,
  {
    /** With `event`, the command reads the event from the file `CRUMBLE_EVENT_FILE` names. */
    readonly start: (
      schedule: Schedule,
      event?: ScriptEvent,
    ) => Effect.Effect<{ admitted: boolean; run?: ScriptRun }, AppError>;
    readonly recover: Effect.Effect<void>;
    readonly list: (
      scheduleId: string,
      options: { limit: number; before?: string | undefined },
    ) => Effect.Effect<ScriptRun[]>;
  }
>()("crumble/schedules/ScriptRuns") {
  static readonly layer = Layer.effect(
    ScriptRuns,
    Effect.gen(function* () {
      const repository = yield* ScriptRunRepository;
      const workspaces = yield* BotWorkspaces;
      const credentials = yield* Credentials;
      const notices = yield* BotNotices;
      const agents = yield* AgentRepository;
      const scope = yield* Scope.make();
      const admission = yield* Semaphore.make(1);
      const semaphore = yield* Semaphore.make(4);
      const inFlight = new Set<string>();
      let closing = false;

      // Keep the execution scope open until pending admissions finish recording their rows.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closing = true;
          yield* admission.withPermit(Scope.close(scope, Exit.void));
        }),
      );

      const finish = Effect.fnUntraced(function* (
        schedule: Schedule,
        run: ScriptRun,
        result: Outcome,
        output = "",
        droppedBytes = 0,
      ) {
        yield* repository.finish(run.id, {
          ...result,
          output,
          droppedBytes,
          finishedAt: yield* nowIso,
        });

        if (schedule.notify)
          yield* notices
            .notice(
              schedule.agentId,
              noticeText(schedule, result, output),
              `script:${schedule.id}:${run.id}`,
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Script task notice failed", run.id, cause),
              ),
            );
      });

      const execute = (
        schedule: Schedule,
        run: ScriptRun,
        event: ScriptEvent | undefined,
      ) => {
        const output = new OutputBuffer(OUTPUT_LIMITS);

        const command = Effect.gen(function* (): Effect.fn.Return<Outcome> {
          if (!workspaces)
            return {
              status: "failed",
              exitCode: null,
              error: "workspace unavailable",
            };

          const agent = yield* agents.get(schedule.agentId);

          if (!agent?.tools.includes("coding"))
            return {
              status: "failed",
              exitCode: null,
              error: "coding is turned off for this bot",
            };

          const release = workspaces.keepAwake(schedule.agentId);

          return yield* Effect.gen(function* (): Effect.fn.Return<Outcome> {
            const payload =
              event && scriptEvent(event.record, event.sourceName);

            const env = {
              ...(yield* credentials.env(schedule.agentId)),
              ...payload?.env,
            };

            const result = yield* Effect.tryPromise({
              try: async (signal) => {
                const shell = workspaces.env(schedule.agentId, env);
                const context = withAbortSignal(signal, BACKGROUND_CONTEXT);

                if (payload) {
                  const written = await shell.writeFile(
                    payload.file,
                    payload.content,
                    context,
                  );

                  if (!written.ok)
                    throw new ExecutionError("unknown", written.error.message);
                }

                return shell.exec(
                  run.command,
                  {
                    cwd: WORKSPACE_PATH,
                    timeout: schedule.timeoutSeconds,
                    onOutput: (chunk, _context, info) => {
                      output.push(chunk, info.skipped);
                    },
                    window: {
                      maxBytes: OUTPUT_LIMITS.maxBytes,
                      maxLines: OUTPUT_LIMITS.maxLines,
                      minIntervalMs: 1000,
                      bytesPerSecond: PROGRESS_BYTES_PER_SECOND,
                    },
                  },
                  context,
                );
              },
              catch: (error) =>
                error instanceof ExecutionError
                  ? error
                  : new ExecutionError("unknown", toError(error).message),
            }).pipe(
              Effect.catch((error) =>
                Effect.succeed({
                  ok: false as const,
                  error,
                }),
              ),
            );

            if (result.ok)
              return {
                status: result.value.exitCode === 0 ? "succeeded" : "failed",
                exitCode: result.value.exitCode,
                error: null,
              };

            return {
              status: result.error.code === "timeout" ? "timed_out" : "failed",
              exitCode: null,
              error: result.error.message,
            };
          }).pipe(Effect.ensuring(Effect.sync(release)));
        });

        return semaphore.withPermit(command).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              output.end();
              const tail = output.snapshot();
              let result: Outcome;

              if (Exit.isSuccess(exit)) result = exit.value;
              else {
                const error = Cause.pretty(exit.cause);
                result = {
                  status: Exit.hasInterrupts(exit) ? "interrupted" : "failed",
                  exitCode: null,
                  error: Exit.hasInterrupts(exit) ? null : error,
                };
              }

              yield* finish(
                schedule,
                run,
                result,
                tail.text,
                tail.droppedBytes,
              );
            }).pipe(
              Effect.ensuring(Effect.sync(() => inFlight.delete(schedule.id))),
            ),
          ),
        );
      };

      const start = Effect.fn("ScriptRuns.start")(
        function* (schedule: Schedule, event?: ScriptEvent) {
          if (closing || inFlight.has(schedule.id)) return { admitted: false };
          inFlight.add(schedule.id);

          const run: ScriptRun = {
            id: crypto.randomUUID(),
            scheduleId: schedule.id,
            agentId: schedule.agentId,
            command: schedule.command ?? "",
            status: "running",
            exitCode: null,
            output: "",
            droppedBytes: 0,
            error: null,
            startedAt: yield* nowIso,
            finishedAt: null,
          };

          yield* repository
            .create(run)
            .pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? Effect.sync(() => inFlight.delete(schedule.id))
                  : Effect.void,
              ),
            );

          if (closing) {
            yield* finish(schedule, run, {
              status: "interrupted",
              exitCode: null,
              error: null,
            }).pipe(
              Effect.ensuring(Effect.sync(() => inFlight.delete(schedule.id))),
            );

            return { admitted: false };
          }

          yield* execute(schedule, run, event).pipe(
            Effect.forkIn(scope, { startImmediately: true }),
          );

          return { admitted: true, run };
        },
        (effect) => admission.withPermit(effect),
        Effect.uninterruptible,
      );

      const recover = Effect.flatMap(nowIso, repository.interruptRunning);

      const list = Effect.fn("ScriptRuns.list")(function* (
        scheduleId: string,
        options: { limit: number; before?: string | undefined },
      ) {
        const now = yield* DateTime.now;
        yield* repository.prune(
          DateTime.formatIso(DateTime.subtract(now, { days: 90 })),
        );

        return yield* repository.list(scheduleId, options);
      });

      return ScriptRuns.of({ start, recover, list });
    }),
  );
}
