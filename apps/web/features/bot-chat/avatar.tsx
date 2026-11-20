import { useEffect, useRef, useState } from "react";
import {
  type AvatarBot,
  type BotState,
  BotAvatar,
} from "@/components/bot-avatar";
import type { Bot } from "@/features/bots/api";
import { type Working, isBusy, useWorking, workingAvatar } from "./working";

/** How long an avatar celebrates after a reply finishes. */
const DONE_MS = 4000;

/** True for a few seconds after a run ends well; never for a bot that was already idle on load. */
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

const avatarState = (
  enabled: boolean,
  working: Working,
  finished: boolean,
): BotState => {
  if (!enabled) return "sleeping";

  if (finished) return "done";

  return workingAvatar[working];
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
  const finished = useJustFinished(working);

  const state = avatarState(bot.enabled, working, finished);

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
