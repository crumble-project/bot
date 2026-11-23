import { useLayoutEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import { renderAvatarSvg } from "open-bot-avatar";
import type { AvatarState } from "open-bot-avatar";
import { mountAvatar } from "open-bot-avatar/dom";
import type { MountedAvatar } from "open-bot-avatar/dom";
import type { BotAvatarDefinition } from "@crumble/server/contract/avatar";
import { cn } from "@/lib/utils";

export type BotState = AvatarState;

export type AvatarBot = { id: string; avatar: BotAvatarDefinition };

export function botColor(bot: AvatarBot) {
  return bot.avatar.color;
}

export function botStyle(color: string): CSSProperties {
  return { "--bot": color };
}

function useLiveAvatar(
  still: boolean,
  look: BotAvatarDefinition,
  state: AvatarState,
) {
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  const latest = useRef(state);

  useLayoutEffect(() => {
    if (still || !host.current) {
      return;
    }

    const mounted = mountAvatar(host.current, {
      ...look,
      state: latest.current,
      reducedMotion: "system",
      followPointer: true,
      label: "",
    });

    avatar.current = mounted;

    return () => {
      mounted.destroy();
      avatar.current = null;
    };
  }, [still, look]);

  useLayoutEffect(() => {
    latest.current = state;
    avatar.current?.update({ state });
  }, [state]);

  return host;
}

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
  const look = bot.avatar;

  const still = !live;
  const host = useLiveAvatar(still, look, state);

  const svg = useMemo(
    () =>
      still
        ? renderAvatarSvg(look.definition, {
            color: look.color,
            eyeColor: look.eyeColor,
            state,
            reducedMotion: true,
          })
        : "",
    [still, look, state],
  );

  return (
    <span
      aria-hidden="true"
      data-state={state}
      className={cn("inline-block shrink-0", className)}
      style={{ width: size, height: size }}
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
