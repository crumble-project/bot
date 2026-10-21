import { AppError, type GroupChat, type GroupChatInput } from "./domain";
import type { GroupTranscripts } from "./group-transcripts";
import type { Store } from "./store";
import type { TranscriptPage } from "./transcript";

export type GroupChatSnapshot = TranscriptPage & {
  groupChat: GroupChat;
  updatedAt: number;
};

export type GroupMessageReceipt = { requestId: string; entryId: string };

/** Group chats between the owner and several bots: membership, the shared transcript, and change notifications. */
export class GroupChats {
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly store: Store,
    private readonly transcripts: GroupTranscripts,
  ) {}

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

  update(groupId: string, input: GroupChatInput) {
    this.get(groupId);
    this.checkMembers(input.memberIds);
    const group = this.store.updateGroupChat(groupId, input)!;
    this.changed(groupId);

    return group;
  }

  async delete(groupId: string) {
    this.get(groupId);
    // Remove the transcript first: a failure then leaves a group with an empty transcript, not an orphaned file.
    await this.transcripts.delete(groupId);
    this.store.deleteGroupChat(groupId);
    this.changed(groupId);
  }

  async post(
    groupId: string,
    content: string,
    requestId: string,
  ): Promise<GroupMessageReceipt> {
    this.get(groupId);

    const entryId = await this.transcripts.post(
      groupId,
      { text: content, sender: { kind: "owner" } },
      requestId,
    );

    this.changed(groupId);

    return { requestId, entryId };
  }

  history(groupId: string, options: { before?: string; limit?: number }) {
    this.get(groupId);

    return this.transcripts.history(groupId, options);
  }

  async snapshot(
    groupId: string,
    options: { limit?: number },
  ): Promise<GroupChatSnapshot> {
    const groupChat = this.get(groupId);
    const page = await this.transcripts.history(groupId, options);

    return { ...page, groupChat, updatedAt: Date.now() };
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

  close() {
    return this.transcripts.close();
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
