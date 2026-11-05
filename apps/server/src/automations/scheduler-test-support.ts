import { Effect, Layer, ManagedRuntime } from "effect";
import type { AgentRepository } from "../bots/agent-repository";
import type { EventRepository } from "../event-sources/event-repository";
import type { Execution } from "../shared/domain";
import type { Runner } from "../shared/runner";
import { BotWorkspaces, type Workspaces } from "../workspaces/workspace";
import { Automations } from "./automations";
import { BotSchedules, type ScheduleDraft } from "./bot-schedules";
import type { ScheduleRepository } from "./schedule-repository";
import { Scheduler, schedulerAccess, type SchedulerAccess } from "./scheduler";
import { ScriptRuns } from "./script-runs";
import { AutomationDispatch } from "./automation-dispatch";

type Core = Runner<ScheduleRepository | AgentRepository | EventRepository>;

/** A dispatch for tests: it answers only what the test reads. */
export type StandaloneDispatch = (
  agentId: string,
  prompt: string,
  requestId: string,
  scheduleId: string,
) => Promise<Partial<Execution> | void>;

const standaloneDependencies = (
  core: Core,
  dispatch: StandaloneDispatch,
  scriptRuns: ScriptRuns["Service"] = ScriptRuns.of({
    start: () => Effect.succeed({ admitted: false }),
    recover: Effect.void,
    list: () => Effect.succeed([]),
  }),
  workspaces?: Workspaces,
) =>
  Automations.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(ScriptRuns, scriptRuns),
        Layer.succeed(BotWorkspaces, workspaces),
        Layer.succeed(
          AutomationDispatch,
          (agentId, prompt, requestId, scheduleId) =>
            Effect.tryPromise({
              // SAFETY: test dispatchers return an Execution or nothing the scheduler reads.
              try: async () =>
                (await dispatch(
                  agentId,
                  prompt,
                  requestId,
                  scheduleId,
                )) as Execution,
              catch: (error) => error,
            }),
        ),
        Layer.succeedContext(
          core.runSync(
            Effect.context<
              ScheduleRepository | AgentRepository | EventRepository
            >(),
          ),
        ),
      ),
    ),
  );

/** A scheduler over the tasks `core` reaches, dispatching with `dispatch`, for an API or a test without an account. */
export function standaloneScheduler(
  core: Core,
  dispatch: StandaloneDispatch,
  scriptRuns?: ScriptRuns["Service"],
  workspaces?: Workspaces,
): SchedulerAccess & {
  service: Scheduler["Service"];
  /** Ends the scheduler's scope, as closing an account does. */
  stop: () => Promise<void>;
} {
  const runtime = ManagedRuntime.make(
    Scheduler.layer.pipe(
      Layer.provide(
        standaloneDependencies(core, dispatch, scriptRuns, workspaces),
      ),
    ),
  );

  return {
    ...schedulerAccess(runtime),
    service: runtime.runSync(Scheduler.use(Effect.succeed)),
    stop: () => runtime.dispose(),
  };
}

/** Bot schedules and their scheduler over the tasks `core` reaches, with errors thrown, for a test without an account. */
export function standaloneBotSchedules(
  core: Core,
  dispatch: StandaloneDispatch,
  scriptRuns?: ScriptRuns["Service"],
  workspaces?: Workspaces,
) {
  const runtime = ManagedRuntime.make(
    BotSchedules.layer.pipe(
      Layer.provideMerge(Scheduler.layer),
      Layer.provide(
        standaloneDependencies(core, dispatch, scriptRuns, workspaces),
      ),
    ),
  );

  const service = runtime.runSync(BotSchedules.use(Effect.succeed));

  return {
    service,
    schedules: {
      list: (sourceId: string) => Effect.runSync(service.list(sourceId)),
      create: (sourceId: string, draft: ScheduleDraft) =>
        Effect.runSync(service.create(sourceId, draft)),
      update: (sourceId: string, id: string, draft: ScheduleDraft) =>
        Effect.runSync(service.update(sourceId, id, draft)),
      delete: (sourceId: string, id: string) =>
        Effect.runSync(service.delete(sourceId, id)),
      run: (sourceId: string, id: string) =>
        Effect.runPromise(service.run(sourceId, id)),
    },
    scheduler: schedulerAccess(runtime),
  };
}
