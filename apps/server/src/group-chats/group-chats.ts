import {
  Cause,
  Context,
  Effect,
  FiberSet,
  Layer,
  ManagedRuntime,
  Semaphore,
} from "effect";
import {
  AppError,
  GROUP_TURN_BUDGET,
  type Agent,
  type Execution,
  type GroupChat,
  type GroupChatInput,
  type GroupTurn,
} from "../shared/domain";
import { appErrors } from "../shared/app-errors";
import {
  MAX_ATTACHMENTS,
  attachmentKind,
  prepareAttachments,
  type AttachmentInput,
} from "../shared/attachments";
import { AgentRepository } from "../bots/agent-repository";
import { Bots, GROUP_TURN_PREFIX } from "../bots/bots";
import { ConversationRepository } from "../bots/conversation-repository";
import { ExecutionRepository } from "../bots/execution-repository";
import { BotRuntime } from "../bots/runtime";
import type { TranscriptPage } from "../bots/transcript";
import type { Runner } from "../shared/runner";
import { GroupChatRepository } from "./group-chat-repository";
import { mentionedMembers, mentionsOwner } from "./group-mentions";
import type { GroupEntry, GroupTranscripts } from "./group-transcripts";

export type GroupMemberActivity = {
  agentId: string;
  status: "idle" | "queued" | "running" | "disabled";
  /** Why the member's latest turn failed; null after a turn that did not fail. */
  error: string | null;
};

export type GroupActivity = {
  /** Bot-started turns are paused until the owner's next message. */
  paused: boolean;
  botTurns: number;
  members: GroupMemberActivity[];
};

export type GroupChatSnapshot = TranscriptPage & {
  groupChat: GroupChat;
  activity: GroupActivity;
  updatedAt: number;
};

export type GroupMessageReceipt = { requestId: string; entryId: string };

type PageOptions = {
  before?: string | undefined;
  limit?: number | undefined;
};

/** An uploaded file of a group message, as clients download it. */
type GroupAttachment = Awaited<ReturnType<GroupTranscripts["attachment"]>>;

export type GroupMembership = {
  id: string;
  name: string;
  members: string[];
  latestAt: string | null;
};

/** Owner messages a group remembers as awaiting their first answer; older ones stop notifying. */
const AWAITING_ANSWERS = 50;

/** How long a joining member's summary may take before its turn starts without one. */
const SUMMARY_TIMEOUT_MS = 60_000;

/** Characters of earlier messages a joining member's summary is written from, newest first. */
const SUMMARY_INPUT_CHARACTERS = 40_000;

const senderName = (entry: GroupEntry) =>
  entry.sender.kind === "owner" ? "Owner" : (entry.sender.name ?? "A bot");

const active = (execution: Execution) =>
  execution.status === "pending" || execution.status === "running";

/** Each group chat's shared transcript files, closed with the layer's scope. */
export class GroupTranscriptStore extends Context.Service<
  GroupTranscriptStore,
  GroupTranscripts
>()("crumble/group-chats/GroupTranscriptStore") {
  static layer(make: () => GroupTranscripts) {
    return Layer.effect(
      GroupTranscriptStore,
      Effect.acquireRelease(Effect.sync(make), (transcripts) =>
        Effect.promise(() => transcripts.close()),
      ),
    );
  }
}

/** Group chats between the owner and several bots: membership, the shared transcript, turns, and change notifications. */
export class GroupChats extends Context.Service<
  GroupChats,
  {
    readonly list: Effect.Effect<GroupChat[]>;
    readonly get: (groupId: string) => Effect.Effect<GroupChat, AppError>;
    readonly create: (
      input: GroupChatInput,
    ) => Effect.Effect<GroupChat, AppError>;
    readonly update: (
      groupId: string,
      input: GroupChatInput,
    ) => Effect.Effect<GroupChat, AppError>;
    readonly delete: (groupId: string) => Effect.Effect<void, AppError>;
    readonly post: (
      groupId: string,
      content: string,
      requestId: string,
      options?: {
        replyTo?: string | undefined;
        attachments?: AttachmentInput[] | undefined;
      },
    ) => Effect.Effect<GroupMessageReceipt, AppError>;
    /** Ends every running turn in the group and drops the queued ones. */
    readonly stop: (groupId: string) => Effect.Effect<void, AppError>;
    readonly activity: (
      groupId: string,
    ) => Effect.Effect<GroupActivity, AppError>;
    readonly attachment: (
      groupId: string,
      entryId: string,
      index: number,
    ) => Effect.Effect<GroupAttachment, AppError>;
    /** The groups a bot belongs to, with their members' names and newest message time, for its lookup tool. */
    readonly forMember: (agentId: string) => Effect.Effect<GroupMembership[]>;
    /** A page of a group's transcript, for a bot that is one of its members. */
    readonly readAsMember: (
      agentId: string,
      groupId: string,
      options: PageOptions,
    ) => Effect.Effect<TranscriptPage, AppError>;
    readonly history: (
      groupId: string,
      options: PageOptions,
    ) => Effect.Effect<TranscriptPage, AppError>;
    readonly snapshot: (
      groupId: string,
      options: { limit?: number | undefined },
    ) => Effect.Effect<GroupChatSnapshot, AppError>;
    /** Calls `callback` when the group changes, until the returned function is called. */
    readonly subscribe: (groupId: string, callback: () => void) => () => void;
    /** Finishes turns a restart interrupted, then starts the turns that were waiting. Run after the bots recover. */
    readonly recover: Effect.Effect<void, AppError>;
  }
>()("crumble/group-chats/GroupChats") {
  static readonly layer = Layer.effect(
    GroupChats,
    Effect.gen(function* () {
      const groups = yield* GroupChatRepository;
      const agents = yield* AgentRepository;
      const executions = yield* ExecutionRepository;
      const conversations = yield* ConversationRepository;
      const transcripts = yield* GroupTranscriptStore;
      const bots = yield* Bots;
      const runtime = yield* BotRuntime;

      const listeners = new Map<string, Set<() => void>>();
      /** Members whose joining summary is being written, as `group:agent`. */
      const summarizing = new Set<string>();
      const pendingVersions = new Map<string, symbol>();
      // Turn state changes run one at a time per group, so a member never gets two turns.
      const locks = new Map<string, Semaphore.Semaphore>();
      // Closing interrupts background work between steps; the step in progress finishes, and recovery resumes the rest.
      const background = yield* FiberSet.make();
      const fork = yield* FiberSet.runtime(background)<never>();

      const pi = <A>(run: () => Promise<A>) =>
        appErrors(Effect.tryPromise({ try: run, catch: (error) => error }));

      const logged = (label: string, ...subjects: string[]) =>
        Effect.catchCause((cause: Cause.Cause<unknown>) =>
          Effect.logError(label, ...subjects, Cause.squash(cause)),
        );

      const serial = <A, E>(groupId: string, work: Effect.Effect<A, E>) => {
        let lock = locks.get(groupId);

        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(groupId, lock);
        }

        return Semaphore.withPermit(lock, Effect.uninterruptible(work));
      };

      const changed = (groupId: string) =>
        Effect.sync(() => {
          for (const listener of listeners.get(groupId) ?? []) listener();
        });

      const get = Effect.fn("GroupChats.get")(function* (groupId: string) {
        const group = yield* groups.get(groupId);

        if (!group)
          return yield* Effect.fail(new AppError(404, "Group chat not found"));

        return group;
      });

      const enabled = (agentId: string) =>
        agents
          .get(agentId)
          .pipe(Effect.map((agent) => agent?.enabled === true));

      const checkMembers = Effect.fnUntraced(function* (memberIds: string[]) {
        for (const agentId of memberIds)
          if (!(yield* agents.get(agentId)))
            return yield* Effect.fail(
              new AppError(400, "Choose existing bots as members"),
            );
      });

      /** Members a message wakes: its mentions and, for a reply, the bot it answers. */
      const mentions = Effect.fnUntraced(function* (
        group: GroupChat,
        text: string,
        senderId: string | undefined,
        replyTarget?: GroupEntry,
      ) {
        const members = (yield* Effect.forEach(group.memberIds, (agentId) =>
          agents.get(agentId),
        )).flatMap((agent) =>
          agent ? [{ id: agent.id, name: agent.name }] : [],
        );

        const found = mentionedMembers(text, members, senderId);
        const repliedTo = replyTarget?.sender.agentId;

        if (
          repliedTo &&
          repliedTo !== senderId &&
          group.memberIds.includes(repliedTo) &&
          !found.includes(repliedTo)
        )
          found.unshift(repliedTo);

        return found;
      });

      const queueMember = Effect.fnUntraced(function* (
        groupId: string,
        agentId: string,
        botStarted: boolean,
      ) {
        const member = yield* groups.member(groupId, agentId);

        if (!member) return;
        pendingVersions.set(`${groupId}:${agentId}`, Symbol());
        yield* groups.setMember(groupId, agentId, {
          pending: true,
          pendingBotStarted: member.pending
            ? member.pendingBotStarted && botStarted
            : botStarted,
        });
      });

      const openConversation = Effect.fnUntraced(function* (
        group: GroupChat,
        agentId: string,
      ) {
        const agent = yield* bots.agent(agentId);
        // Opening the bot chat first keeps an upgraded bot's chat from adopting the group conversation as its session.
        yield* bots.chat(agentId);

        const conversationId = yield* pi(() =>
          runtime.openGroupConversation(agent, group.id),
        );

        yield* conversations.create(
          { agentId, title: group.name },
          conversationId,
        );
        yield* groups.setMember(group.id, agentId, { conversationId });

        return conversationId;
      });

      /** The messages up to `cursor`, newest first until the summary budget, summarized by the joining bot's model. */
      const summarize = Effect.fnUntraced(function* (
        groupId: string,
        agent: Agent,
        cursor: number,
      ) {
        const earlier = (yield* pi(() => transcripts.after(groupId, 0))).filter(
          (entry) => entry.entry <= cursor && entry.reaction === undefined,
        );

        const lines: string[] = [];
        let length = 0;

        for (const entry of earlier.toReversed()) {
          const line = `${senderName(entry)}: ${entry.text}`;

          if (length + line.length > SUMMARY_INPUT_CHARACTERS) break;
          lines.unshift(line);
          length += line.length;
        }

        return yield* Effect.tryPromise({
          try: () =>
            runtime.summarize(
              agent,
              lines.join("\n\n"),
              AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
            ),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.logError(
              "Group summary failed",
              groupId,
              agent.id,
              error,
            ).pipe(
              Effect.as("The earlier conversation could not be summarized."),
            ),
          ),
        );
      });

      /**
       * The uploads of a turn's unseen messages, newest messages first up to the attachment limit, in message order.
       * Images are left out, by name, for a model that cannot read them.
       */
      const turnAttachments = Effect.fnUntraced(function* (
        agent: Agent,
        unseen: GroupEntry[],
      ) {
        const images = yield* pi(() => runtime.acceptsImages(agent));
        const attachments: AttachmentInput[] = [];
        const omitted: string[] = [];

        for (const entry of unseen.toReversed())
          for (const item of (entry.attachments ?? []).toReversed()) {
            if (!images && attachmentKind(item.mimeType) === "image")
              omitted.unshift(item.name);
            else if (attachments.length < MAX_ATTACHMENTS)
              attachments.unshift(item);
          }

        return { attachments, omitted };
      });

      const turnInput = Effect.fnUntraced(function* (
        group: GroupChat,
        name: string,
        unseen: GroupEntry[],
      ) {
        const members = (yield* Effect.forEach(group.memberIds, (agentId) =>
          agents.get(agentId),
        ))
          .map((agent) => agent?.name)
          .filter((member) => member !== undefined && member !== name);

        const messages = unseen.map((entry) => {
          const reply =
            entry.replyPreview === undefined
              ? ""
              : ` (replying to "${entry.replyPreview.slice(0, 120)}")`;

          const files = entry.files?.length
            ? ` [attached: ${entry.files.map((file) => file.name).join(", ")}]`
            : "";

          return `${senderName(entry)}${reply}: ${entry.text}${files}`;
        });

        return `Group chat ${JSON.stringify(group.name)}. You are ${name}; the other members are the owner and ${members.join(", ") || "no other bots"}.\n\nNew messages:\n\n${messages.join("\n\n")}`;
      });

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
        const { awaitingAnswers } = yield* groups.activity(group.id);

        // The first answer from a bot an owner message woke, in a turn that saw it, answers that message.
        const answered = Object.entries(awaitingAnswers).filter(
          ([entry, targets]) =>
            Number(entry) <= turn.through && targets.includes(agent.id),
        );

        for (const [entry] of answered) delete awaitingAnswers[entry];

        if (answered.length)
          yield* groups.setActivity(group.id, { awaitingAnswers });

        if (!answered.length && !mentionsOwner(text)) return;
        yield* bots.announce({
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

      /** Stops the member's turn and drops its queued one; a stopped turn posts nothing. Reports whether there was any. */
      const abortTurn = Effect.fnUntraced(function* (
        groupId: string,
        agentId: string,
      ) {
        const member = yield* groups.member(groupId, agentId);
        const queued = member?.pending === true;

        if (queued)
          yield* groups.setMember(groupId, agentId, { pending: false });
        const turn = yield* groups.activeTurn(groupId, agentId);
        const execution = turn ? yield* executions.get(turn.executionId) : null;

        if (!execution || !active(execution)) return queued;
        yield* bots.abort(execution.conversationId);

        return true;
      });

      // `wake`, `startTurn`, `finish`, and `publish` call each other as turns lead to turns.
      const wake = (
        groupId: string,
        agentId: string,
        botStarted: boolean,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const member = yield* groups.member(groupId, agentId);

          if (!member || !(yield* enabled(agentId))) return;

          if (botStarted && (yield* groups.activity(groupId)).paused) {
            if (member.pendingBotStarted)
              yield* groups.setMember(groupId, agentId, { pending: false });

            return;
          }

          if (yield* groups.activeTurn(groupId, agentId)) {
            yield* queueMember(groupId, agentId, botStarted);

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
          const group = yield* get(groupId);
          const member = (yield* groups.member(groupId, agentId))!;
          const agent = yield* bots.agent(agentId);
          const key = `${groupId}:${agentId}`;
          const pendingVersion = pendingVersions.get(key);

          const consumePending = Effect.gen(function* () {
            // A message accepted during startup must keep its follow-up queued.
            if (pendingVersions.get(key) === pendingVersion) {
              yield* groups.setMember(groupId, agentId, { pending: false });
              pendingVersions.delete(key);
            }
          });

          const unseen = (yield* pi(() =>
            transcripts.after(groupId, member.cursor),
          )).filter(
            (entry) =>
              entry.sender.agentId !== agentId && entry.reaction === undefined,
          );

          if (!unseen.length) return yield* consumePending;

          const first = !(yield* groups.listTurns({ groupId })).some(
            (turn) =>
              turn.agentId === agentId && turn.createdAt >= member.joinedAt,
          );

          // A member that joined after the first message waits, queued, for a summary of what came before.
          if (first && member.cursor > 0 && member.summary === null) {
            yield* queueMember(groupId, agentId, botStarted);
            yield* startSummary(groupId, agentId, member.cursor);

            return;
          }

          const activity = yield* groups.activity(groupId);

          if (botStarted) {
            if (activity.botTurns >= GROUP_TURN_BUDGET) {
              yield* groups.setActivity(groupId, { paused: true });

              return yield* consumePending;
            }

            yield* groups.setActivity(groupId, {
              botTurns: activity.botTurns + 1,
              paused: activity.botTurns + 1 >= GROUP_TURN_BUDGET,
            });
          }

          const conversationId =
            member.conversationId ?? (yield* openConversation(group, agentId));

          const summary = first ? member.summary : null;
          const through = unseen.at(-1)!.entry;
          const requestId = `${GROUP_TURN_PREFIX}${groupId}:${agentId}:${through}`;

          const { attachments, omitted } = yield* turnAttachments(
            agent,
            unseen,
          );

          const input = `${summary ? `Summary of the conversation before you joined:\n\n${summary}\n\n` : ""}${yield* turnInput(group, agent.name, unseen)}${omitted.length ? `\n\nYour model cannot read images, so these were left out: ${omitted.join(", ")}.` : ""}`;

          const execution =
            (yield* executions.getByRequest(conversationId, requestId)) ??
            (yield* bots
              .send(conversationId, input, requestId, { attachments })
              .pipe(
                // A failed admission still leaves its execution; its settlement reports the failure.
                Effect.catchCause((cause) =>
                  executions
                    .getByRequest(conversationId, requestId)
                    .pipe(
                      Effect.flatMap((left) =>
                        left ? Effect.succeed(left) : Effect.failCause(cause),
                      ),
                    ),
                ),
              ));

          if (!(yield* groups.getTurn(execution.id)))
            yield* groups.createTurn({
              executionId: execution.id,
              groupId,
              agentId,
              through,
              botStarted,
              status: "running",
            });

          yield* consumePending;

          // An execution that failed to start settled before its turn existed, so its settlement found nothing.
          if (!active(execution)) yield* finish(execution.id);
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
          const key = `${groupId}:${agentId}`;

          if (summarizing.has(key)) return;
          summarizing.add(key);

          fork(
            Effect.gen(function* () {
              const agent = yield* agents.get(agentId);

              const summary = agent
                ? yield* summarize(groupId, agent, cursor)
                : null;

              yield* serial(
                groupId,
                Effect.gen(function* () {
                  const member = yield* groups.member(groupId, agentId);

                  if (!member || summary === null) return;
                  yield* groups.setMember(groupId, agentId, { summary });

                  if (member.pending)
                    yield* wake(groupId, agentId, member.pendingBotStarted);
                  yield* changed(groupId);
                }),
              );
            }).pipe(
              logged("Group summary failed", groupId, agentId),
              Effect.ensuring(Effect.sync(() => summarizing.delete(key))),
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
          const agent = yield* agents.get(turn.agentId);

          if (!agent) return;

          const outcome = yield* pi(() =>
            runtime.turnOutcome(agent, conversationId, submissionId),
          );

          if (outcome.kind === "pass") return;
          const sender = { kind: "bot", agentId: agent.id, name: agent.name };
          const requestId = `${GROUP_TURN_PREFIX}${turn.executionId}`;

          if (outcome.kind === "reaction") {
            yield* pi(() =>
              transcripts.post(
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
            transcripts.post(
              group.id,
              { text: outcome.text, sender },
              requestId,
            ),
          );

          yield* changed(group.id);
          yield* notify(group, turn, agent, entryId, outcome.text);

          for (const agentId of yield* mentions(group, outcome.text, agent.id))
            yield* wake(group.id, agentId, true);
        });

      /** Posts a settled turn's outcome once, advances the member, and starts its waiting turn. */
      const finish = (executionId: string): Effect.Effect<void, AppError> =>
        Effect.gen(function* () {
          const turn = yield* groups.getTurn(executionId);
          const execution = yield* executions.get(executionId);

          if (!turn || turn.status === "settled" || !execution) return;
          yield* groups.updateTurn(executionId, { status: "posting" });
          const group = yield* groups.get(turn.groupId);
          const member = yield* groups.member(turn.groupId, turn.agentId);

          if (
            group &&
            member &&
            execution.status === "done" &&
            execution.submissionId
          )
            yield* publish(
              group,
              turn,
              execution.conversationId,
              execution.submissionId,
            );

          yield* groups.updateTurn(executionId, { status: "settled" });

          if (!group || !member) return;

          // A stopped or failed turn leaves its messages unseen, so the member's next turn includes them.
          if (execution.status === "done")
            yield* groups.setMember(group.id, turn.agentId, {
              cursor: Math.max(member.cursor, turn.through),
            });

          const current = (yield* groups.member(group.id, turn.agentId))!;

          if (current.pending)
            yield* wake(group.id, turn.agentId, current.pendingBotStarted);

          yield* changed(group.id);
        });

      const settled = Effect.fnUntraced(function* (execution: Execution) {
        const turn = yield* groups.getTurn(execution.id);

        if (!turn || turn.status === "settled") return;

        yield* serial(turn.groupId, finish(turn.executionId));
      });

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          bots.onSettled((execution) => {
            fork(
              settled(execution).pipe(
                logged("Settled execution handler failed", execution.id),
              ),
            );
          }),
        ),
        (stop) => Effect.sync(stop),
      );

      const activity = Effect.fn("GroupChats.activity")(function* (
        groupId: string,
      ) {
        const group = yield* get(groupId);
        const { botTurns, paused } = yield* groups.activity(groupId);
        const turns = yield* groups.listTurns({ groupId });

        return {
          paused,
          botTurns,
          members: yield* Effect.forEach(
            group.memberIds,
            Effect.fnUntraced(function* (agentId) {
              const member = yield* groups.member(groupId, agentId);
              const latest = turns.findLast((turn) => turn.agentId === agentId);

              const execution = latest
                ? yield* executions.get(latest.executionId)
                : null;

              const status: GroupMemberActivity["status"] = !(yield* enabled(
                agentId,
              ))
                ? "disabled"
                : (yield* groups.activeTurn(groupId, agentId))
                  ? "running"
                  : member?.pending
                    ? "queued"
                    : "idle";

              return {
                agentId,
                status,
                error: execution?.status === "failed" ? execution.error : null,
              };
            }),
          ),
        };
      });

      const stop = Effect.fn("GroupChats.stop")(function* (groupId: string) {
        const group = yield* get(groupId);

        yield* serial(
          groupId,
          Effect.gen(function* () {
            let stopped = false;

            for (const agentId of group.memberIds)
              stopped = (yield* abortTurn(groupId, agentId)) || stopped;

            if (stopped) yield* changed(groupId);
          }),
        );
      });

      const history = Effect.fn("GroupChats.history")(function* (
        groupId: string,
        options: PageOptions,
      ) {
        yield* get(groupId);

        return yield* pi(() => transcripts.history(groupId, options));
      });

      return GroupChats.of({
        list: groups.list,
        get,
        create: Effect.fn("GroupChats.create")(function* (
          input: GroupChatInput,
        ) {
          yield* checkMembers(input.memberIds);

          return yield* groups.create(input);
        }),
        update: Effect.fn("GroupChats.update")(function* (
          groupId: string,
          input: GroupChatInput,
        ) {
          const current = yield* get(groupId);
          yield* checkMembers(input.memberIds);

          return yield* serial(
            groupId,
            Effect.gen(function* () {
              const latest = yield* pi(() => transcripts.latest(groupId));
              const group = (yield* groups.update(groupId, input))!;

              // A new member starts with the messages that follow its joining; its summary of earlier ones comes later.
              for (const agentId of input.memberIds)
                if (!current.memberIds.includes(agentId))
                  yield* groups.setMember(groupId, agentId, { cursor: latest });

              for (const agentId of current.memberIds)
                if (!input.memberIds.includes(agentId))
                  yield* abortTurn(groupId, agentId);
              yield* changed(groupId);

              return group;
            }),
          );
        }),
        delete: Effect.fn("GroupChats.delete")(function* (groupId: string) {
          const group = yield* get(groupId);
          yield* stop(groupId);

          // Queued behind the stop and the settling of the turns it stopped, so no turn posts into a deleted group.
          yield* serial(
            groupId,
            Effect.gen(function* () {
              // Remove the transcript first: a failure then leaves a group with an empty transcript, not an orphaned file.
              yield* pi(() => transcripts.delete(groupId));

              for (const agentId of group.memberIds) {
                const conversationId = (yield* groups.member(groupId, agentId))
                  ?.conversationId;

                if (conversationId)
                  yield* conversations.setArchived(conversationId, true);
              }

              yield* groups.delete(groupId);
              yield* changed(groupId);
            }),
          );
        }),
        post: Effect.fn("GroupChats.post")(function* (
          groupId: string,
          content: string,
          requestId: string,
          options: {
            replyTo?: string | undefined;
            attachments?: AttachmentInput[] | undefined;
          } = {},
        ) {
          yield* get(groupId);
          const attachments = options.attachments ?? [];

          // Validate before anything is written, so a bad file never leaves a message behind.
          const { info } = yield* appErrors(
            Effect.try({
              try: () => prepareAttachments(attachments),
              catch: (error) => error,
            }),
          );

          const replyTo = options.replyTo;

          const target = replyTo
            ? yield* pi(() => transcripts.message(groupId, replyTo))
            : undefined;

          if (replyTo && !target)
            return yield* Effect.fail(
              new AppError(400, "Reply to a message in this group chat"),
            );

          const { entryId, created } = yield* pi(() =>
            transcripts.write(
              groupId,
              {
                text: content,
                sender: { kind: "owner" },
                ...(attachments.length && { attachments, files: info }),
                ...(target && {
                  replyTo: target.entryId,
                  replyPreview: target.text.slice(0, 240),
                }),
              },
              requestId,
            ),
          );

          const group = yield* get(groupId);
          const mentioned = yield* mentions(group, content, undefined, target);
          const woken = mentioned.length ? mentioned : group.memberIds;

          // A retried post routes again, but neither resumes the bots nor re-arms its notification.
          if (created) {
            const { awaitingAnswers } = yield* groups.activity(groupId);

            const entries = Object.keys(awaitingAnswers)
              .map(Number)
              .sort((a, b) => a - b);

            for (const entry of entries.slice(
              0,
              Math.max(0, entries.length - AWAITING_ANSWERS + 1),
            ))
              delete awaitingAnswers[entry];

            awaitingAnswers[entryId.slice(groupId.length + 1)] =
              yield* Effect.filter(woken, enabled);
            yield* groups.setActivity(groupId, {
              botTurns: 0,
              paused: false,
              awaitingAnswers,
            });
          }

          const through = Number(entryId.slice(groupId.length + 1));

          for (const agentId of woken) {
            const member = yield* groups.member(groupId, agentId);
            const turn = yield* groups.activeTurn(groupId, agentId);

            if (
              member &&
              (yield* enabled(agentId)) &&
              member.cursor < through &&
              (created || !member.pending) &&
              (!turn || turn.through < through)
            )
              yield* queueMember(groupId, agentId, false);
          }

          yield* changed(groupId);

          fork(
            serial(
              groupId,
              Effect.gen(function* () {
                for (const agentId of woken) {
                  const member = yield* groups.member(groupId, agentId);

                  if (
                    member?.pending &&
                    !(yield* groups.activeTurn(groupId, agentId))
                  )
                    yield* wake(groupId, agentId, member.pendingBotStarted);
                }

                yield* changed(groupId);
              }),
            ).pipe(logged("Group turns could not start", groupId)),
          );

          return { requestId, entryId };
        }),
        stop,
        activity,
        attachment: Effect.fn("GroupChats.attachment")(function* (
          groupId: string,
          entryId: string,
          index: number,
        ) {
          yield* get(groupId);

          return yield* pi(() =>
            transcripts.attachment(groupId, entryId, index),
          );
        }),
        forMember: Effect.fn("GroupChats.forMember")(function* (
          agentId: string,
        ) {
          return yield* Effect.forEach(
            (yield* groups.list).filter((group) =>
              group.memberIds.includes(agentId),
            ),
            Effect.fnUntraced(function* (group) {
              const [latest] = (yield* Effect.promise(() =>
                transcripts.history(group.id, { limit: 1 }),
              )).messages;

              const members = yield* Effect.forEach(group.memberIds, (id) =>
                agents
                  .get(id)
                  .pipe(Effect.map((agent) => agent?.name ?? "A deleted bot")),
              );

              return {
                id: group.id,
                name: group.name,
                members,
                latestAt: latest?.timestamp
                  ? new Date(latest.timestamp).toISOString()
                  : null,
              };
            }),
            { concurrency: "unbounded" },
          );
        }),
        readAsMember: Effect.fn("GroupChats.readAsMember")(function* (
          agentId: string,
          groupId: string,
          options: PageOptions,
        ) {
          const group = yield* groups.get(groupId);

          if (!group?.memberIds.includes(agentId))
            return yield* Effect.fail(
              new AppError(404, "Group chat not found"),
            );

          return yield* pi(() => transcripts.history(groupId, options));
        }),
        history,
        snapshot: Effect.fn("GroupChats.snapshot")(function* (
          groupId: string,
          options: { limit?: number | undefined },
        ) {
          const groupChat = yield* get(groupId);
          const page = yield* pi(() => transcripts.history(groupId, options));

          return {
            ...page,
            groupChat,
            activity: yield* activity(groupId),
            updatedAt: Date.now(),
          };
        }),
        subscribe: (groupId, callback) => {
          const set = listeners.get(groupId) ?? new Set();
          set.add(callback);
          listeners.set(groupId, set);

          return () => {
            set.delete(callback);

            if (!set.size) listeners.delete(groupId);
          };
        },
        recover: Effect.gen(function* () {
          for (const turn of yield* groups.listTurns({
            status: ["running", "posting"],
          })) {
            const execution = yield* executions.get(turn.executionId);

            if (execution && !active(execution)) yield* settled(execution);
          }

          for (const group of yield* groups.list)
            yield* serial(
              group.id,
              Effect.gen(function* () {
                for (const agentId of group.memberIds) {
                  const member = yield* groups.member(group.id, agentId);

                  if (
                    member?.pending &&
                    !(yield* groups.activeTurn(group.id, agentId))
                  )
                    yield* wake(group.id, agentId, member.pendingBotStarted);
                }
              }),
            );
        }),
      });
    }),
  );
}

/** Group chats for code outside Effect, such as the HTTP handlers, with the API they had. */
export type GroupChatsAccess = {
  list(): GroupChat[];
  get(groupId: string): GroupChat;
  create(input: GroupChatInput): GroupChat;
  update(groupId: string, input: GroupChatInput): Promise<GroupChat>;
  delete(groupId: string): Promise<void>;
  post(
    groupId: string,
    content: string,
    requestId: string,
    options?: {
      replyTo?: string | undefined;
      attachments?: AttachmentInput[] | undefined;
    },
  ): Promise<GroupMessageReceipt>;
  stop(groupId: string): Promise<void>;
  activity(groupId: string): GroupActivity;
  attachment(
    groupId: string,
    entryId: string,
    index: number,
  ): Promise<GroupAttachment>;
  forMember(agentId: string): Promise<GroupMembership[]>;
  readAsMember(
    agentId: string,
    groupId: string,
    options: PageOptions,
  ): Promise<TranscriptPage>;
  history(groupId: string, options: PageOptions): Promise<TranscriptPage>;
  snapshot(
    groupId: string,
    options: { limit?: number | undefined },
  ): Promise<GroupChatSnapshot>;
  subscribe(groupId: string, callback: () => void): () => void;
  recover(): Promise<void>;
};

export const groupChatsAccess = (
  chats: GroupChats["Service"],
): GroupChatsAccess => ({
  list: () => Effect.runSync(chats.list),
  get: (groupId) => Effect.runSync(chats.get(groupId)),
  create: (input) => Effect.runSync(chats.create(input)),
  update: (groupId, input) => Effect.runPromise(chats.update(groupId, input)),
  delete: (groupId) => Effect.runPromise(chats.delete(groupId)),
  post: (groupId, content, requestId, options) =>
    Effect.runPromise(chats.post(groupId, content, requestId, options)),
  stop: (groupId) => Effect.runPromise(chats.stop(groupId)),
  activity: (groupId) => Effect.runSync(chats.activity(groupId)),
  attachment: (groupId, entryId, index) =>
    Effect.runPromise(chats.attachment(groupId, entryId, index)),
  forMember: (agentId) => Effect.runPromise(chats.forMember(agentId)),
  readAsMember: (agentId, groupId, options) =>
    Effect.runPromise(chats.readAsMember(agentId, groupId, options)),
  history: (groupId, options) =>
    Effect.runPromise(chats.history(groupId, options)),
  snapshot: (groupId, options) =>
    Effect.runPromise(chats.snapshot(groupId, options)),
  subscribe: chats.subscribe,
  recover: () => Effect.runPromise(chats.recover),
});

/**
 * Group chats over standalone bots and `transcripts`, for a test without an account. Closing them stops their
 * background work and closes the transcripts; the bots stay open.
 */
export function standaloneGroupChats(
  bots: {
    effects: Runner<
      | Bots
      | BotRuntime
      | AgentRepository
      | ExecutionRepository
      | ConversationRepository
    >;
    store: { runtime: Runner<GroupChatRepository> };
  },
  transcripts: GroupTranscripts,
): GroupChatsAccess & {
  service: GroupChats["Service"];
  close(): Promise<void>;
} {
  const chats = ManagedRuntime.make(
    GroupChats.layer.pipe(
      Layer.provide(GroupTranscriptStore.layer(() => transcripts)),
      Layer.provide(
        Layer.succeedContext(
          bots.effects.runSync(
            Effect.context<
              | Bots
              | BotRuntime
              | AgentRepository
              | ExecutionRepository
              | ConversationRepository
            >(),
          ),
        ),
      ),
      Layer.provide(
        Layer.succeedContext(
          bots.store.runtime.runSync(Effect.context<GroupChatRepository>()),
        ),
      ),
    ),
  );

  const service = chats.runSync(GroupChats.use(Effect.succeed));

  return {
    ...groupChatsAccess(service),
    service,
    close: () => chats.dispose(),
  };
}
