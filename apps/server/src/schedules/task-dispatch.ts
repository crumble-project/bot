import { Context, type Effect } from "effect";

export type ScheduleDispatchResult = { id?: string; status?: string } | void;

/** Hands a due task's prompt to its bot's chat; success means the input was durably admitted. */
export class TaskDispatch extends Context.Service<
  TaskDispatch,
  (
    agentId: string,
    prompt: string,
    requestId: string,
    scheduleId: string,
  ) => Effect.Effect<ScheduleDispatchResult, unknown>
>()("crumble/schedules/TaskDispatch") {}
