import { Effect, Layer, ManagedRuntime } from "effect";
import type { AgentRepository } from "../bot-store/agent-repository";
import type { EventRepository } from "../event-sources/event-repository";
import type { Runner } from "../shared/runner";
import { BotWorkspaces } from "../workspaces/workspace";
import type { Workspaces } from "../workspaces/workspace";
import { Automations } from "./automations";
import { BotSchedules } from "./bot-schedules";
import type { ScheduleDraft } from "./bot-schedules";
import type { ScheduleRepository } from "./schedule-repository";
import { Scheduler, schedulerAccess } from "./scheduler";
import type { SchedulerAccess } from "./scheduler";
import { ScriptRuns } from "./script-runs";
import { AutomationDispatch } from "./automation-dispatch";
import type { DispatchedExecution } from "./automation-dispatch";

type Core = Runner<ScheduleRepository | AgentRepository | EventRepository>;

export type StandaloneDispatch = (
  agentId: string,
  prompt: string,
  requestId: string,
  scheduleId: string,
) => Promise<DispatchedExecution>;

export const recordedDispatch = {
  id: "dispatch",
  status: "running",
} as const satisfies DispatchedExecution;

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
              try: () => dispatch(agentId, prompt, requestId, scheduleId),
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

export function standaloneScheduler(
  core: Core,
  dispatch: StandaloneDispatch,
  scriptRuns?: ScriptRuns["Service"],
  workspaces?: Workspaces,
): SchedulerAccess & {
  service: Scheduler["Service"];
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
    service: runtime.runSync(Effect.flatMap(Scheduler, Effect.succeed)),
    stop: () => runtime.dispose(),
  };
}

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

  const service = runtime.runSync(Effect.flatMap(BotSchedules, Effect.succeed));

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
