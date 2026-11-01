import { Cause, Effect, FiberMap, Semaphore, type Scope } from "effect";
import { appErrors } from "../shared/app-errors";
import type { Execution } from "../shared/domain";
import { SettingsRepository } from "../shared/settings-repository";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { EventRepository } from "../event-sources/event-repository";
import { AgentRepository } from "./agent-repository";
import type { Activity } from "./bots";
import { BotNotices } from "./bot-notices";
import { ConversationRepository } from "./conversation-repository";
import { ExecutionRepository } from "./execution-repository";
import { BotRuntime } from "./runtime";

/** Group turns run as executions too, but their output belongs to the group, not the bot chat. */
export const GROUP_TURN_PREFIX = "group-turn:";

export const isGroupTurn = (execution: Execution) =>
  execution.requestId.startsWith(GROUP_TURN_PREFIX);

export const active = (execution: Execution) =>
  execution.status === "pending" || execution.status === "running";

/** A Pi Durable call: AppErrors it throws are failures, anything else is a defect. */
export const pi = <A>(run: () => Promise<A>) =>
  appErrors(Effect.tryPromise({ try: run, catch: (error) => error }));

export const background = (label: string, subject: string) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Effect.logError(label, subject, Cause.squash(cause)),
  );

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
  readonly scope: Scope.Scope;
  readonly listeners: Map<string, Set<() => void>>;
  readonly activityListeners: Set<(event: Activity) => void>;
  readonly settledListeners: Set<
    (execution: Execution) => void | Promise<void>
  >;
  readonly chatOpenings: Map<string, Semaphore.Semaphore>;
  readonly monitors: FiberMap.FiberMap<string>;
};

/** The context of one layer build, created once per build and shared by every group of operations. */
export const botsContext = Effect.gen(function* () {
  const agents = yield* AgentRepository;
  const conversations = yield* ConversationRepository;
  const executions = yield* ExecutionRepository;
  const settings = yield* SettingsRepository;
  const schedules = yield* ScheduleRepository;
  const events = yield* EventRepository;
  const runtime = yield* BotRuntime;
  const notices = yield* BotNotices;
  const scope = yield* Effect.scope;

  const listeners = new Map<string, Set<() => void>>();
  const activityListeners = new Set<(event: Activity) => void>();

  const settledListeners = new Set<
    (execution: Execution) => void | Promise<void>
  >();

  // Openings of one bot's chat run one at a time, so a second caller finds the chat the first created.
  const chatOpenings = new Map<string, Semaphore.Semaphore>();

  // Released last: the monitors stop before the runtime they wait on closes.
  yield* Effect.addFinalizer(() => Effect.promise(() => runtime.close()));
  const monitors = yield* FiberMap.make<string>();

  return {
    agents,
    conversations,
    executions,
    settings,
    schedules,
    events,
    runtime,
    notices,
    scope,
    listeners,
    activityListeners,
    settledListeners,
    chatOpenings,
    monitors,
  } satisfies BotsContext;
});
