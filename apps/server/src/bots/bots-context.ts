import { Effect, FiberMap, type Scope } from "effect";
import { parseRequestId } from "../shared/request-ids";
import type { Execution } from "../shared/domain";
import { keyedListeners, keyedLocks } from "../shared/keyed";
import { SettingsRepository } from "../shared/settings-repository";
import { ScheduleRepository } from "../automations/schedule-repository";
import { EventRepository } from "../event-sources/event-repository";
import { AgentRepository } from "../bot-store/agent-repository";
import type { Activity } from "./bots";
import { BotDeletion } from "../bot-ports/bot-deletion";
import { BotNotices } from "../bot-ports/bot-notices";
import { ConversationRepository } from "../bot-store/conversation-repository";
import { ExecutionRepository } from "../bot-store/execution-repository";
import { BotRuntime } from "./runtime";

/** Group turns run as executions too, but their output belongs to the group, not the bot chat. */
export const isGroupTurn = (execution: Execution) =>
  parseRequestId(execution.requestId).kind === "group-turn";

/** One layer build's repositories and runtime, and the state its chats keep in memory. */
export type BotsContext = {
  readonly agents: AgentRepository["Service"];
  readonly conversations: ConversationRepository["Service"];
  readonly executions: ExecutionRepository["Service"];
  readonly settings: SettingsRepository["Service"];
  readonly schedules: ScheduleRepository["Service"];
  readonly events: EventRepository["Service"];
  readonly runtime: BotRuntime["Service"];
  readonly notices: BotNotices["Service"];
  readonly deletion: BotDeletion["Service"];
  readonly scope: Scope.Scope;
  readonly listeners: ReturnType<typeof keyedListeners>;
  readonly activityListeners: Set<(event: Activity) => void>;
  readonly settledListeners: Set<
    (execution: Execution) => void | Promise<void>
  >;
  /** Openings of one bot's chat run one at a time, so a second caller finds the chat the first created. */
  readonly chatOpenings: ReturnType<typeof keyedLocks>;
  readonly monitors: FiberMap.FiberMap<string>;
};

/** The context of one layer build, created once per build and shared by every group of operations. */
export const botsContext = Effect.gen(function* () {
  return {
    agents: yield* AgentRepository,
    conversations: yield* ConversationRepository,
    executions: yield* ExecutionRepository,
    settings: yield* SettingsRepository,
    schedules: yield* ScheduleRepository,
    events: yield* EventRepository,
    runtime: yield* BotRuntime,
    notices: yield* BotNotices,
    deletion: yield* BotDeletion,
    scope: yield* Effect.scope,
    listeners: keyedListeners(),
    activityListeners: new Set<(event: Activity) => void>(),
    settledListeners: new Set<(execution: Execution) => void | Promise<void>>(),
    chatOpenings: keyedLocks(),
    monitors: yield* FiberMap.make<string>(),
  } satisfies BotsContext;
});
