import { Context } from "effect";
import type { Effect } from "effect";
import type { Execution } from "../shared/domain";

/** What a dispatch reports about the execution it admitted: the scheduler forwards its id and status to the caller. */
export type DispatchedExecution = Pick<Execution, "id" | "status">;

/** Hands a due automation's prompt to its bot's chat; success means the input was durably admitted. */
export class AutomationDispatch extends Context.Service<
  AutomationDispatch,
  (
    agentId: string,
    prompt: string,
    requestId: string,
    scheduleId: string,
  ) => Effect.Effect<DispatchedExecution, unknown>
>()("crumble/automations/AutomationDispatch") {}
