import { Context, type Effect } from "effect";
import type { Execution } from "../shared/domain";

/** Hands a due task's prompt to its bot's chat; success means the input was durably admitted. */
export class TaskDispatch extends Context.Service<
  TaskDispatch,
  (
    agentId: string,
    prompt: string,
    requestId: string,
    scheduleId: string,
  ) => Effect.Effect<Execution, unknown>
>()("crumble/automations/TaskDispatch") {}
