import type { z } from "zod";
import type { groupActivityResponse } from "../contract/api-responses";
import type { TranscriptPage } from "../transcript/transcript";
import type { GroupChat } from "./group-chat-repository";

export type GroupActivity = z.output<typeof groupActivityResponse>;

export type GroupMemberActivity = GroupActivity["members"][number];

export type GroupChatSnapshot = TranscriptPage & {
  groupChat: GroupChat;
  activity: GroupActivity;
  updatedAt: number;
};

export type GroupMessageReceipt = { requestId: string; entryId: string };
