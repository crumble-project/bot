import type { TranscriptPage } from "../bots/transcript";
import type { GroupChat } from "../shared/domain";
import type { GroupTranscripts } from "./group-transcripts";

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

export type GroupMembership = {
  id: string;
  name: string;
  members: string[];
  latestAt: string | null;
};

export type PageOptions = {
  before?: string | undefined;
  limit?: number | undefined;
};

/** An uploaded file of a group message, as clients download it. */
export type GroupAttachment = Awaited<
  ReturnType<GroupTranscripts["attachment"]>
>;
