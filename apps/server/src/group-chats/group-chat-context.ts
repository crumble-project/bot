import { Effect, FiberSet, Semaphore, type Fiber, type Scope } from "effect";
import { keyedListeners, keyedLocks } from "../shared/keyed";
import type { AgentRepository } from "../bot-store/agent-repository";
import type { Bots } from "../bots/bots";
import type { ConversationRepository } from "../bot-store/conversation-repository";
import type { ExecutionRepository } from "../bot-store/execution-repository";
import type { BotRuntime } from "../bots/runtime";
import type { GroupChat } from "./group-chat-repository";
import { InvalidInput, NotFound, type AppError } from "../shared/errors";
import type { GroupChatRepository } from "./group-chat-repository";
import type { GroupTranscripts } from "./group-transcripts";

export type GroupChatServices = {
  readonly groups: GroupChatRepository["Service"];
  readonly agents: AgentRepository["Service"];
  readonly executions: ExecutionRepository["Service"];
  readonly conversations: ConversationRepository["Service"];
  readonly transcripts: GroupTranscripts;
  readonly bots: Bots["Service"];
  readonly runtime: BotRuntime["Service"];
};

export type GroupChatFork = <A, E>(
  effect: Effect.Effect<A, E>,
) => Fiber.Fiber<A, E>;

export type GroupChatState = {
  readonly listeners: ReturnType<typeof keyedListeners>;
  readonly summarizing: Set<string>;
  // Bumped by each queueing, by `memberKey`, so a turn that was starting meanwhile leaves the new follow-up queued.
  readonly pendingVersions: Map<string, symbol>;
  // Turn state changes run one at a time per group, so a member never gets two turns.
  readonly locks: ReturnType<typeof keyedLocks>;
  // Held only across store writes: posting takes this one, as a turn's startup can hold `locks` while it submits.
  readonly queueLocks: ReturnType<typeof keyedLocks>;
  readonly fork: GroupChatFork;
};

export type GroupChatContext = GroupChatServices & {
  readonly state: GroupChatState;
  readonly serial: <A, E>(
    groupId: string,
    work: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
  /** Guards a group's queue and budget records. Taken inside `serial`, never around it; only store writes inside. */
  readonly queueing: <A, E>(
    groupId: string,
    work: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
  readonly changed: (groupId: string) => Effect.Effect<void>;
  readonly get: (groupId: string) => Effect.Effect<GroupChat, AppError>;
  readonly enabled: (agentId: string) => Effect.Effect<boolean>;
  readonly checkMembers: (memberIds: string[]) => Effect.Effect<void, AppError>;
};

export const memberKey = (groupId: string, agentId: string) =>
  `${groupId}:${agentId}`;

export const groupChatState: Effect.Effect<GroupChatState, never, Scope.Scope> =
  Effect.gen(function* () {
    // Closing interrupts background work between steps; the step in progress finishes, and recovery resumes the rest.
    const background = yield* FiberSet.make();
    const fork = yield* FiberSet.runtime(background)<never>();

    return {
      listeners: keyedListeners(),
      summarizing: new Set<string>(),
      pendingVersions: new Map<string, symbol>(),
      locks: keyedLocks(),
      queueLocks: keyedLocks(),
      fork,
    };
  });

export const groupChatContext = (
  services: GroupChatServices,
  state: GroupChatState,
): GroupChatContext => {
  const { groups, agents } = services;

  const locked =
    (lockOf: ReturnType<typeof keyedLocks>) =>
    <A, E>(groupId: string, work: Effect.Effect<A, E>) =>
      Semaphore.withPermit(lockOf(groupId), Effect.uninterruptible(work));

  const changed = (groupId: string) =>
    Effect.sync(() => state.listeners.notify(groupId));

  const get = Effect.fn("GroupChats.get")(function* (groupId: string) {
    const group = yield* groups.get(groupId);

    if (!group)
      return yield* Effect.fail(
        new NotFound({ message: "Group chat not found" }),
      );

    return group;
  });

  const enabled = (agentId: string) =>
    agents.get(agentId).pipe(Effect.map((agent) => agent?.enabled === true));

  const checkMembers = Effect.fnUntraced(function* (memberIds: string[]) {
    for (const agentId of memberIds)
      if (!(yield* agents.get(agentId)))
        return yield* Effect.fail(
          new InvalidInput({ message: "Choose existing bots as members" }),
        );
  });

  return {
    ...services,
    state,
    serial: locked(state.locks),
    queueing: locked(state.queueLocks),
    changed,
    get,
    enabled,
    checkMembers,
  };
};
