import { useEffect, useRef, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import type { AvatarBot, BotState } from "@/components/bot-avatar";
import type { Bot } from "@/features/bots/api";
import { STATUS_AVATAR } from "@/features/bots/status";
import { useWorking, workingAvatar } from "./working";

const DONE_MS = 4000;

const isActive = (state: BotState) =>
  state === "thinking" || state === "working";

function useCelebration(state: BotState): BotState {
  const [finished, setFinished] = useState(false);
  const previous = useRef(state);

  useEffect(() => {
    const was = previous.current;

    previous.current = state;

    if (!isActive(was) || state !== "idle") {
      setFinished(false);

      return;
    }

    setFinished(true);

    const timer = setTimeout(() => setFinished(false), DONE_MS);

    return () => clearTimeout(timer);
  }, [state]);

  return finished ? "done" : state;
}

function CelebratingAvatar({
  bot,
  size,
  state,
  className,
}: {
  bot: AvatarBot;
  size: number;
  state: BotState;
  className?: string;
}) {
  const shown = useCelebration(state);

  return (
    <BotAvatar
      bot={bot}
      size={size}
      live
      state={shown}
      {...(className && { className })}
    />
  );
}

export function LiveBotAvatar({
  bot,
  size,
  className,
}: {
  bot: AvatarBot;
  size: number;
  className?: string;
}) {
  return (
    <CelebratingAvatar
      bot={bot}
      size={size}
      state={workingAvatar(useWorking(bot.id))}
      {...(className && { className })}
    />
  );
}

export function StatusBotAvatar({
  bot,
  size,
  className,
}: {
  bot: Pick<Bot, "id" | "avatar" | "status">;
  size: number;
  className?: string;
}) {
  return (
    <CelebratingAvatar
      bot={bot}
      size={size}
      state={STATUS_AVATAR[bot.status]}
      {...(className && { className })}
    />
  );
}
