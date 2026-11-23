import { Context } from "effect";
import type { Effect } from "effect";
import type { Execution } from "../shared/domain";

export type DispatchedExecution = Pick<Execution, "id" | "status">;

export class AutomationDispatch extends Context.Service<
  AutomationDispatch,
  (
    agentId: string,
    prompt: string,
    requestId: string,
    scheduleId: string,
  ) => Effect.Effect<DispatchedExecution, unknown>
>()("crumble/automations/AutomationDispatch") {}
