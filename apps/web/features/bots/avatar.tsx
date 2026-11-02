import { type CSSProperties, useLayoutEffect, useMemo, useRef } from "react";
import { renderAvatarSvg } from "open-bot-avatar";
import { mountAvatar } from "open-bot-avatar/dom";
import {
  avatarDefinitionSchema,
  legacyAvatarDefinition,
} from "@crumble/server/contract/avatar";
import { cn } from "@/lib/utils";
import type { Bot } from "@/lib/api";
import { isBusy, useActivity } from "./activity";

export type BotState = "idle" | "working" | "sleeping";

type AvatarBot = Pick<Bot, "id" | "avatar" | "avatarDefinition">;

function appearance(bot: AvatarBot) {
  if (bot.avatarDefinition) {
    const result = avatarDefinitionSchema.safeParse(bot.avatarDefinition);

    if (result.success) return result.data;
  }

  return legacyAvatarDefinition(bot);
}

/** The body color also supplies the bot's accent throughout the web app. */
export function botColor(bot: AvatarBot) {
  return bot.avatarDefinition?.color ?? legacyAvatarDefinition(bot).color;
}

export function botStyle(color: string) {
  // SAFETY: CSSProperties has no index for custom properties; `--bot` takes a color string.
  return { "--bot": color } as CSSProperties;
}

/** Static thumbnails use one SVG; live faces share the library's animation clock and reduced-motion listener. */
export function BotAvatar({
  bot,
  size = 28,
  state = "idle",
  live = false,
  className,
}: {
  bot: AvatarBot;
  size?: number;
  state?: BotState;
  live?: boolean;
  className?: string;
}) {
  const look = useMemo(
    () => appearance(bot),
    [bot.id, bot.avatar, bot.avatarDefinition],
  );

  const host = useRef<HTMLSpanElement>(null);
  const still = !live || state === "sleeping";
  const mood = state === "working" ? "thinking" : "idle";

  useLayoutEffect(() => {
    if (still || !host.current) return;

    const avatar = mountAvatar(host.current, {
      ...look,
      mood,
      reducedMotion: "system",
      followPointer: true,
      label: "",
    });

    return () => avatar.destroy();
  }, [still, look, mood]);

  const svg = useMemo(
    () =>
      still
        ? renderAvatarSvg(look.definition, {
            color: look.color,
            eyeColor: look.eyeColor,
            motion: mood,
            reducedMotion: true,
          })
        : "",
    [still, look, mood],
  );

  return (
    <span
      aria-hidden="true"
      data-state={state}
      className={cn("inline-block shrink-0", className)}
      style={{
        width: size,
        height: size,
        opacity: state === "sleeping" ? 0.45 : 1,
      }}
    >
      {still ? (
        <img
          alt=""
          width={size}
          height={size}
          src={`data:image/svg+xml,${encodeURIComponent(svg)}`}
        />
      ) : (
        <span ref={host} className="block size-full" />
      )}
    </span>
  );
}

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
