import { Effect, FiberMap } from "effect";
import type { Scope } from "effect";
import { parseRequestId } from "../shared/request-ids";
import type { Execution } from "../shared/domain";
import { keyedListeners, keyedLocks } from "../shared/keyed";
import type { KeyedListeners } from "../shared/keyed";
import { SettingsRepository } from "../shared/settings-repository";
import { ScheduleRepository } from "../automations/schedule-repository";
import { ScriptRunRepository } from "../automations/script-run-repository";
import { EventRepository } from "../event-sources/event-repository";
import { AgentRepository } from "../bot-store/agent-repository";
import type { Activity } from "./bots";
import { BotDeletion } from "../bot-ports/bot-deletion";
import { BotNotices } from "../bot-ports/bot-notices";
import { CallNotes } from "../bot-ports/call-notes";
import { ConversationRepository } from "../bot-store/conversation-repository";
import { ExecutionRepository } from "../bot-store/execution-repository";
import { BotRuntime } from "./runtime";
import { Library } from "../files/library";
import { ChatAttention } from "../push/chat-attention";

export const isCallTurn = (execution: Pick<Execution, "requestId">) =>
  parseRequestId(execution.requestId).kind === "outside-call";

export const isChatTurn = (execution: Execution) => !isCallTurn(execution);

export type BotsContext = {
  readonly attention: ChatAttention["Service"];
  readonly agents: AgentRepository["Service"];
  readonly conversations: ConversationRepository["Service"];
  readonly executions: ExecutionRepository["Service"];
  readonly settings: SettingsRepository["Service"];
  readonly schedules: ScheduleRepository["Service"];
  readonly scriptRuns: ScriptRunRepository["Service"];
  readonly events: EventRepository["Service"];
  readonly runtime: BotRuntime["Service"];
  readonly library: Library["Service"];
  readonly notices: BotNotices["Service"];
  readonly callNotes: CallNotes["Service"];
  readonly deletion: BotDeletion["Service"];
  readonly scope: Scope.Scope;
  readonly listeners: KeyedListeners;
  readonly activityListeners: Set<(event: Activity) => void>;
  readonly settledListeners: Set<
    (execution: Execution) => void | Promise<void>
  >;
  readonly chatOpenings: ReturnType<typeof keyedLocks>;
  readonly monitors: FiberMap.FiberMap<string>;
};

export const botsContext = Effect.gen(function* () {
  return {
    attention: yield* ChatAttention,
    agents: yield* AgentRepository,
    conversations: yield* ConversationRepository,
    executions: yield* ExecutionRepository,
    settings: yield* SettingsRepository,
    schedules: yield* ScheduleRepository,
    scriptRuns: yield* ScriptRunRepository,
    events: yield* EventRepository,
    runtime: yield* BotRuntime,
    library: yield* Library,
    notices: yield* BotNotices,
    callNotes: yield* CallNotes,
    deletion: yield* BotDeletion,
    scope: yield* Effect.scope,
    listeners: keyedListeners(),
    activityListeners: new Set<(event: Activity) => void>(),
    settledListeners: new Set<(execution: Execution) => void | Promise<void>>(),
    chatOpenings: keyedLocks(),
    monitors: yield* FiberMap.make<string>(),
  } satisfies BotsContext;
});
