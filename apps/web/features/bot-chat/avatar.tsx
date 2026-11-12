import {
  type AvatarBot,
  type BotState,
  BotAvatar,
} from "@/components/bot-avatar";
import type { Bot } from "@/features/bots/api";
import { isBusy, useWorking } from "./working";

const avatarState = (
  enabled: boolean,
  working: ReturnType<typeof useWorking>,
): BotState => {
  if (!enabled) return "sleeping";

  return isBusy(working) ? "working" : "idle";
};

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

  const state = avatarState(bot.enabled, working);

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
