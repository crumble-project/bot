import type { z } from "zod";
import type { groupActivityResponse } from "../contract/api-responses";
import type { TranscriptPage } from "../bots/transcript";
import type { GroupChat } from "../shared/domain";
import type { GroupTranscripts } from "./group-transcripts";

export type GroupActivity = z.output<typeof groupActivityResponse>;

export type GroupMemberActivity = GroupActivity["members"][number];

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
