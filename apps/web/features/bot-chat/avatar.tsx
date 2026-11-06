import { type AvatarBot, BotAvatar } from "@/components/bot-avatar";
import type { Bot } from "@/features/bots/api";
import { isBusy, useWorking } from "./working";

export function LiveBotAvatar({
  bot,
  size,
  className,
}: {
  bot: AvatarBot & Pick<Bot, "enabled">;
  size: number;
  className?: string;
}) {
  const working = useWorking(bot.id);

  const state = !bot.enabled
    ? "sleeping"
    : isBusy(working)
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
