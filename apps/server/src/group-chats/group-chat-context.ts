import {
  Cause,
  Effect,
  FiberSet,
  Semaphore,
  type Fiber,
  type Scope,
} from "effect";
import type { AgentRepository } from "../bots/agent-repository";
import type { Bots } from "../bots/bots";
import type { ConversationRepository } from "../bots/conversation-repository";
import type { ExecutionRepository } from "../bots/execution-repository";
import type { BotRuntime } from "../bots/runtime";
import { appErrors } from "../shared/app-errors";
import type { Execution, GroupChat } from "../shared/domain";
import { InvalidInput, NotFound, type AppError } from "../shared/errors";
import type { GroupChatRepository } from "./group-chat-repository";
import type { GroupTranscripts } from "./group-transcripts";

/** The services one group chats layer build runs on. */
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

/** What one layer build owns: its listeners, queues, locks, and the fibers background work runs in. */
export type GroupChatState = {
  readonly listeners: Map<string, Set<() => void>>;
  /** Members whose joining summary is being written, as `group:agent`. */
  readonly summarizing: Set<string>;
  readonly pendingVersions: Map<string, symbol>;
  // Turn state changes run one at a time per group, so a member never gets two turns.
  readonly locks: Map<string, Semaphore.Semaphore>;
  readonly fork: GroupChatFork;
};

/** A group chat's services, the state of this layer build, and the helpers its parts share. */
export type GroupChatContext = GroupChatServices & {
  readonly state: GroupChatState;
  readonly serial: <A, E>(
    groupId: string,
    work: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
  readonly changed: (groupId: string) => Effect.Effect<void>;
  readonly get: (groupId: string) => Effect.Effect<GroupChat, AppError>;
  readonly enabled: (agentId: string) => Effect.Effect<boolean>;
  readonly checkMembers: (memberIds: string[]) => Effect.Effect<void, AppError>;
};

/** Runs a promise-based service call as an Effect that fails with the AppErrors it raises. */
export const pi = <A>(run: () => Promise<A>) =>
  appErrors(Effect.tryPromise({ try: run, catch: (error) => error }));

export const logged = (label: string, ...subjects: string[]) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Effect.logError(label, ...subjects, Cause.squash(cause)),
  );

export const active = (execution: Execution) =>
  execution.status === "pending" || execution.status === "running";

/** The state of one layer build; its fiber set closes with the layer's scope. */
export const groupChatState: Effect.Effect<GroupChatState, never, Scope.Scope> =
  Effect.gen(function* () {
    // Closing interrupts background work between steps; the step in progress finishes, and recovery resumes the rest.
    const background = yield* FiberSet.make();
    const fork = yield* FiberSet.runtime(background)<never>();

    return {
      listeners: new Map<string, Set<() => void>>(),
      summarizing: new Set<string>(),
      pendingVersions: new Map<string, symbol>(),
      locks: new Map<string, Semaphore.Semaphore>(),
      fork,
    };
  });

export const groupChatContext = (
  services: GroupChatServices,
  state: GroupChatState,
): GroupChatContext => {
  const { groups, agents } = services;

  const serial = <A, E>(groupId: string, work: Effect.Effect<A, E>) => {
    let lock = state.locks.get(groupId);

    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      state.locks.set(groupId, lock);
    }

    return Semaphore.withPermit(lock, Effect.uninterruptible(work));
  };

  const changed = (groupId: string) =>
    Effect.sync(() => {
      for (const listener of state.listeners.get(groupId) ?? []) listener();
    });

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
    serial,
    changed,
    get,
    enabled,
    checkMembers,
  };
};
