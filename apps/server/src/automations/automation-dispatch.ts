import { Context, type Effect } from "effect";
import type { Execution } from "../shared/domain";

/** Hands a due automation's prompt to its bot's chat; success means the input was durably admitted. */
export class AutomationDispatch extends Context.Service<
  AutomationDispatch,
  (
    agentId: string,
    prompt: string,
    requestId: string,
    scheduleId: string,
  ) => Effect.Effect<Execution, unknown>
>()("crumble/automations/AutomationDispatch") {}
