import { REPLY_ORIGIN } from "../contract/reply-event";
import { formatEntryId } from "../shared/entry-ids";
import { activeExecution, type Execution } from "../shared/domain";
import { logged, pi } from "../shared/app-errors";
import { Effect } from "effect";
import { groupPostRequest, groupTurnRequest } from "../shared/request-ids";
import { type Agent } from "../contract/agents";
import {
  GROUP_TURN_BUDGET,
  type GroupChat,
  type GroupMember,
  type GroupTurn,
} from "./group-chat-repository";
import type { AppError } from "../shared/errors";
import type { InputOrigin } from "../transcript/origins";
import { memberKey, type GroupChatContext } from "./group-chat-context";
import type { GroupChatMembers } from "./group-chat-members";
import { mentionsOwner } from "./group-mentions";
import type { GroupEntry, GroupPost } from "./group-transcripts";
import type { GroupTurnInput } from "./group-turn-input";
import { turnOutcome } from "./group-turn-outcome";
import { MESSAGE_PREVIEW_CHARS } from "../shared/limits";
import { nowIso } from "../shared/time";

/** Owner messages a group remembers as awaiting their first answer; older ones stop notifying. */
const AWAITING_ANSWERS = 50;

/** Everything that leads one turn to the next: the group's context, its members, and what a turn tells its bot. */
export type GroupTurnDeps = {
  readonly context: GroupChatContext;
  readonly members: GroupChatMembers;
  readonly input: GroupTurnInput;
};

export type PostedMessage = {
  entry: number;
  woken: string[];
  /** False when a retry found the message already written. */
  created: boolean;
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

/**
 * The part of group chats that leads one turn to the next. Every operation takes the group's locks itself: `wake` must
 * run inside `serial`, which cannot nest, so it stays private. Posting only takes the queue's lock, as a slow start
 * holds `serial`.
 */
export const groupTurnEngine = ({ context, members, input }: GroupTurnDeps) => {
  const { queueing } = context;

  const queueMember = Effect.fnUntraced(function* (
    groupId: string,
    agentId: string,
    botStarted: boolean,
  ) {
    const member = yield* context.groups.member(groupId, agentId);

    if (!member) return;
    context.state.pendingVersions.set(memberKey(groupId, agentId), Symbol());
    yield* context.groups.setMember(groupId, agentId, {
      pending: true,
      pendingBotStarted: member.pending
        ? member.pendingBotStarted && botStarted
        : botStarted,
    });
  });

  const consumePending = Effect.fnUntraced(
    function* (
      groupId: string,
      agentId: string,
      pendingVersion: symbol | undefined,
    ) {
      // A message accepted during startup must keep its follow-up queued.
      const key = memberKey(groupId, agentId);

      if (context.state.pendingVersions.get(key) === pendingVersion) {
        yield* context.groups.setMember(groupId, agentId, { pending: false });
        context.state.pendingVersions.delete(key);
      }
    },
    (effect, groupId) => context.queueing(groupId, effect),
  );

  const unseenFor = Effect.fnUntraced(function* (
    groupId: string,
    agentId: string,
    cursor: number,
  ) {
    return (yield* pi(() => context.transcripts.after(groupId, cursor))).filter(
      (entry) =>
        entry.sender.agentId !== agentId && entry.reaction === undefined,
    );
  });

  /** Charges a bot-started turn to the group's budget; false once the budget is spent and the group pauses. */
  const chargeTurn = Effect.fnUntraced(
    function* (groupId: string) {
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
    },
    (effect, groupId) => context.queueing(groupId, effect),
  );

  /** Forgets the owner messages this turn answers: the first answer from a bot one woke, in a turn that saw it. */
  const takeAnswered = Effect.fnUntraced(
    function* (groupId: string, turn: GroupTurn, agent: Agent) {
      const { awaitingAnswers } = yield* context.groups.activity(groupId);

      const answered = Object.entries(awaitingAnswers).filter(
        ([entry, targets]) =>
          Number(entry) <= turn.through && targets.includes(agent.id),
      );

      for (const [entry] of answered) delete awaitingAnswers[entry];

      if (answered.length)
        yield* context.groups.setActivity(groupId, { awaitingAnswers });

      return answered.length > 0;
    },
    (effect, groupId) => context.queueing(groupId, effect),
  );

  /**
   * Notifies the owner of the first bot answer to their newest message, if this turn saw it, and of any `@owner`.
   * The event ID is the turn's execution, so a retried post notifies once.
   */
  const notify = Effect.fnUntraced(function* (
    group: GroupChat,
    turn: GroupTurn,
    agent: Agent,
    entryId: string,
    text: string,
  ) {
    const answered = yield* takeAnswered(group.id, turn, agent);

    if (!answered && !mentionsOwner(text)) return;
    yield* context.bots.announce({
      type: "reply",
      executionId: turn.executionId,
      agentId: agent.id,
      agentName: agent.name,
      entryId,
      origin: REPLY_ORIGIN.group,
      preview: text.trim().slice(0, MESSAGE_PREVIEW_CHARS),
      createdAt: yield* nowIso,
      groupId: group.id,
      groupName: group.name,
    });
  });

  const wake = (
    groupId: string,
    agentId: string,
    botStarted: boolean,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const member = yield* context.groups.member(groupId, agentId);

      if (!member || !(yield* context.enabled(agentId))) return;

      if (botStarted && (yield* context.groups.activity(groupId)).paused) {
        if (member.pendingBotStarted)
          yield* context.groups.setMember(groupId, agentId, { pending: false });

        return;
      }

      if (yield* context.groups.activeTurn(groupId, agentId)) {
        yield* queueing(groupId, queueMember(groupId, agentId, botStarted));

        return;
      }

      yield* startTurn(groupId, agentId, botStarted).pipe(
        logged("Group turn could not start", groupId, agentId),
      );
    });

  const startTurn = (
    groupId: string,
    agentId: string,
    botStarted: boolean,
  ): Effect.Effect<void, AppError> =>
    Effect.gen(function* () {
      const group = yield* context.get(groupId);
      const member = (yield* context.groups.member(groupId, agentId))!;
      const agent = yield* context.bots.agent(agentId);

      const pendingVersion = context.state.pendingVersions.get(
        memberKey(groupId, agentId),
      );

      const unseen = yield* unseenFor(groupId, agentId, member.cursor);

      if (!unseen.length)
        return yield* consumePending(groupId, agentId, pendingVersion);

      const first = !(yield* context.groups.listTurns({ groupId })).some(
        (turn) => turn.agentId === agentId && turn.createdAt >= member.joinedAt,
      );

      // A member that joined after the first message waits, queued, for a summary of what came before.
      if (first && member.cursor > 0 && member.summary === null) {
        yield* queueing(groupId, queueMember(groupId, agentId, botStarted));
        yield* startSummary(groupId, agentId, member.cursor);

        return;
      }

      if (botStarted && !(yield* chargeTurn(groupId)))
        return yield* consumePending(groupId, agentId, pendingVersion);

      const conversationId =
        member.conversationId ??
        (yield* members.openConversation(group, agentId));

      yield* dispatchTurn({
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

  const dispatchTurn = (turn: TurnDispatch): Effect.Effect<void, AppError> =>
    Effect.gen(function* () {
      const { group, agent, member, unseen } = turn;
      const summary = turn.first ? member.summary : null;
      const requestId = groupTurnRequest(group.id, agent.id, turn.through);

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

      yield* consumePending(group.id, agent.id, turn.pendingVersion);

      // An execution that failed to start settled before its turn existed, so its settlement found nothing.
      if (!activeExecution(execution)) yield* finish(execution.id);
    });

  /**
   * Writes a joining member's summary outside the group's queue, so a slow model holds up nothing else, then starts
   * the turn it waited for unless the group was stopped or the member left meanwhile.
   */
  const startSummary = (
    groupId: string,
    agentId: string,
    cursor: number,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      const key = memberKey(groupId, agentId);

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
                yield* wake(groupId, agentId, member.pendingBotStarted);
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
    group: GroupChat,
    turn: GroupTurn,
    conversationId: string,
    submissionId: string,
  ): Effect.Effect<void, AppError> =>
    Effect.gen(function* () {
      const agent = yield* context.agents.get(turn.agentId);

      if (!agent) return;

      const outcome = yield* pi(() =>
        turnOutcome(context.runtime, agent, conversationId, submissionId),
      );

      if (outcome.kind === "pass") return;

      const sender = {
        kind: "bot",
        agentId: agent.id,
        name: agent.name,
      } satisfies InputOrigin;

      const requestId = groupPostRequest(turn.executionId);

      if (outcome.kind === "reaction") {
        yield* pi(() =>
          context.transcripts.post(
            group.id,
            {
              text: "",
              sender,
              reaction: outcome.emoji,
              replyTo: formatEntryId(group.id, turn.through),
            },
            requestId,
          ),
        );

        return;
      }

      const post: GroupPost = { text: outcome.text, sender };

      if (outcome.sources.length > 0) post.sources = outcome.sources;

      const entryId = yield* pi(() =>
        context.transcripts.post(group.id, post, requestId),
      );

      yield* context.changed(group.id);
      yield* notify(group, turn, agent, entryId, outcome.text);

      for (const agentId of yield* members.mentions(
        group,
        outcome.text,
        agent.id,
      ))
        yield* wake(group.id, agentId, true);
    });

  const startWaiting = (groupId: string, agentId: string) =>
    Effect.gen(function* () {
      const current = (yield* context.groups.member(groupId, agentId))!;

      if (current.pending)
        yield* wake(groupId, agentId, current.pendingBotStarted);

      yield* context.changed(groupId);
    });

  /** Posts a settled turn's outcome once, advances the member, and starts its waiting turn. */
  const finish = (executionId: string): Effect.Effect<void, AppError> =>
    Effect.gen(function* () {
      const turn = yield* context.groups.getTurn(executionId);
      const execution = yield* context.executions.get(executionId);

      if (!turn || turn.status === "settled" || !execution) return;
      yield* context.groups.updateTurn(executionId, { status: "posting" });
      const group = yield* context.groups.get(turn.groupId);
      const member = yield* context.groups.member(turn.groupId, turn.agentId);

      if (!group || !member) {
        yield* context.groups.updateTurn(executionId, { status: "settled" });

        return;
      }

      if (execution.status === "done" && execution.submissionId)
        yield* publish(
          group,
          turn,
          execution.conversationId,
          execution.submissionId,
        );

      yield* context.groups.updateTurn(executionId, { status: "settled" });

      // A stopped or failed turn leaves its messages unseen, so the member's next turn includes them.
      if (execution.status === "done")
        yield* context.groups.setMember(group.id, turn.agentId, {
          cursor: Math.max(member.cursor, turn.through),
        });

      yield* startWaiting(group.id, turn.agentId);
    });

  const settled = Effect.fnUntraced(function* (execution: Execution) {
    const turn = yield* context.groups.getTurn(execution.id);

    if (!turn || turn.status === "settled") return;

    yield* context.serial(turn.groupId, finish(turn.executionId));
  });

  /** Remembers this message as awaiting its first answer, forgetting the oldest ones, and re-arms bot turns. */
  const rememberAwaitingAnswers = Effect.fnUntraced(function* (
    groupId: string,
    posted: number,
    woken: string[],
  ) {
    const { awaitingAnswers } = yield* context.groups.activity(groupId);

    const entries = Object.keys(awaitingAnswers)
      .map(Number)
      .sort((a, b) => a - b);

    for (const entry of entries.slice(
      0,
      Math.max(0, entries.length - AWAITING_ANSWERS + 1),
    ))
      delete awaitingAnswers[entry];

    awaitingAnswers[posted] = yield* Effect.filter(woken, context.enabled);
    yield* context.groups.setActivity(groupId, {
      botTurns: 0,
      paused: false,
      awaitingAnswers,
    });
  });

  /** Queues a turn for every woken member that has messages left and is not already running one. */
  const queueWoken = Effect.fnUntraced(function* (
    groupId: string,
    woken: string[],
    through: number,
    created: boolean,
  ) {
    for (const agentId of woken) {
      const member = yield* context.groups.member(groupId, agentId);
      const turn = yield* context.groups.activeTurn(groupId, agentId);

      if (
        member &&
        (yield* context.enabled(agentId)) &&
        member.cursor < through &&
        (created || !member.pending) &&
        (!turn || turn.through < through)
      )
        yield* queueMember(groupId, agentId, false);
    }
  });

  /** Records a posted message. A retried post routes again, but neither resumes the bots nor re-arms its notification. */
  const queue = (groupId: string, message: PostedMessage) =>
    queueing(
      groupId,
      Effect.gen(function* () {
        const { entry, woken, created } = message;

        if (created) yield* rememberAwaitingAnswers(groupId, entry, woken);

        yield* queueWoken(groupId, woken, entry, created);
      }),
    );

  /** Starts the waiting turns of these members. */
  const startQueued = (groupId: string, agentIds: string[]) =>
    context.serial(
      groupId,
      Effect.gen(function* () {
        for (const agentId of agentIds) {
          const member = yield* context.groups.member(groupId, agentId);

          if (
            member?.pending &&
            !(yield* context.groups.activeTurn(groupId, agentId))
          )
            yield* wake(groupId, agentId, member.pendingBotStarted);
        }

        yield* context.changed(groupId);
      }),
    );

  return { queue, startQueued, settled };
};

export type GroupTurnEngine = ReturnType<typeof groupTurnEngine>;

/** Settles every turn whose execution the bots settle, until the layer closes. */
export const keepTurnsSettled = (
  context: GroupChatContext,
  engine: GroupTurnEngine,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      context.bots.onSettled((execution) => {
        context.state.fork(
          engine
            .settled(execution)
            .pipe(logged("Settled execution handler failed", execution.id)),
        );
      }),
    ),
    (stop) => Effect.sync(stop),
  );
