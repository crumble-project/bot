import { type CSSProperties, useLayoutEffect, useMemo, useRef } from "react";
import { type AvatarState, renderAvatarSvg } from "open-bot-avatar";
import { type MountedAvatar, mountAvatar } from "open-bot-avatar/dom";
import type { BotAvatarDefinition } from "@crumble/server/contract/avatar";
import { cn } from "@/lib/utils";

/** An avatar state, or `sleeping`: a paused bot drawn still and dimmed. */
export type BotState = AvatarState | "sleeping";

export type AvatarBot = { id: string; avatar: BotAvatarDefinition };

export function botColor(bot: AvatarBot) {
  return bot.avatar.color;
}

export function botStyle(color: string) {
  // SAFETY: CSSProperties has no index for custom properties; `--bot` takes a color string.
  return { "--bot": color } as CSSProperties;
}

function useLiveAvatar(
  still: boolean,
  look: BotAvatarDefinition,
  state: AvatarState,
) {
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  const latest = useRef(state);

  // Remount only for a new look; state changes ease on the mounted avatar.
  useLayoutEffect(() => {
    if (still || !host.current) return;

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
  const look = bot.avatar;

  const still = !live || state === "sleeping";
  const shown = state === "sleeping" ? "idle" : state;
  const host = useLiveAvatar(still, look, shown);

  const svg = useMemo(
    () =>
      still
        ? renderAvatarSvg(look.definition, {
            color: look.color,
            eyeColor: look.eyeColor,
            state: shown,
            reducedMotion: true,
          })
        : "",
    [still, look, shown],
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
