import { Effect } from "effect";
import { GROUP_TURN_PREFIX } from "../bots/bots";
import {
  GROUP_TURN_BUDGET,
  type Agent,
  type Execution,
  type GroupChat,
  type GroupMember,
  type GroupTurn,
} from "../shared/domain";
import type { AppError } from "../shared/errors";
import {
  active,
  logged,
  pi,
  type GroupChatContext,
} from "./group-chat-context";
import type { GroupChatMembers } from "./group-chat-members";
import { mentionsOwner } from "./group-mentions";
import type { GroupEntry } from "./group-transcripts";
import type { GroupTurnInput } from "./group-turn-input";

/** Everything that leads one turn to the next: the group's context, its members, and what a turn tells its bot. */
export type GroupTurnDeps = {
  readonly context: GroupChatContext;
  readonly members: GroupChatMembers;
  readonly input: GroupTurnInput;
};

/** The part of group chats that leads one turn to the next: waking members, sending turns, and settling them. */
export type GroupTurnEngine = {
  readonly wake: (
    groupId: string,
    agentId: string,
    botStarted: boolean,
  ) => Effect.Effect<void>;
  readonly settled: (execution: Execution) => Effect.Effect<void, AppError>;
};

type TurnDispatch = {
  group: GroupChat;
  agent: Agent;
  member: GroupMember;
  unseen: GroupEntry[];
  conversationId: string;
  botStarted: boolean;
  first: boolean;
  through: number;
  pendingVersion: symbol | undefined;
};

const consumePending = Effect.fnUntraced(function* (
  context: GroupChatContext,
  groupId: string,
  agentId: string,
  pendingVersion: symbol | undefined,
) {
  // A message accepted during startup must keep its follow-up queued.
  const key = `${groupId}:${agentId}`;

  if (context.state.pendingVersions.get(key) === pendingVersion) {
    yield* context.groups.setMember(groupId, agentId, { pending: false });
    context.state.pendingVersions.delete(key);
  }
});

const unseenFor = Effect.fnUntraced(function* (
  context: GroupChatContext,
  groupId: string,
  agentId: string,
  cursor: number,
) {
  return (yield* pi(() => context.transcripts.after(groupId, cursor))).filter(
    (entry) => entry.sender.agentId !== agentId && entry.reaction === undefined,
  );
});

/** Charges a bot-started turn to the group's budget; false once the budget is spent and the group pauses. */
const chargeTurn = Effect.fnUntraced(function* (
  context: GroupChatContext,
  groupId: string,
) {
  const { botTurns } = yield* context.groups.activity(groupId);

  if (botTurns >= GROUP_TURN_BUDGET) {
    yield* context.groups.setActivity(groupId, { paused: true });

    return false;
  }

  yield* context.groups.setActivity(groupId, {
    botTurns: botTurns + 1,
    paused: botTurns + 1 >= GROUP_TURN_BUDGET,
  });

  return true;
});

/**
 * Notifies the owner of the first bot answer to their newest message, if this turn saw it, and of any `@owner`.
 * The event ID is the turn's execution, so a retried post notifies once.
 */
const notify = Effect.fnUntraced(function* (
  context: GroupChatContext,
  group: GroupChat,
  turn: GroupTurn,
  agent: Agent,
  entryId: string,
  text: string,
) {
  const { awaitingAnswers } = yield* context.groups.activity(group.id);

  // The first answer from a bot an owner message woke, in a turn that saw it, answers that message.
  const answered = Object.entries(awaitingAnswers).filter(
    ([entry, targets]) =>
      Number(entry) <= turn.through && targets.includes(agent.id),
  );

  for (const [entry] of answered) delete awaitingAnswers[entry];

  if (answered.length)
    yield* context.groups.setActivity(group.id, { awaitingAnswers });

  if (!answered.length && !mentionsOwner(text)) return;
  yield* context.bots.announce({
    type: "reply",
    executionId: turn.executionId,
    agentId: agent.id,
    agentName: agent.name,
    entryId,
    origin: "group",
    preview: text.trim().slice(0, 240),
    createdAt: new Date().toISOString(),
    groupId: group.id,
    groupName: group.name,
  });
});

const wake = (
  deps: GroupTurnDeps,
  groupId: string,
  agentId: string,
  botStarted: boolean,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { context, members } = deps;
    const member = yield* context.groups.member(groupId, agentId);

    if (!member || !(yield* context.enabled(agentId))) return;

    if (botStarted && (yield* context.groups.activity(groupId)).paused) {
      if (member.pendingBotStarted)
        yield* context.groups.setMember(groupId, agentId, { pending: false });

      return;
    }

    if (yield* context.groups.activeTurn(groupId, agentId)) {
      yield* members.queueMember(groupId, agentId, botStarted);

      return;
    }

    yield* startTurn(deps, groupId, agentId, botStarted).pipe(
      logged("Group turn could not start", groupId, agentId),
    );
  });

const startTurn = (
  deps: GroupTurnDeps,
  groupId: string,
  agentId: string,
  botStarted: boolean,
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const { context, members } = deps;
    const group = yield* context.get(groupId);
    const member = (yield* context.groups.member(groupId, agentId))!;
    const agent = yield* context.bots.agent(agentId);

    const pendingVersion = context.state.pendingVersions.get(
      `${groupId}:${agentId}`,
    );

    const unseen = yield* unseenFor(context, groupId, agentId, member.cursor);

    if (!unseen.length)
      return yield* consumePending(context, groupId, agentId, pendingVersion);

    const first = !(yield* context.groups.listTurns({ groupId })).some(
      (turn) => turn.agentId === agentId && turn.createdAt >= member.joinedAt,
    );

    // A member that joined after the first message waits, queued, for a summary of what came before.
    if (first && member.cursor > 0 && member.summary === null) {
      yield* members.queueMember(groupId, agentId, botStarted);
      yield* startSummary(deps, groupId, agentId, member.cursor);

      return;
    }

    if (botStarted && !(yield* chargeTurn(context, groupId)))
      return yield* consumePending(context, groupId, agentId, pendingVersion);

    const conversationId =
      member.conversationId ??
      (yield* members.openConversation(group, agentId));

    yield* dispatchTurn(deps, {
      group,
      agent,
      member,
      unseen,
      conversationId,
      botStarted,
      first,
      through: unseen.at(-1)!.entry,
      pendingVersion,
    });
  });

const dispatchTurn = (
  deps: GroupTurnDeps,
  turn: TurnDispatch,
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const { context, input } = deps;
    const { group, agent, member, unseen } = turn;
    const summary = turn.first ? member.summary : null;
    const requestId = `${GROUP_TURN_PREFIX}${group.id}:${agent.id}:${turn.through}`;

    const { attachments, omitted } = yield* input.turnAttachments(
      agent,
      unseen,
    );

    const prompt = `${summary ? `Summary of the conversation before you joined:\n\n${summary}\n\n` : ""}${yield* input.turnInput(group, agent.name, unseen)}${omitted.length ? `\n\nYour model cannot read images, so these were left out: ${omitted.join(", ")}.` : ""}`;

    const execution =
      (yield* context.executions.getByRequest(
        turn.conversationId,
        requestId,
      )) ??
      (yield* context.bots
        .send(turn.conversationId, prompt, requestId, { attachments })
        .pipe(
          // A failed admission still leaves its execution; its settlement reports the failure.
          Effect.catchCause((cause) =>
            context.executions
              .getByRequest(turn.conversationId, requestId)
              .pipe(
                Effect.flatMap((left) =>
                  left ? Effect.succeed(left) : Effect.failCause(cause),
                ),
              ),
          ),
        ));

    if (!(yield* context.groups.getTurn(execution.id)))
      yield* context.groups.createTurn({
        executionId: execution.id,
        groupId: group.id,
        agentId: agent.id,
        through: turn.through,
        botStarted: turn.botStarted,
        status: "running",
      });

    yield* consumePending(context, group.id, agent.id, turn.pendingVersion);

    // An execution that failed to start settled before its turn existed, so its settlement found nothing.
    if (!active(execution)) yield* finish(deps, execution.id);
  });

/**
 * Writes a joining member's summary outside the group's queue, so a slow model holds up nothing else, then starts
 * the turn it waited for unless the group was stopped or the member left meanwhile.
 */
const startSummary = (
  deps: GroupTurnDeps,
  groupId: string,
  agentId: string,
  cursor: number,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const { context, input } = deps;
    const key = `${groupId}:${agentId}`;

    if (context.state.summarizing.has(key)) return;
    context.state.summarizing.add(key);

    context.state.fork(
      Effect.gen(function* () {
        const agent = yield* context.agents.get(agentId);

        const summary = agent
          ? yield* input.summarize(groupId, agent, cursor)
          : null;

        yield* context.serial(
          groupId,
          Effect.gen(function* () {
            const member = yield* context.groups.member(groupId, agentId);

            if (!member || summary === null) return;
            yield* context.groups.setMember(groupId, agentId, { summary });

            if (member.pending)
              yield* wake(deps, groupId, agentId, member.pendingBotStarted);
            yield* context.changed(groupId);
          }),
        );
      }).pipe(
        logged("Group summary failed", groupId, agentId),
        Effect.ensuring(
          Effect.sync(() => context.state.summarizing.delete(key)),
        ),
      ),
    );
  });

const publish = (
  deps: GroupTurnDeps,
  group: GroupChat,
  turn: GroupTurn,
  conversationId: string,
  submissionId: string,
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const { context, members } = deps;
    const agent = yield* context.agents.get(turn.agentId);

    if (!agent) return;

    const outcome = yield* pi(() =>
      context.runtime.turnOutcome(agent, conversationId, submissionId),
    );

    if (outcome.kind === "pass") return;
    const sender = { kind: "bot", agentId: agent.id, name: agent.name };
    const requestId = `${GROUP_TURN_PREFIX}${turn.executionId}`;

    if (outcome.kind === "reaction") {
      yield* pi(() =>
        context.transcripts.post(
          group.id,
          {
            text: "",
            sender,
            reaction: outcome.emoji,
            replyTo: `${group.id}:${turn.through}`,
          },
          requestId,
        ),
      );

      return;
    }

    const entryId = yield* pi(() =>
      context.transcripts.post(
        group.id,
        { text: outcome.text, sender },
        requestId,
      ),
    );

    yield* context.changed(group.id);
    yield* notify(context, group, turn, agent, entryId, outcome.text);

    for (const agentId of yield* members.mentions(
      group,
      outcome.text,
      agent.id,
    ))
      yield* wake(deps, group.id, agentId, true);
  });

/** Posts a settled turn's outcome once, advances the member, and starts its waiting turn. */
const finish = (
  deps: GroupTurnDeps,
  executionId: string,
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const { context } = deps;
    const turn = yield* context.groups.getTurn(executionId);
    const execution = yield* context.executions.get(executionId);

    if (!turn || turn.status === "settled" || !execution) return;
    yield* context.groups.updateTurn(executionId, { status: "posting" });
    const group = yield* context.groups.get(turn.groupId);
    const member = yield* context.groups.member(turn.groupId, turn.agentId);

    if (
      group &&
      member &&
      execution.status === "done" &&
      execution.submissionId
    )
      yield* publish(
        deps,
        group,
        turn,
        execution.conversationId,
        execution.submissionId,
      );

    yield* context.groups.updateTurn(executionId, { status: "settled" });

    if (!group || !member) return;

    // A stopped or failed turn leaves its messages unseen, so the member's next turn includes them.
    if (execution.status === "done")
      yield* context.groups.setMember(group.id, turn.agentId, {
        cursor: Math.max(member.cursor, turn.through),
      });

    const current = (yield* context.groups.member(group.id, turn.agentId))!;

    if (current.pending)
      yield* wake(deps, group.id, turn.agentId, current.pendingBotStarted);

    yield* context.changed(group.id);
  });

const settled = Effect.fnUntraced(function* (
  deps: GroupTurnDeps,
  execution: Execution,
) {
  const { context } = deps;
  const turn = yield* context.groups.getTurn(execution.id);

  if (!turn || turn.status === "settled") return;

  yield* context.serial(turn.groupId, finish(deps, turn.executionId));
});

export const groupTurnEngine = (deps: GroupTurnDeps): GroupTurnEngine => ({
  wake: (groupId, agentId, botStarted) =>
    wake(deps, groupId, agentId, botStarted),
  settled: (execution) => settled(deps, execution),
});

/** Settles every turn whose execution the bots settle, until the layer closes. */
export const keepTurnsSettled = (deps: GroupTurnDeps) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      deps.context.bots.onSettled((execution) => {
        deps.context.state.fork(
          settled(deps, execution).pipe(
            logged("Settled execution handler failed", execution.id),
          ),
        );
      }),
    ),
    (stop) => Effect.sync(stop),
  );
