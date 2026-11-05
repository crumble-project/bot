import { type AvatarBot, BotAvatar } from "@/components/bot-avatar";
import type { Bot } from "./api";
import { isBusy, useActivity } from "./activity";

export function LiveBotAvatar({
  bot,
  size,
  className,
}: {
  bot: AvatarBot & Pick<Bot, "enabled">;
  size: number;
  className?: string;
}) {
  const activity = useActivity(bot.id);

  const state = !bot.enabled
    ? "sleeping"
    : isBusy(activity)
      ? "working"
      : "idle";

  return (
    <BotAvatar
      bot={bot}
      size={size}
      live
      state={state}
      {...(className && { className })}
    />
  );
}
