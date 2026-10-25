import {
  AppError,
  GROUP_TURN_BUDGET,
  type Agent,
  type Execution,
  type GroupChat,
  type GroupChatInput,
  type GroupTurn,
} from "../shared/domain";
import {
  MAX_ATTACHMENTS,
  attachmentKind,
  prepareAttachments,
  type AttachmentInput,
} from "../shared/attachments";
import { mentionedMembers, mentionsOwner } from "./group-mentions";
import type { GroupEntry, GroupTranscripts } from "./group-transcripts";
import { GROUP_TURN_PREFIX, type CrumbleService } from "../bots/service";
import type { Store } from "../shared/store";
import type { TranscriptPage } from "../bots/transcript";

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

/** Owner messages a group remembers as awaiting their first answer; older ones stop notifying. */
const AWAITING_ANSWERS = 50;

/** How long a joining member's summary may take before its turn starts without one. */
const SUMMARY_TIMEOUT_MS = 60_000;

/** Characters of earlier messages a joining member's summary is written from, newest first. */
const SUMMARY_INPUT_CHARACTERS = 40_000;

const senderName = (entry: GroupEntry) =>
  entry.sender.kind === "owner" ? "Owner" : (entry.sender.name ?? "A bot");

/** Group chats between the owner and several bots: membership, the shared transcript, turns, and change notifications. */
export class GroupChats {
  private readonly listeners = new Map<string, Set<() => void>>();
  /** Turn state changes run one at a time per group, so a member never gets two turns. */
  private readonly queues = new Map<string, Promise<void>>();
  /** Members whose joining summary is being written, as `group:agent`. */
  private readonly summarizing = new Set<string>();
  private readonly pendingVersions = new Map<string, symbol>();

  constructor(
    private readonly store: Store,
    private readonly transcripts: GroupTranscripts,
    private readonly service: CrumbleService,
  ) {
    service.onSettled((execution) => this.settled(execution));
  }

  list() {
    return this.store.listGroupChats();
  }

  get(groupId: string): GroupChat {
    const group = this.store.getGroupChat(groupId);

    if (!group) throw new AppError(404, "Group chat not found");

    return group;
  }

  create(input: GroupChatInput) {
    this.checkMembers(input.memberIds);

    return this.store.createGroupChat(input);
  }

  async update(groupId: string, input: GroupChatInput) {
    const current = this.get(groupId);
    this.checkMembers(input.memberIds);

    return this.serial(groupId, async () => {
      const latest = await this.transcripts.latest(groupId);
      const group = this.store.updateGroupChat(groupId, input)!;

      // A new member starts with the messages that follow its joining; its summary of earlier ones comes later.
      for (const agentId of input.memberIds)
        if (!current.memberIds.includes(agentId))
          this.store.setGroupMember(groupId, agentId, { cursor: latest });

      for (const agentId of current.memberIds)
        if (!input.memberIds.includes(agentId))
          await this.abortTurn(groupId, agentId);
      this.changed(groupId);

      return group;
    });
  }

  async delete(groupId: string) {
    const group = this.get(groupId);
    await this.stop(groupId);

    // Queued behind the stop and the settling of the turns it stopped, so no turn posts into a deleted group.
    await this.serial(groupId, async () => {
      // Remove the transcript first: a failure then leaves a group with an empty transcript, not an orphaned file.
      await this.transcripts.delete(groupId);

      for (const agentId of group.memberIds) {
        const conversationId = this.store.groupMember(
          groupId,
          agentId,
        )?.conversationId;

        if (conversationId) this.store.archiveConversation(conversationId);
      }

      this.store.deleteGroupChat(groupId);
      this.changed(groupId);
    });
  }

  async post(
    groupId: string,
    content: string,
    requestId: string,
    options: {
      replyTo?: string | undefined;
      attachments?: AttachmentInput[] | undefined;
    } = {},
  ): Promise<GroupMessageReceipt> {
    this.get(groupId);
    const attachments = options.attachments ?? [];
    // Validate before anything is written, so a bad file never leaves a message behind.
    const { info } = prepareAttachments(attachments);

    const target = options.replyTo
      ? await this.transcripts.message(groupId, options.replyTo)
      : undefined;

    if (options.replyTo && !target)
      throw new AppError(400, "Reply to a message in this group chat");

    const { entryId, created } = await this.transcripts.write(
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
    );

    const group = this.get(groupId);
    const mentioned = this.mentions(group, content, undefined, target);
    const woken = mentioned.length ? mentioned : group.memberIds;

    // A retried post routes again, but neither resumes the bots nor re-arms its notification.
    if (created) {
      const { awaitingAnswers } = this.store.groupActivity(groupId);

      const entries = Object.keys(awaitingAnswers)
        .map(Number)
        .sort((a, b) => a - b);

      for (const entry of entries.slice(
        0,
        Math.max(0, entries.length - AWAITING_ANSWERS + 1),
      ))
        delete awaitingAnswers[entry];

      awaitingAnswers[entryId.slice(groupId.length + 1)] = woken.filter(
        (agentId) => this.store.getAgent(agentId)?.enabled,
      );
      this.store.setGroupActivity(groupId, {
        botTurns: 0,
        paused: false,
        awaitingAnswers,
      });
    }

    const through = Number(entryId.slice(groupId.length + 1));

    for (const agentId of woken) {
      const member = this.store.groupMember(groupId, agentId);
      const active = this.store.activeGroupTurn(groupId, agentId);

      if (
        member &&
        this.store.getAgent(agentId)?.enabled &&
        member.cursor < through &&
        (created || !member.pending) &&
        (!active || active.through < through)
      )
        this.queueMember(groupId, agentId, false);
    }

    this.changed(groupId);

    void this.serial(groupId, async () => {
      for (const agentId of woken) {
        const member = this.store.groupMember(groupId, agentId);

        if (member?.pending && !this.store.activeGroupTurn(groupId, agentId))
          await this.wake(groupId, agentId, member.pendingBotStarted);
      }

      this.changed(groupId);
    }).catch((error) =>
      console.error("Group turns could not start", groupId, error),
    );

    return { requestId, entryId };
  }

  /** Ends every running turn in the group and drops the queued ones. */
  async stop(groupId: string) {
    const group = this.get(groupId);

    await this.serial(groupId, async () => {
      let stopped = false;

      for (const agentId of group.memberIds)
        stopped = (await this.abortTurn(groupId, agentId)) || stopped;

      if (stopped) this.changed(groupId);
    });
  }

  activity(groupId: string): GroupActivity {
    const group = this.get(groupId);
    const { botTurns, paused } = this.store.groupActivity(groupId);

    return {
      paused,
      botTurns,
      members: group.memberIds.map((agentId) => {
        const member = this.store.groupMember(groupId, agentId);

        const latest = this.store
          .listGroupTurns({ groupId })
          .findLast((turn) => turn.agentId === agentId);

        const execution = latest && this.store.getExecution(latest.executionId);

        return {
          agentId,
          status: !this.store.getAgent(agentId)?.enabled
            ? "disabled"
            : this.store.activeGroupTurn(groupId, agentId)
              ? "running"
              : member?.pending
                ? "queued"
                : "idle",
          error: execution?.status === "failed" ? execution.error : null,
        };
      }),
    };
  }

  attachment(groupId: string, entryId: string, index: number) {
    this.get(groupId);

    return this.transcripts.attachment(groupId, entryId, index);
  }

  /** The groups a bot belongs to, with their members' names and newest message time, for its lookup tool. */
  async forMember(agentId: string) {
    return Promise.all(
      this.list()
        .filter((group) => group.memberIds.includes(agentId))
        .map(async (group) => {
          const latest = (
            await this.transcripts.history(group.id, { limit: 1 })
          ).messages[0];

          return {
            id: group.id,
            name: group.name,
            members: group.memberIds.map(
              (id) => this.store.getAgent(id)?.name ?? "A deleted bot",
            ),
            latestAt: latest?.timestamp
              ? new Date(latest.timestamp).toISOString()
              : null,
          };
        }),
    );
  }

  /** A page of a group's transcript, for a bot that is one of its members. */
  async readAsMember(
    agentId: string,
    groupId: string,
    options: { before?: string | undefined; limit?: number | undefined },
  ) {
    const group = this.store.getGroupChat(groupId);

    if (!group?.memberIds.includes(agentId))
      throw new AppError(404, "Group chat not found");

    return this.transcripts.history(groupId, options);
  }

  history(
    groupId: string,
    options: { before?: string | undefined; limit?: number | undefined },
  ) {
    this.get(groupId);

    return this.transcripts.history(groupId, options);
  }

  async snapshot(
    groupId: string,
    options: { limit?: number | undefined },
  ): Promise<GroupChatSnapshot> {
    const groupChat = this.get(groupId);
    const page = await this.transcripts.history(groupId, options);

    return {
      ...page,
      groupChat,
      activity: this.activity(groupId),
      updatedAt: Date.now(),
    };
  }

  subscribe(groupId: string, callback: () => void) {
    const listeners = this.listeners.get(groupId) ?? new Set();
    listeners.add(callback);
    this.listeners.set(groupId, listeners);

    return () => {
      listeners.delete(callback);

      if (!listeners.size) this.listeners.delete(groupId);
    };
  }

  /** Finishes turns a restart interrupted, then starts the turns that were waiting. Run after the service recovers. */
  async recover() {
    for (const turn of this.store.listGroupTurns({
      status: ["running", "posting"],
    })) {
      const execution = this.store.getExecution(turn.executionId);

      if (execution && !["pending", "running"].includes(execution.status))
        await this.settled(execution);
    }

    for (const group of this.store.listGroupChats())
      await this.serial(group.id, async () => {
        for (const agentId of group.memberIds) {
          const member = this.store.groupMember(group.id, agentId);

          if (
            member?.pending &&
            !this.store.activeGroupTurn(group.id, agentId)
          ) {
            await this.wake(group.id, agentId, member.pendingBotStarted);
          }
        }
      });
  }

  async close() {
    while (this.queues.size) await Promise.all(this.queues.values());
    await this.transcripts.close();
  }

  private serial<T>(groupId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(groupId) ?? Promise.resolve();
    const result = previous.then(work);

    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    this.queues.set(groupId, tail);
    void tail.then(() => {
      if (this.queues.get(groupId) === tail) this.queues.delete(groupId);
    });

    return result;
  }

  /** Members a message wakes: its mentions and, for a reply, the bot it answers. */
  private mentions(
    group: GroupChat,
    text: string,
    senderId: string | undefined,
    replyTarget?: GroupEntry,
  ) {
    const members = group.memberIds.flatMap((agentId) => {
      const agent = this.store.getAgent(agentId);

      return agent ? [{ id: agent.id, name: agent.name }] : [];
    });

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
  }

  private queueMember(groupId: string, agentId: string, botStarted: boolean) {
    const member = this.store.groupMember(groupId, agentId);

    if (!member) return;
    this.pendingVersions.set(`${groupId}:${agentId}`, Symbol());
    this.store.setGroupMember(groupId, agentId, {
      pending: true,
      pendingBotStarted: member.pending
        ? member.pendingBotStarted && botStarted
        : botStarted,
    });
  }

  private async wake(groupId: string, agentId: string, botStarted: boolean) {
    const member = this.store.groupMember(groupId, agentId);

    if (!member || !this.store.getAgent(agentId)?.enabled) return;

    if (botStarted && this.store.groupActivity(groupId).paused) {
      if (member.pendingBotStarted)
        this.store.setGroupMember(groupId, agentId, { pending: false });

      return;
    }

    if (this.store.activeGroupTurn(groupId, agentId)) {
      this.queueMember(groupId, agentId, botStarted);

      return;
    }

    try {
      await this.startTurn(groupId, agentId, botStarted);
    } catch (error) {
      console.error("Group turn could not start", groupId, agentId, error);
    }
  }

  private async startTurn(
    groupId: string,
    agentId: string,
    botStarted: boolean,
  ) {
    const group = this.get(groupId);
    const member = this.store.groupMember(groupId, agentId)!;
    const agent = this.service.agent(agentId);
    const key = `${groupId}:${agentId}`;
    const pendingVersion = this.pendingVersions.get(key);

    const consumePending = () => {
      // A message accepted during startup must keep its follow-up queued.
      if (this.pendingVersions.get(key) === pendingVersion) {
        this.store.setGroupMember(groupId, agentId, { pending: false });
        this.pendingVersions.delete(key);
      }
    };

    const unseen = (
      await this.transcripts.after(groupId, member.cursor)
    ).filter(
      (entry) =>
        entry.sender.agentId !== agentId && entry.reaction === undefined,
    );

    if (!unseen.length) {
      consumePending();

      return;
    }

    const first = !this.store
      .listGroupTurns({ groupId })
      .some(
        (turn) => turn.agentId === agentId && turn.createdAt >= member.joinedAt,
      );

    // A member that joined after the first message waits, queued, for a summary of what came before.
    if (first && member.cursor > 0 && member.summary === null) {
      this.queueMember(groupId, agentId, botStarted);
      this.startSummary(groupId, agentId, member.cursor);

      return;
    }

    const activity = this.store.groupActivity(groupId);

    if (botStarted) {
      if (activity.botTurns >= GROUP_TURN_BUDGET) {
        this.store.setGroupActivity(groupId, { paused: true });
        consumePending();

        return;
      }

      this.store.setGroupActivity(groupId, {
        botTurns: activity.botTurns + 1,
        paused: activity.botTurns + 1 >= GROUP_TURN_BUDGET,
      });
    }

    const conversationId =
      member.conversationId ?? (await this.openConversation(group, agentId));

    const summary = first ? member.summary : null;

    const through = unseen.at(-1)!.entry;
    const requestId = `${GROUP_TURN_PREFIX}${groupId}:${agentId}:${through}`;

    const { attachments, omitted } = await this.turnAttachments(agent, unseen);

    const input = `${summary ? `Summary of the conversation before you joined:\n\n${summary}\n\n` : ""}${this.turnInput(group, agent.name, unseen)}${omitted.length ? `\n\nYour model cannot read images, so these were left out: ${omitted.join(", ")}.` : ""}`;
    let execution = this.store.findExecution(conversationId, requestId);

    if (!execution)
      try {
        execution = await this.service.send(conversationId, input, requestId, {
          attachments,
        });
      } catch (error) {
        // A failed admission still leaves its execution; its settlement reports the failure.
        execution = this.store.findExecution(conversationId, requestId);

        if (!execution) throw error;
      }

    if (!this.store.getGroupTurn(execution.id))
      this.store.createGroupTurn({
        executionId: execution.id,
        groupId,
        agentId,
        through,
        botStarted,
        status: "running",
      });

    consumePending();

    // An execution that failed to start settled before its turn existed, so its settlement found nothing.
    if (!["pending", "running"].includes(execution.status))
      await this.finish(execution.id);
  }

  /**
   * Writes a joining member's summary outside the group's queue, so a slow model holds up nothing else, then starts
   * the turn it waited for unless the group was stopped or the member left meanwhile.
   */
  private startSummary(groupId: string, agentId: string, cursor: number) {
    const key = `${groupId}:${agentId}`;

    if (this.summarizing.has(key)) return;
    this.summarizing.add(key);

    void (async () => {
      const agent = this.store.getAgent(agentId);

      const summary = agent
        ? await this.summarize(groupId, agent, cursor)
        : null;

      await this.serial(groupId, async () => {
        const member = this.store.groupMember(groupId, agentId);

        if (!member || summary === null) return;
        this.store.setGroupMember(groupId, agentId, { summary });

        if (member.pending)
          await this.wake(groupId, agentId, member.pendingBotStarted);
        this.changed(groupId);
      });
    })()
      .catch((error) =>
        console.error("Group summary failed", groupId, agentId, error),
      )
      .finally(() => this.summarizing.delete(key));
  }

  private async openConversation(group: GroupChat, agentId: string) {
    const agent = this.service.agent(agentId);
    // Opening the bot chat first keeps an upgraded bot's chat from adopting the group conversation as its session.
    await this.service.chat(agentId);

    const conversationId = await this.service.runtime.openGroupConversation(
      agent,
      group.id,
    );

    this.store.createConversation(
      { agentId, title: group.name },
      conversationId,
    );
    this.store.setGroupMember(group.id, agentId, { conversationId });

    return conversationId;
  }

  /** The messages up to `cursor`, newest first until the summary budget, summarized by the joining bot's model. */
  private async summarize(groupId: string, agent: Agent, cursor: number) {
    const earlier = (await this.transcripts.after(groupId, 0)).filter(
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

    try {
      return await this.service.runtime.summarize(
        agent,
        lines.join("\n\n"),
        AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      );
    } catch (error) {
      console.error("Group summary failed", groupId, agent.id, error);

      return "The earlier conversation could not be summarized.";
    }
  }

  /**
   * The uploads of a turn's unseen messages, newest messages first up to the attachment limit, in message order.
   * Images are left out, by name, for a model that cannot read them.
   */
  private async turnAttachments(agent: Agent, unseen: GroupEntry[]) {
    const images = await this.service.runtime.acceptsImages(agent);
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
  }

  private turnInput(group: GroupChat, name: string, unseen: GroupEntry[]) {
    const members = group.memberIds
      .map((agentId) => this.store.getAgent(agentId)?.name)
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
  }

  private settled(execution: Execution): Promise<void> {
    const turn = this.store.getGroupTurn(execution.id);

    if (!turn || turn.status === "settled") return Promise.resolve();

    return this.serial(turn.groupId, () => this.finish(turn.executionId));
  }

  /** Posts a settled turn's outcome once, advances the member, and starts its waiting turn. */
  private async finish(executionId: string) {
    const turn = this.store.getGroupTurn(executionId);
    const execution = this.store.getExecution(executionId);

    if (!turn || turn.status === "settled" || !execution) return;
    this.store.updateGroupTurn(executionId, { status: "posting" });
    const group = this.store.getGroupChat(turn.groupId);
    const member = this.store.groupMember(turn.groupId, turn.agentId);

    if (
      group &&
      member &&
      execution.status === "done" &&
      execution.submissionId
    )
      await this.publish(
        group,
        turn,
        execution.conversationId,
        execution.submissionId,
      );

    this.store.updateGroupTurn(executionId, { status: "settled" });

    if (!group || !member) return;

    // A stopped or failed turn leaves its messages unseen, so the member's next turn includes them.
    if (execution.status === "done")
      this.store.setGroupMember(group.id, turn.agentId, {
        cursor: Math.max(member.cursor, turn.through),
      });

    const current = this.store.groupMember(group.id, turn.agentId)!;

    if (current.pending) {
      await this.wake(group.id, turn.agentId, current.pendingBotStarted);
    }

    this.changed(group.id);
  }

  private async publish(
    group: GroupChat,
    turn: GroupTurn,
    conversationId: string,
    submissionId: string,
  ) {
    const agent = this.store.getAgent(turn.agentId);

    if (!agent) return;

    const outcome = await this.service.runtime.turnOutcome(
      agent,
      conversationId,
      submissionId,
    );

    if (outcome.kind === "pass") return;
    const sender = { kind: "bot", agentId: agent.id, name: agent.name };
    const requestId = `${GROUP_TURN_PREFIX}${turn.executionId}`;

    if (outcome.kind === "reaction") {
      await this.transcripts.post(
        group.id,
        {
          text: "",
          sender,
          reaction: outcome.emoji,
          replyTo: `${group.id}:${turn.through}`,
        },
        requestId,
      );

      return;
    }

    const entryId = await this.transcripts.post(
      group.id,
      { text: outcome.text, sender },
      requestId,
    );

    this.changed(group.id);
    this.notify(group, turn, agent, entryId, outcome.text);

    for (const agentId of this.mentions(group, outcome.text, agent.id))
      await this.wake(group.id, agentId, true);
  }

  /**
   * Notifies the owner of the first bot answer to their newest message, if this turn saw it, and of any `@owner`.
   * The event ID is the turn's execution, so a retried post notifies once.
   */
  private notify(
    group: GroupChat,
    turn: GroupTurn,
    agent: Agent,
    entryId: string,
    text: string,
  ) {
    const { awaitingAnswers } = this.store.groupActivity(group.id);

    // The first answer from a bot an owner message woke, in a turn that saw it, answers that message.
    const answered = Object.entries(awaitingAnswers).filter(
      ([entry, targets]) =>
        Number(entry) <= turn.through && targets.includes(agent.id),
    );

    for (const [entry] of answered) delete awaitingAnswers[entry];

    if (answered.length)
      this.store.setGroupActivity(group.id, { awaitingAnswers });

    if (!answered.length && !mentionsOwner(text)) return;
    this.service.announce({
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
  }

  /** Stops the member's turn and drops its queued one; a stopped turn posts nothing. Reports whether there was any. */
  private async abortTurn(groupId: string, agentId: string) {
    const member = this.store.groupMember(groupId, agentId);
    const queued = member?.pending === true;

    if (queued) this.store.setGroupMember(groupId, agentId, { pending: false });
    const turn = this.store.activeGroupTurn(groupId, agentId);
    const execution = turn && this.store.getExecution(turn.executionId);

    if (!execution || !["pending", "running"].includes(execution.status))
      return queued;
    await this.service.abort(execution.conversationId);

    return true;
  }

  private checkMembers(memberIds: string[]) {
    for (const agentId of memberIds)
      if (!this.store.getAgent(agentId))
        throw new AppError(400, "Choose existing bots as members");
  }

  private changed(groupId: string) {
    for (const listener of this.listeners.get(groupId) ?? []) listener();
  }
}
