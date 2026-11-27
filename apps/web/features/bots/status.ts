import type { BotStatus } from "@crumble/server/contract/bot-status";
import type { BotState } from "@/components/bot-avatar";

export const STATUS_AVATAR: Record<BotStatus, BotState> = {
  idle: "idle",
  thinking: "thinking",
  working: "working",
  failed: "blocked",
  question: "question",
  blocked: "blocked",
};

export const STATUS_REASON: Record<BotStatus, string | null> = {
  idle: null,
  thinking: "thinking",
  working: "working",
  failed: "last reply failed",
  question: "has a question",
  blocked: "needs your decision",
};

export function botLabel(
  bot: { name: string; status: BotStatus },
  { pinned, unread }: { pinned: boolean; unread: number },
) {
  return [
    pinned ? `${bot.name}, pinned` : bot.name,
    unread > 0 && `${unread} unread`,
    STATUS_REASON[bot.status],
  ]
    .filter(Boolean)
    .join(", ");
}
