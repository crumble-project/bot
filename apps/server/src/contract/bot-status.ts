export const BOT_STATUSES = [
  "idle",
  "thinking",
  "working",
  "failed",
  "question",
  "blocked",
] as const;

export type BotStatus = (typeof BOT_STATUSES)[number];
