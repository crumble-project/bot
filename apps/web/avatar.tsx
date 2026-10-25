import { type CSSProperties, useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Bot } from "./api";
import {
  type Blend,
  type BotState,
  BotPainter,
  REST,
  blendOf,
  blendPose,
  expressionOf,
  lookOf,
  mixBlend,
  paintZs,
} from "./bot-avatar";

export type { BotState };

/** A bot's accent color, the hue of its avatar body. */
export function botColor(bot: Pick<Bot, "id" | "avatar">) {
  return lookOf(bot).hex;
}

/** Sets `--bot`, the color the `bg-bot-*` utilities in styles.css read, on an element. */
export function botStyle(color: string) {
  // SAFETY: CSSProperties has no index for custom properties; `--bot` takes any color string.
  return { "--bot": color } as CSSProperties;
}

const sprites = new Map<string, OffscreenCanvas>();

/** The body at rest, drawn once per look, size and pixel ratio, like the native sprite cache. */
function bodySprite(painter: BotPainter, ratio: number) {
  const { hash, silhouette, hex } = painter.look;
  const key = `${hash}-${silhouette}-${hex}-${painter.size}-${ratio}`;
  let sprite = sprites.get(key);

  if (!sprite) {
    sprite = new OffscreenCanvas(painter.size * ratio, painter.size * ratio);

    const context = sprite.getContext("2d")!;

    context.scale(ratio, ratio);
    painter.paintBody(context, "calm");
    sprites.set(key, sprite);
  }

  return sprite;
}

type Live = {
  canvas: HTMLCanvasElement;
  painter: BotPainter;
  from: Blend;
  target: Blend;
  since: number;
  duration: number;
  point: [number, number];
  watching: boolean;
  watchSince: number;
  zColor: string;
};

const live = new Set<Live>();
let frame = 0;

const now = () => (performance.timeOrigin + performance.now()) / 1000;

const smooth = (progress: number) => progress * progress * (3 - 2 * progress);

function blendAt(avatar: Live, time: number) {
  const progress = Math.min(
    1,
    Math.max(0, (time - avatar.since) / avatar.duration),
  );

  return mixBlend(avatar.from, avatar.target, smooth(progress));
}

function draw(avatar: Live, time: number) {
  const { canvas, painter } = avatar;
  const context = canvas.getContext("2d");

  if (!context) return;

  const ratio = canvas.width / painter.size;
  const blend = blendAt(avatar, time);

  const eased = smooth(
    Math.min(1, Math.max(0, (time - avatar.watchSince) / 0.22)),
  );

  const pull = avatar.watching ? eased : 1 - eased;
  const pose = blendPose(blend, time, painter.look, avatar.point, pull);

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, painter.size, painter.size);
  painter.paint(
    context,
    pose,
    [
      ["calm", blend.idle * (1 - pull)],
      ["delighted", blend.idle * pull],
      ["focused", blend.working],
      ["asleep", blend.sleeping],
    ],
    bodySprite(painter, ratio),
  );

  if (blend.sleeping > 0)
    paintZs(
      context,
      painter.size,
      time + painter.look.mod(1000) / 1000,
      blend.sleeping,
      avatar.zColor,
    );
}

function tick() {
  const time = now();

  for (const avatar of live) draw(avatar, time);

  frame = live.size ? requestAnimationFrame(tick) : 0;
}

function start(avatar: Live) {
  live.add(avatar);

  if (!frame) frame = requestAnimationFrame(tick);
}

const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A bot's drawn face, as in the native apps. Live avatars breathe, glance, blink and watch the
 * pointer while idle, hop while working, and doze while asleep.
 */
export function BotAvatar({
  bot,
  size = 28,
  state = "idle",
  live: animated = false,
  className,
}: {
  bot: Pick<Bot, "id" | "avatar">;
  size?: number;
  state?: BotState;
  live?: boolean;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const avatar = useRef<Live | null>(null);
  const moving = animated && !reducedMotion();

  useLayoutEffect(() => {
    const element = canvas.current;

    if (!element) return;

    const ratio = Math.min(3, Math.ceil(devicePixelRatio || 1));
    const painter = new BotPainter(lookOf(bot), size);

    element.width = size * ratio;
    element.height = size * ratio;

    if (!moving) {
      const context = element.getContext("2d")!;

      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      painter.paint(context, REST, [[expressionOf(state), 1]]);

      return;
    }

    const entry: Live = {
      canvas: element,
      painter,
      from: blendOf(state),
      target: blendOf(state),
      since: 0,
      duration: 0.55,
      point: [0.5, 0.5],
      watching: false,
      watchSince: 0,
      zColor: getComputedStyle(element).color,
    };

    avatar.current = entry;
    start(entry);

    return () => {
      live.delete(entry);
      avatar.current = null;
    };
    // `state` is left out on purpose: the effect below eases into a new state without a restart.
  }, [bot.id, bot.avatar, size, moving]);

  useEffect(() => {
    const entry = avatar.current;

    if (!entry) return;

    const time = now();

    entry.from = blendAt(entry, time);
    entry.target = blendOf(state);
    entry.since = time;
    entry.duration = state === "sleeping" ? 0.95 : 0.55;

    if (state !== "idle" && entry.watching) {
      entry.watching = false;
      entry.watchSince = time;
    }
  }, [state]);

  useEffect(() => {
    if (!moving) return;

    const scheme = matchMedia("(prefers-color-scheme: dark)");

    const recolor = () => {
      if (avatar.current && canvas.current)
        avatar.current.zColor = getComputedStyle(canvas.current).color;
    };

    scheme.addEventListener("change", recolor);

    return () => scheme.removeEventListener("change", recolor);
  }, [moving]);

  return (
    <canvas
      ref={canvas}
      aria-hidden
      className={cn("shrink-0 text-muted-foreground", className)}
      style={{ width: size, height: size }}
      onPointerMove={(event) => {
        const entry = avatar.current;

        if (!entry || state !== "idle") return;

        const rect = event.currentTarget.getBoundingClientRect();

        entry.point = [
          (event.clientX - rect.left) / rect.width,
          (event.clientY - rect.top) / rect.height,
        ];

        if (!entry.watching) {
          entry.watching = true;
          entry.watchSince = now();
        }
      }}
      onPointerLeave={() => {
        const entry = avatar.current;

        if (entry?.watching) {
          entry.watching = false;
          entry.watchSince = now();
        }
      }}
    />
  );
}
