import {
  type ComponentProps,
  type CSSProperties,
  type Ref,
  type RefObject,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "@/lib/utils";
import type { Bot } from "@/lib/api";
import {
  type Blend,
  type BotLook,
  type BotState,
  type Expression,
  BotPainter,
  REST,
  blendOf,
  blendPose,
  expressionOf,
  lookOf,
  mixBlend,
  paintZs,
} from "./bot-avatar";
import { type Activity, isBusy, useActivity } from "./activity";
import { type Gesture, Gestures } from "./bot-gestures";

export type { Activity, BotState, Gesture };

/** Plays a gesture on a live avatar, as a poke or a finished turn would. */
export type BotAvatarHandle = { play: (gesture: Gesture) => void };

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
  state: BotState;
  face: Expression | undefined;
  gestures: Gestures;
};

const live = new Set<Live>();
let frame = 0;

// One bot's live avatars share its gestures, so the sidebar, header and details react as one.
const minds = new Map<string, { gestures: Gestures; users: number }>();

function acquire(key: string, make: () => Gestures) {
  const mind = minds.get(key) ?? { gestures: make(), users: 0 };

  mind.users++;
  minds.set(key, mind);

  return mind.gestures;
}

function release(key: string) {
  const mind = minds.get(key);

  if (mind && --mind.users === 0) minds.delete(key);
}

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

  avatar.gestures.update(time, blend.idle === 1, avatar.watching);

  const { pose, faces } = avatar.gestures.apply(
    blendPose(blend, time, painter.look, avatar.point, pull),
    avatar.face
      ? [[avatar.face, 1]]
      : [
          ["calm", blend.idle * (1 - pull)],
          ["delighted", blend.idle * pull],
          ["focused", blend.working],
          ["asleep", blend.sleeping],
        ],
    time,
  );

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, painter.size, painter.size);
  painter.paint(context, pose, faces, bodySprite(painter, ratio));

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

/** Pokes, petting, startles, and the idle gaze following the pointer over a live avatar. */
function pointerHandlers(
  avatar: RefObject<Live | null>,
  state: BotState,
): Pick<
  ComponentProps<"canvas">,
  "onPointerDown" | "onPointerEnter" | "onPointerMove" | "onPointerLeave"
> {
  const watch = (entry: Live, watching: boolean) => {
    if (entry.watching === watching) return;

    entry.watching = watching;
    entry.watchSince = now();
  };

  return {
    onPointerDown: () => avatar.current?.gestures.poke(now(), state),
    onPointerEnter: () => avatar.current?.gestures.enter(now()),
    onPointerMove: (event) => {
      const entry = avatar.current;

      if (!entry) return;

      const rect = event.currentTarget.getBoundingClientRect();

      const point: [number, number] = [
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height,
      ];

      entry.gestures.move(point, now(), rect.width);

      if (state !== "idle") return;

      entry.point = point;
      watch(entry, true);
    },
    onPointerLeave: () => {
      const entry = avatar.current;

      if (!entry) return;

      entry.gestures.leave();
      watch(entry, false);
    },
  };
}

/** Sizes the canvas backing store for the screen's pixel ratio, capped at 3, and makes its painter. */
function sized(element: HTMLCanvasElement, look: BotLook, size: number) {
  const ratio = Math.min(3, Math.ceil(devicePixelRatio || 1));

  element.width = size * ratio;
  element.height = size * ratio;

  return new BotPainter(look, size);
}

type LiveOptions = {
  animated: boolean;
  activity: Activity | undefined;
  face: Expression | undefined;
  independent: boolean;
};

/** The canvas and live state behind one avatar: animated unless motion is reduced, else still. */
function useLiveAvatar(
  bot: Pick<Bot, "id" | "avatar">,
  size: number,
  state: BotState,
  { animated, activity, face, independent }: LiveOptions,
) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const avatar = useRef<Live | null>(null);
  const moving = animated && !reducedMotion();
  const doing = activity ?? defaultActivity(state);
  const shared = independent ? null : `${bot.id}|${bot.avatar}`;

  useAnimation(canvas, avatar, bot, size, moving ? shared : undefined, {
    state,
    doing,
  });
  useStill(canvas, bot, size, moving, face ?? expressionOf(state));
  useFollow(avatar, state, doing, face, shared);
  useSleepColor(moving, avatar, canvas);

  return { canvas, avatar };
}

/**
 * Sizes the canvas for its look and, for a moving avatar, animates it from the state it mounts
 * in; `shared` is undefined for a still avatar and null for an independent one.
 */
function useAnimation(
  canvas: RefObject<HTMLCanvasElement | null>,
  avatar: RefObject<Live | null>,
  { id, avatar: appearance }: Pick<Bot, "id" | "avatar">,
  size: number,
  shared: string | null | undefined,
  current: { state: BotState; doing: Activity },
) {
  const initial = useEffectEvent(() => current);

  useLayoutEffect(() => {
    const element = canvas.current;

    if (!element) return;

    const painter = sized(element, lookOf({ id, avatar: appearance }), size);

    if (shared === undefined) return;

    const { state, doing } = initial();

    return animate(element, painter, state, doing, shared, avatar);
  }, [canvas, avatar, id, appearance, size, shared]);
}

/** Paints a still avatar whenever its look, size, or expression changes. */
function useStill(
  canvas: RefObject<HTMLCanvasElement | null>,
  { id, avatar: appearance }: Pick<Bot, "id" | "avatar">,
  size: number,
  moving: boolean,
  expression: Expression,
) {
  useLayoutEffect(() => {
    const element = canvas.current;

    if (element && !moving)
      paintStill(
        element,
        new BotPainter(lookOf({ id, avatar: appearance }), size),
        expression,
      );
  }, [canvas, id, appearance, size, moving, expression]);
}

/** Hands a live avatar its held face and every state and activity change. */
function useFollow(
  avatar: RefObject<Live | null>,
  state: BotState,
  doing: Activity,
  face: Expression | undefined,
  remount: string | null,
) {
  useLayoutEffect(() => {
    if (avatar.current) avatar.current.face = face;
  }, [avatar, face, remount]);

  useEffect(() => {
    if (avatar.current) follow(avatar.current, state, doing);
  }, [avatar, state, doing]);
}

const defaultActivity = (state: BotState): Activity =>
  state === "working" ? "writing" : "idle";

/** Keeps a live avatar's sleeping Zs in the text color as the color scheme changes. */
function useSleepColor(
  moving: boolean,
  avatar: RefObject<Live | null>,
  canvas: RefObject<HTMLCanvasElement | null>,
) {
  useEffect(() => {
    if (!moving) return;

    const scheme = matchMedia("(prefers-color-scheme: dark)");

    const recolor = () => {
      if (avatar.current && canvas.current)
        avatar.current.zColor = getComputedStyle(canvas.current).color;
    };

    scheme.addEventListener("change", recolor);

    return () => scheme.removeEventListener("change", recolor);
  }, [moving, avatar, canvas]);
}

/**
 * Starts drawing a live avatar every frame, with gestures shared under `shared` when given, and
 * returns how to stop.
 */
function animate(
  element: HTMLCanvasElement,
  painter: BotPainter,
  state: BotState,
  doing: Activity,
  shared: string | null,
  avatar: RefObject<Live | null>,
) {
  const make = () => new Gestures(painter.look, now(), state, doing);

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
    state,
    face: undefined,
    gestures: shared ? acquire(shared, make) : make(),
  };

  avatar.current = entry;
  start(entry);

  return () => {
    live.delete(entry);
    avatar.current = null;

    if (shared) release(shared);
  };
}

/** Moves a live avatar toward a new state and tells its gestures; an idle-only gaze lets go. */
function follow(entry: Live, state: BotState, doing: Activity) {
  const time = now();

  entry.gestures.observe(state, doing, time);

  if (entry.state === state) return;

  entry.from = blendAt(entry, time);
  entry.target = blendOf(state);
  entry.since = time;
  entry.duration = state === "sleeping" ? 0.95 : 0.55;
  entry.state = state;

  if (state !== "idle" && entry.watching) {
    entry.watching = false;
    entry.watchSince = time;
  }
}

function paintStill(
  element: HTMLCanvasElement,
  painter: BotPainter,
  expression: Expression,
) {
  const ratio = element.width / painter.size;
  const context = element.getContext("2d")!;

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, painter.size, painter.size);
  painter.paint(context, REST, [[expression, 1]]);
}

const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A bot's drawn face, as in the native apps. Live avatars breathe, glance, blink and watch the
 * pointer while idle, hop while working, and doze while asleep. On the web they also react to
 * pokes, petting and fast pointers, and fidget in their seeded temperament.
 */
export function BotAvatar({
  bot,
  size = 28,
  state = "idle",
  live: animated = false,
  activity,
  face,
  independent = false,
  className,
  ref,
}: {
  bot: Pick<Bot, "id" | "avatar">;
  size?: number;
  state?: BotState;
  live?: boolean;
  /** What the bot is doing while it works or after its turn failed; working alone means writing. */
  activity?: Activity;
  /** Keeps this avatar's gestures to itself instead of sharing them with the bot's other avatars. */
  independent?: boolean;
  /** Holds one expression instead of the state's, as the avatar studio does. */
  face?: Expression;
  className?: string;
  ref?: Ref<BotAvatarHandle>;
}) {
  const { canvas, avatar } = useLiveAvatar(bot, size, state, {
    animated,
    activity,
    face,
    independent,
  });

  useImperativeHandle(
    ref,
    () => ({
      play: (gesture) => avatar.current?.gestures.play(gesture, now()),
    }),
    [avatar],
  );

  return (
    <canvas
      ref={canvas}
      aria-hidden
      className={cn("shrink-0 text-muted-foreground", className)}
      style={{ width: size, height: size }}
      {...pointerHandlers(avatar, state)}
    />
  );
}

/**
 * A bot's live avatar driven by its chat: asleep while paused, acting out its current work, and
 * worried after a failed turn. Every place showing the same bot shows the same thing.
 */
export function LiveBotAvatar({
  bot,
  size,
  className,
}: {
  bot: Pick<Bot, "id" | "avatar" | "enabled">;
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
      activity={activity}
      {...(className && { className })}
    />
  );
}
