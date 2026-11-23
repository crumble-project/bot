import { useEffect, useRef, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import type { AvatarBot, BotState } from "@/components/bot-avatar";
import { isBusy, useWorking, workingAvatar } from "./working";
import type { Working } from "./working";

const DONE_MS = 4000;

function useJustFinished(working: Working) {
  const [finished, setFinished] = useState(false);
  const previous = useRef(working);

  useEffect(() => {
    const was = previous.current;

    previous.current = working;

    if (!isBusy(was) || working !== "idle") {
      setFinished(false);

      return;
    }

    setFinished(true);

    const timer = setTimeout(() => setFinished(false), DONE_MS);

    return () => clearTimeout(timer);
  }, [working]);

  return finished;
}

const avatarState = (working: Working, finished: boolean): BotState =>
  finished ? "done" : workingAvatar(working);

export function LiveBotAvatar({
  bot,
  size,
  className,
}: {
  bot: AvatarBot;
  size: number;
  className?: string;
}) {
  const working = useWorking(bot.id);
  const finished = useJustFinished(working);

  const state = avatarState(working, finished);

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
