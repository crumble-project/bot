// A port of apfelkern's BotAvatar library (Swift), so bots look and move the same as in the native
// apps. Adapted from Hermex's drawn bot faces (MIT); see THIRD_PARTY_NOTICES.md.

export type BotState = "idle" | "working" | "sleeping";

type Silhouette =
  | "circle"
  | "squircle"
  | "pill"
  | "triangle"
  | "hexagon"
  | "cloud"
  | "drop";

type Mouth = "smile" | "grin" | "cat" | "tiny";

type Topper = "none" | "antenna" | "sprout" | "tuft";

type Expression = "calm" | "delighted" | "focused" | "asleep";

const SILHOUETTES: Silhouette[] = [
  "circle",
  "squircle",
  "pill",
  "triangle",
  "hexagon",
  "cloud",
  "drop",
];

const MOUTHS: Mouth[] = ["smile", "grin", "cat", "tiny"];
const TOPPERS: Topper[] = ["none", "antenna", "sprout", "tuft"];

const PALETTE = [
  "#8b5cf6",
  "#38bdf8",
  "#14b8a6",
  "#22c55e",
  "#f59e0b",
  "#f97316",
  "#ef4444",
  "#ec4899",
];

const U64 = (1n << 64n) - 1n;

/** The seed in a `bot:` or `critters:` avatar, else the bot's ID. */
export function avatarSeed(bot: { id: string; avatar: string }) {
  for (const prefix of ["bot:", "critters:"])
    if (bot.avatar.startsWith(prefix)) {
      const seed = bot.avatar.slice(prefix.length).trim();

      if (seed) return seed;
    }

  return bot.id.trim() || "crumble";
}

type RGB = [number, number, number];

export class BotLook {
  readonly hash: bigint;
  readonly silhouette: Silhouette;
  readonly hex: string;
  readonly mouth: Mouth;
  readonly topper: Topper;
  readonly rgb: RGB;

  constructor(seed: string) {
    let hash = 1469598103934665603n;

    for (const byte of new TextEncoder().encode(seed))
      hash = ((hash ^ BigInt(byte)) * 1099511628211n) & U64;

    this.hash = hash;
    this.silhouette = SILHOUETTES[Number(hash % 7n)]!;
    this.hex = PALETTE[Number(hash % 8n)]!;
    this.mouth = MOUTHS[Number((hash >> 16n) % 4n)]!;
    this.topper = TOPPERS[Number((hash >> 24n) % 4n)]!;

    const value = Number.parseInt(this.hex.slice(1), 16);

    this.rgb = [
      ((value >> 16) & 0xff) / 255,
      ((value >> 8) & 0xff) / 255,
      (value & 0xff) / 255,
    ];
  }

  /** `hash % divisor` as a number, for seeded rhythms. */
  mod(divisor: number) {
    return Number(this.hash % BigInt(divisor));
  }

  /** The body color moved toward white for positive amounts and toward black for negative ones. */
  tint(amount: number, alpha = 1) {
    const target = amount > 0 ? 1 : 0;
    const mix = Math.abs(amount);

    const [red, green, blue] = this.rgb.map((channel) =>
      Math.round((channel + (target - channel) * mix) * 255),
    );

    return `rgb(${red} ${green} ${blue} / ${alpha})`;
  }

  get ink() {
    return this.tint(-0.8);
  }

  /** Pink cheeks vanish on warm bodies, so those blush white instead. */
  blush(alpha: number) {
    return ["#ef4444", "#ec4899", "#f97316", "#f59e0b"].includes(this.hex)
      ? `rgb(255 255 255 / ${0.5 * alpha})`
      : `rgb(255 107 153 / ${0.55 * alpha})`;
  }
}

export type Pose = {
  gazeX: number;
  gazeY: number;
  roll: number;
  lid: number;
  lift: number;
  scaleX: number;
  scaleY: number;
  mouthOpen: number;
  sway: number;
  glow: number;
};

export const REST: Pose = {
  gazeX: 0,
  gazeY: 0,
  roll: 0,
  lid: 1,
  lift: 0,
  scaleX: 1,
  scaleY: 1,
  mouthOpen: 0,
  sway: 0,
  glow: 0,
};

const SHUT_LID = 0.06;
const IDLE_LOOP = 36;
const WORKING_LOOP = 25.2;
const SLEEPING_LOOP = 16;

const rate = (count: number, loop: number) => (2 * Math.PI * count) / loop;

/** A period close to `period` that divides the loop evenly, and how many times it fits. */
function snap(period: number, loop: number): [number, number] {
  const count = Math.max(1, Math.round(loop / period));

  return [loop / count, count];
}

function positive(value: number, period: number) {
  const remainder = value % period;

  return remainder < 0 ? remainder + period : remainder;
}

const wrap = (step: number, count: number) =>
  BigInt(Math.trunc(positive(step, count)));

// Swift's `>>` binds tighter than `&*`, so the last multiply is by the constant shifted right by 7.
function mix(hash: bigint, step: bigint) {
  let value = ((hash ^ step) * 0x9e3779b97f4a7c15n) & U64;

  value ^= value >> 31n;

  return (value * (0xbf58476d1ce4e5b9n >> 7n)) & U64;
}

function target(hash: bigint, step: bigint): [number, number] {
  const value = mix(hash, step);

  if (value % 3n === 0n) return [0, 0];

  return [
    (Number(value % 1000n) / 500 - 1) * 0.035,
    (Number((value >> 20n) % 1000n) / 500 - 1) * 0.022,
  ];
}

/** Blinks for 180 ms every 3 to 5 seconds, seeded; every third blink is a double. */
function blink(time: number, look: BotLook) {
  const [period, count] = snap(3 + look.mod(2001) / 1000, IDLE_LOOP);
  const cycle = Math.floor(time / period);
  const offset = time - cycle * period;
  const shut = 0.18;

  const closed = (moment: number) =>
    1 - (1 - SHUT_LID) * Math.sin((moment / shut) * Math.PI);

  if (offset < shut) return closed(offset);

  const double = mix(look.hash, wrap(cycle, count)) % 3n === 0n;

  if (double && offset > 0.28 && offset < 0.28 + shut)
    return closed(offset - 0.28);

  return 1;
}

/** Holds a gaze for two to three and a half seconds, then darts to the next one. */
function glance(time: number, look: BotLook): [number, number] {
  const [hold, count] = snap(
    2 + Number((look.hash >> 8n) % 1500n) / 1000,
    IDLE_LOOP,
  );

  const step = Math.floor(time / hold);
  const into = (time - step * hold) / 0.14;
  const ease = into >= 1 ? 1 : into * into * (3 - 2 * into);
  const from = target(look.hash, wrap(step - 1, count));
  const next = target(look.hash, wrap(step, count));

  return [
    from[0] + (next[0] - from[0]) * ease,
    from[1] + (next[1] - from[1]) * ease,
  ];
}

function idlePose(time: number, look: BotLook): Pose {
  const local = time + look.mod(10_000) / 1000;
  const breath = Math.sin(local * rate(10, IDLE_LOOP));
  const roll = Math.sin(local * rate(3, IDLE_LOOP)) * 2.2;
  const [gazeX, gazeY] = glance(local, look);
  const phase = positive(local, look.hash % 2n === 0n ? 12 : 18);
  const stretch = phase < 1.8 ? Math.sin((phase / 1.8) * Math.PI) ** 4 : 0;

  return {
    ...REST,
    gazeX,
    gazeY,
    roll,
    lid: blink(local, look),
    lift: 0.006 * (breath + 1),
    scaleX: 1 - 0.012 * breath - 0.035 * stretch,
    scaleY: 1 + 0.022 * breath + 0.055 * stretch,
    sway: -roll * 1.6 + Math.sin(local * rate(8, IDLE_LOOP)) * 3 + stretch * 7,
  };
}

/** Leans aside and sways, hopping on the spot; each landing squashes once on the ground. */
function workingPose(time: number): Pose {
  const loop = WORKING_LOOP;
  const turn = -11 + Math.sin(time * rate(2, loop)) * 8;

  const tilt =
    Math.sin(time * rate(2, loop) + 1.3) * 8 +
    Math.sin(time * rate(4, loop)) * 1.6;

  const blinkPeriod = loop / 17;
  const blinking = positive(time, blinkPeriod) > blinkPeriod * 0.869;
  const hop = positive(time, 0.9) / 0.9;
  const ground = 0.12;
  const contact = Math.min(hop, 1 - hop);

  const squash =
    contact < ground
      ? 1 - 0.055 * Math.cos((contact / ground) * (Math.PI / 2))
      : 1;

  const air = contact < ground ? 0 : (hop - ground) / (1 - 2 * ground);

  return {
    gazeX: turn * 0.0025,
    gazeY: -tilt * 0.0025,
    roll: Math.sin(time * rate(3, loop)) * 4.2,
    lid: blinking ? SHUT_LID : 1,
    lift: 0.04 * Math.sin(air * Math.PI),
    scaleX: 2 - squash,
    scaleY: squash,
    mouthOpen: 0.5 + 0.5 * Math.sin(time * rate(18, loop)),
    sway: -Math.sin(air * 2 * Math.PI) * 9 - Math.sin(time * rate(3, loop)) * 4,
    glow: 0.55 + 0.45 * Math.sin(time * rate(20, loop)),
  };
}

function sleepingPose(time: number): Pose {
  const breath = Math.sin(time * rate(4, SLEEPING_LOOP));

  return {
    ...REST,
    gazeY: 0.03,
    roll: -5 + Math.sin(time * rate(1, SLEEPING_LOOP)) * 1.5,
    lid: SHUT_LID,
    scaleX: 1 - 0.02 * breath,
    scaleY: 1 + 0.035 * breath,
    mouthOpen: 0.5 + 0.5 * breath,
    sway: 6 + breath * 3,
  };
}

/** Turns the eyes toward a point (fractions of the size) and perks up, by `pull` from 0 to 1. */
function watching(pose: Pose, point: [number, number], pull: number): Pose {
  if (pull <= 0) return pose;

  const targetX = Math.min(0.045, Math.max(-0.045, (point[0] - 0.6) * 0.1));
  const targetY = Math.min(0.03, Math.max(-0.03, (point[1] - 0.46) * 0.08));

  return {
    ...pose,
    gazeX: pose.gazeX + (targetX - pose.gazeX) * pull,
    gazeY: pose.gazeY + (targetY - pose.gazeY) * pull,
    lift: pose.lift + 0.008 * pull,
    scaleY: pose.scaleY + 0.01 * pull,
  };
}

export type Blend = { idle: number; working: number; sleeping: number };

export const blendOf = (state: BotState): Blend => ({
  idle: state === "idle" ? 1 : 0,
  working: state === "working" ? 1 : 0,
  sleeping: state === "sleeping" ? 1 : 0,
});

export const mixBlend = (from: Blend, to: Blend, amount: number): Blend => ({
  idle: from.idle + (to.idle - from.idle) * amount,
  working: from.working + (to.working - from.working) * amount,
  sleeping: from.sleeping + (to.sleeping - from.sleeping) * amount,
});

/** The pose of a blend of states, watching `point` by `pull` while idle. */
export function blendPose(
  blend: Blend,
  time: number,
  look: BotLook,
  point: [number, number],
  pull: number,
): Pose {
  const local = time + look.mod(10_000) / 1000;

  if (blend.sleeping === 1) return sleepingPose(local);

  const workTime = local * (0.92 + look.mod(17) / 100);

  if (blend.working === 1) return workingPose(workTime);

  const rest =
    blend.idle > 0 ? watching(idlePose(time, look), point, pull) : REST;

  if (blend.idle === 1) return rest;

  const work = blend.working > 0 ? workingPose(workTime) : REST;
  const sleep = blend.sleeping > 0 ? sleepingPose(local) : REST;

  const mixed = (key: keyof Pose) =>
    rest[key] * blend.idle +
    work[key] * blend.working +
    sleep[key] * blend.sleeping;

  return {
    gazeX: mixed("gazeX"),
    gazeY: mixed("gazeY"),
    roll: mixed("roll"),
    lid: mixed("lid"),
    lift: mixed("lift"),
    scaleX: mixed("scaleX"),
    scaleY: mixed("scaleY"),
    mouthOpen: mixed("mouthOpen"),
    sway: mixed("sway"),
    glow: mixed("glow"),
  };
}

export const expressionOf = (state: BotState): Expression =>
  state === "working" ? "focused" : state === "sleeping" ? "asleep" : "calm";

type Rect = { x: number; y: number; width: number; height: number };

type Point = [number, number];

/** A body outline as Path2D, its tight bounds, and for the cloud, the puffs whose union it is. */
type Body = { path: Path2D; bounds: Rect; puffs?: Rect[] };

function bodyOf(silhouette: Silhouette, rect: Rect): Body {
  const inset = {
    x: rect.x + rect.width * 0.08,
    y: rect.y + rect.height * 0.08,
    width: rect.width * 0.84,
    height: rect.height * 0.84,
  };

  const maxX = inset.x + inset.width;
  const maxY = inset.y + inset.height;
  const midX = rect.x + rect.width / 2;
  const at = (fraction: number) => rect.y + rect.height * fraction;
  const path = new Path2D();

  switch (silhouette) {
    case "circle":
      path.ellipse(
        midX,
        inset.y + inset.height / 2,
        inset.width / 2,
        inset.height / 2,
        0,
        0,
        Math.PI * 2,
      );

      return { path, bounds: inset };
    case "squircle":
      path.roundRect(
        inset.x,
        inset.y,
        inset.width,
        inset.height,
        rect.width * 0.28,
      );

      return { path, bounds: inset };
    case "pill": {
      const pill = {
        x: inset.x,
        y: at(0.5) - rect.height * 0.27,
        width: inset.width,
        height: rect.height * 0.54,
      };

      path.roundRect(pill.x, pill.y, pill.width, pill.height, pill.height / 2);

      return { path, bounds: pill };
    }

    case "triangle":
      path.moveTo(midX, inset.y);
      path.lineTo(maxX, maxY);
      path.lineTo(inset.x, maxY);
      path.closePath();

      return { path, bounds: inset };
    case "hexagon": {
      const points: Point[] = [
        [midX, inset.y],
        [maxX, at(0.3)],
        [maxX, at(0.7)],
        [midX, maxY],
        [inset.x, at(0.7)],
        [inset.x, at(0.3)],
      ];

      points.forEach(([x, y], index) =>
        index === 0 ? path.moveTo(x, y) : path.lineTo(x, y),
      );
      path.closePath();

      return { path, bounds: inset };
    }

    case "cloud": {
      const puffs = [
        [0.08, 0.38, 0.48, 0.48],
        [0.28, 0.12, 0.5, 0.64],
        [0.55, 0.35, 0.38, 0.45],
      ].map(([left, top, width, height]) => ({
        x: rect.x + rect.width * left!,
        y: rect.y + rect.height * top!,
        width: rect.width * width!,
        height: rect.height * height!,
      }));

      for (const puff of puffs) {
        path.moveTo(puff.x + puff.width, puff.y + puff.height / 2);
        path.ellipse(
          puff.x + puff.width / 2,
          puff.y + puff.height / 2,
          puff.width / 2,
          puff.height / 2,
          0,
          0,
          Math.PI * 2,
        );
      }

      const left = Math.min(...puffs.map((puff) => puff.x));
      const top = Math.min(...puffs.map((puff) => puff.y));
      const right = Math.max(...puffs.map((puff) => puff.x + puff.width));
      const bottom = Math.max(...puffs.map((puff) => puff.y + puff.height));

      return {
        path,
        bounds: { x: left, y: top, width: right - left, height: bottom - top },
        puffs,
      };
    }

    case "drop": {
      const side = at(0.62);

      path.moveTo(midX, inset.y);
      path.bezierCurveTo(
        midX + rect.width * 0.22,
        at(0.2),
        maxX,
        at(0.42),
        maxX,
        side,
      );
      path.bezierCurveTo(maxX, maxY, inset.x, maxY, inset.x, side);
      path.bezierCurveTo(
        inset.x,
        at(0.42),
        midX - rect.width * 0.22,
        at(0.2),
        midX,
        inset.y,
      );

      // The bottom curve's lowest point, at its middle: a quarter of the ends plus three quarters of the controls.
      const bottom = 0.25 * side + 0.75 * maxY;

      return {
        path,
        bounds: {
          x: inset.x,
          y: inset.y,
          width: inset.width,
          height: bottom - inset.y,
        },
      };
    }
  }
}

const LAYOUTS: Record<Silhouette, { face: Point; scale: number; top: Point }> =
  {
    circle: { face: [0.6, 0.47], scale: 1, top: [0.5, 0.08] },
    squircle: { face: [0.6, 0.47], scale: 1, top: [0.5, 0.08] },
    hexagon: { face: [0.58, 0.49], scale: 0.95, top: [0.5, 0.08] },
    pill: { face: [0.6, 0.49], scale: 0.8, top: [0.5, 0.23] },
    triangle: { face: [0.54, 0.64], scale: 0.78, top: [0.5, 0.08] },
    cloud: { face: [0.56, 0.52], scale: 0.85, top: [0.53, 0.12] },
    drop: { face: [0.54, 0.62], scale: 0.9, top: [0.5, 0.08] },
  };

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** Paints a bot, lengths in fractions of `size`, from the top left like the native canvas. */
export class BotPainter {
  readonly frame: Rect;
  readonly body: Body;
  private readonly layout: (typeof LAYOUTS)[Silhouette];
  private readonly detailed: boolean;

  constructor(
    readonly look: BotLook,
    readonly size: number,
  ) {
    this.frame = {
      x: size * 0.04,
      y: size * 0.1,
      width: size * 0.92,
      height: size * 0.92,
    };

    this.body = bodyOf(look.silhouette, this.frame);
    this.layout = LAYOUTS[look.silhouette];
    this.detailed = size >= 22;
  }

  private point([x, y]: Point): Point {
    return [
      this.frame.x + x * this.frame.width,
      this.frame.y + y * this.frame.height,
    ];
  }

  private get faceCenter() {
    return this.point(this.layout.face);
  }

  private get unit() {
    return this.size * this.layout.scale;
  }

  get topperBase() {
    return this.point([this.layout.top[0], this.layout.top[1] + 0.06]);
  }

  private eyeCenter(side: number, pose: Pose): Point {
    const [x, y] = this.faceCenter;

    return [
      x + this.unit * side * 0.0875 + this.size * pose.gazeX,
      y - this.unit * 0.045 + this.size * pose.gazeY,
    ];
  }

  private mouthCenter(pose: Pose): Point {
    const [x, y] = this.faceCenter;

    return [
      x - this.unit * 0.012 + this.size * pose.gazeX * 0.65,
      y + this.unit * 0.125 + this.size * pose.gazeY * 0.65,
    ];
  }

  /** A whole frame: shadow, then the body moved by the pose, its topper, and blended faces. */
  paint(
    context: Context,
    pose: Pose,
    expressions: [Expression, number][],
    body?: CanvasImageSource,
  ) {
    const { bounds } = this.body;

    this.paintShadow(context, pose);
    context.save();

    const base: Point = [bounds.x + bounds.width / 2, bounds.y + bounds.height];

    context.translate(0, -this.size * pose.lift);
    context.translate(base[0], base[1]);
    context.scale(pose.scaleX, pose.scaleY);
    context.rotate((pose.roll * Math.PI) / 180);
    context.translate(-base[0], -base[1]);
    this.paintTopper(context, pose);

    if (body) context.drawImage(body, 0, 0, this.size, this.size);
    else this.paintBody(context, expressions[0]?.[0] ?? "calm");

    for (const [expression, opacity] of expressions) {
      if (opacity <= 0) continue;

      context.save();
      context.globalAlpha *= opacity;
      this.paintFace(context, pose, expression);
      context.restore();
    }

    context.restore();
  }

  private softOval(
    context: Context,
    rect: Rect,
    color: (alpha: number) => string,
  ) {
    context.save();
    context.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
    context.scale(rect.width / 2, rect.height / 2);

    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);

    gradient.addColorStop(0, color(1));
    gradient.addColorStop(0.5, color(0.65));
    gradient.addColorStop(1, color(0));
    context.fillStyle = gradient;
    context.beginPath();
    context.ellipse(0, 0, 1, 1, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  private paintShadow(context: Context, pose: Pose) {
    const { bounds } = this.body;
    const rise = Math.min(1, pose.lift * 9);
    const width = bounds.width * 0.66 * pose.scaleX * (1 - 0.35 * rise);
    const height = this.size * 0.055 * (1 - 0.3 * rise);
    const grow = this.size * 0.012;

    this.softOval(
      context,
      {
        x: bounds.x + bounds.width / 2 - width / 2 - grow,
        y: bounds.y + bounds.height - height * 0.45 - grow,
        width: width + grow * 2,
        height: height + grow * 2,
      },
      (alpha) => `rgb(0 0 0 / ${0.2 * (1 - 0.55 * rise) * alpha})`,
    );
  }

  /** The body with its dither finish, cheeks and rim, at rest. */
  paintBody(context: Context, expression: Expression) {
    const { path, bounds } = this.body;

    context.fillStyle = this.look.tint(0);
    context.fill(path);
    context.save();
    context.clip(path);
    this.paintDither(context, bounds);

    if (this.detailed) this.paintCheeks(context, expression);

    context.restore();
    this.paintRim(context);
  }

  /** The outline of the body; a cloud strokes only the outer edge of its merged puffs. */
  private paintRim(context: Context) {
    context.strokeStyle = this.look.tint(-0.45, 0.3);
    context.lineWidth = Math.max(0.6, this.size * 0.01);

    if (!this.body.puffs) {
      context.stroke(this.body.path);

      return;
    }

    const ellipse = (puff: Rect) => {
      const path = new Path2D();

      path.ellipse(
        puff.x + puff.width / 2,
        puff.y + puff.height / 2,
        puff.width / 2,
        puff.height / 2,
        0,
        0,
        Math.PI * 2,
      );

      return path;
    };

    for (const [index, puff] of this.body.puffs.entries()) {
      context.save();

      for (const [other, cover] of this.body.puffs.entries()) {
        if (other === index) continue;

        const outside = new Path2D();

        outside.rect(0, 0, this.size, this.size);
        outside.addPath(ellipse(cover));
        context.clip(outside, "evenodd");
      }

      context.stroke(ellipse(puff));
      context.restore();
    }
  }

  /** Light from the top left with a soft highlight, from -1 in shadow to 1 fully lit. */
  private light(x: number, y: number, bounds: Rect) {
    const across = (x - bounds.x) / bounds.width;
    const down = (y - bounds.y) / bounds.height;
    const falloff = (0.42 - (0.4 * across + 0.6 * down)) * 1.9;
    const spot = Math.max(0, 1 - Math.hypot(across - 0.33, down - 0.22) / 0.26);

    return Math.min(1, Math.max(-1, falloff + 0.6 * spot));
  }

  /** A 4×4 ordered dither between the body color and a lighter and a darker step of it. */
  private paintDither(context: Context, bounds: Rect) {
    const cell = Math.max(0.5, Math.round((this.size / 44) * 2) / 2);
    const originX = Math.floor(bounds.x * 2) / 2;
    const originY = Math.floor(bounds.y * 2) / 2;
    const lit = new Path2D();
    const shade = new Path2D();
    const rows = Math.trunc((bounds.y + bounds.height - originY) / cell + 1);
    const columns = Math.trunc((bounds.x + bounds.width - originX) / cell + 1);

    for (let row = 0; row < rows; row++)
      for (let column = 0; column < columns; column++) {
        const x = originX + column * cell;
        const y = originY + row * cell;
        const value = this.light(x + cell / 2, y + cell / 2, bounds);
        const threshold = (BAYER[row % 4]![column % 4]! + 0.5) / 16;

        if (value > threshold) lit.rect(x, y, cell, cell);
        else if (-value > threshold) shade.rect(x, y, cell, cell);
      }

    context.fillStyle = this.look.tint(0.3);
    context.fill(lit);
    context.fillStyle = this.look.tint(-0.24);
    context.fill(shade);
  }

  private paintCheeks(context: Context, expression: Expression) {
    const glow = expression === "delighted" ? 0.22 : 0.12;
    const [x, y] = this.faceCenter;

    for (const side of [-1, 1]) {
      const centerX = x + this.unit * (side * 0.175 - 0.01);
      const centerY = y + this.unit * 0.085;

      this.softOval(
        context,
        {
          x: centerX - this.unit * 0.045,
          y: centerY - this.unit * 0.025,
          width: this.unit * 0.09,
          height: this.unit * 0.05,
        },
        (alpha) => this.look.blush(glow * alpha),
      );
    }
  }

  private paintFace(context: Context, pose: Pose, expression: Expression) {
    for (const side of [-1, 1]) {
      const center = this.eyeCenter(side, pose);

      if (expression === "asleep") this.paintClosedEye(context, center);
      else this.paintEye(context, center, pose);
    }

    this.paintMouth(context, pose, expression);
  }

  private paintEye(context: Context, [x, y]: Point, pose: Pose) {
    const width = this.unit * 0.068;
    const height = Math.max(width * 0.55, this.unit * 0.145 * pose.lid);

    context.save();
    context.translate(x, y);
    context.rotate((-8 * Math.PI) / 180);
    context.fillStyle = this.look.ink;
    context.beginPath();
    context.roundRect(
      -width / 2,
      -height / 2,
      width,
      height,
      Math.min(width, height) / 2,
    );
    context.fill();

    if (this.detailed && pose.lid > 0.6) {
      const spark = width * 0.25;

      context.fillStyle = "rgb(255 255 255 / 0.5)";
      context.beginPath();
      context.ellipse(
        -width * 0.28 + spark / 2,
        -height * 0.36 + spark / 2,
        spark / 2,
        spark / 2,
        0,
        0,
        Math.PI * 2,
      );
      context.fill();
    }

    context.restore();
  }

  private paintClosedEye(context: Context, [x, y]: Point) {
    const half = this.unit * 0.05;

    context.beginPath();
    context.moveTo(x - half, y + this.unit * 0.02);
    context.quadraticCurveTo(
      x,
      y + this.unit * 0.065,
      x + half,
      y + this.unit * 0.005,
    );
    context.strokeStyle = this.look.ink;
    context.lineWidth = this.unit * 0.034;
    context.lineCap = "round";
    context.stroke();
  }

  private oval(context: Context, [x, y]: Point, width: number, height: number) {
    context.beginPath();
    context.ellipse(x, y, width / 2, height / 2, 0, 0, Math.PI * 2);
  }

  private smile(context: Context, [x, y]: Point, width: number, depth: number) {
    context.moveTo(x - width / 2, y - depth / 2);
    context.quadraticCurveTo(x, y + depth * 1.1, x + width / 2, y - depth / 2);
  }

  private paintMouth(context: Context, pose: Pose, expression: Expression) {
    const center = this.mouthCenter(pose);
    const unit = this.unit;

    context.fillStyle = this.look.ink;
    context.strokeStyle = this.look.ink;
    context.lineWidth = Math.max(0.8, unit * 0.026);
    context.lineCap = "round";
    context.lineJoin = "round";

    switch (expression) {
      case "asleep":
        this.oval(
          context,
          center,
          unit * 0.034,
          unit * (0.022 + 0.016 * pose.mouthOpen),
        );
        context.fill();

        return;
      case "focused":
        this.oval(
          context,
          center,
          unit * 0.046,
          unit * (0.03 + 0.022 * pose.mouthOpen),
        );
        context.fill();

        return;
      case "delighted":
        this.paintGrin(context, center, unit * 0.105, unit * 0.035);

        return;
      case "calm":
        break;
    }

    switch (this.look.mouth) {
      case "smile":
        context.beginPath();
        this.smile(context, center, unit * 0.1, unit * 0.025);
        context.stroke();
        break;
      case "tiny":
        context.beginPath();
        this.smile(context, center, unit * 0.06, unit * 0.015);
        context.stroke();
        break;
      case "grin":
        this.paintGrin(context, center, unit * 0.09, unit * 0.025);
        break;
      case "cat":
        context.beginPath();
        this.smile(
          context,
          [center[0] - unit * 0.026, center[1]],
          unit * 0.052,
          unit * 0.03,
        );
        this.smile(
          context,
          [center[0] + unit * 0.026, center[1]],
          unit * 0.052,
          unit * 0.03,
        );
        context.stroke();
        break;
    }
  }

  private paintGrin(
    context: Context,
    [x, y]: Point,
    width: number,
    depth: number,
  ) {
    const grin = new Path2D();

    grin.moveTo(x - width / 2, y - depth * 0.25);
    grin.lineTo(x + width / 2, y - depth * 0.25);
    grin.quadraticCurveTo(x, y + depth * 1.6, x - width / 2, y - depth * 0.25);
    grin.closePath();
    context.fillStyle = this.look.ink;
    context.fill(grin);

    if (!this.detailed) return;

    context.save();
    context.clip(grin);
    context.fillStyle = "rgb(255 115 140)";
    this.oval(context, [x, y + depth * 0.95], width * 0.32, depth * 0.45);
    context.fill();
    context.restore();
  }

  private paintTopper(context: Context, pose: Pose) {
    if (this.look.topper === "none") return;

    const [x, y] = this.topperBase;

    context.save();
    context.translate(x, y);
    context.rotate((pose.sway * Math.PI) / 180);

    if (this.look.topper === "antenna") this.paintAntenna(context, pose);
    else if (this.look.topper === "sprout") this.paintSprout(context);
    else this.paintTuft(context);

    context.restore();
  }

  private paintAntenna(context: Context, pose: Pose) {
    const size = this.size;

    context.beginPath();
    context.moveTo(0, 0);
    context.quadraticCurveTo(size * 0.025, -size * 0.09, 0, -size * 0.16);
    context.strokeStyle = this.look.tint(-0.35);
    context.lineWidth = size * 0.036;
    context.lineCap = "round";
    context.stroke();

    const radius = size * 0.058;
    const tip: Point = [0, -size * 0.16];

    if (pose.glow > 0) {
      const halo = radius + size * 0.07 * pose.glow;

      this.softOval(
        context,
        { x: -halo, y: tip[1] - halo, width: halo * 2, height: halo * 2 },
        (alpha) => this.look.tint(0.5, pose.glow * 0.6 * alpha),
      );
    }

    context.fillStyle = this.look.tint(0.4 + 0.3 * pose.glow);
    this.oval(context, tip, radius * 2, radius * 2);
    context.fill();
  }

  private paintSprout(context: Context) {
    const size = this.size;
    const lime = this.look.hex === "#22c55e" || this.look.hex === "#14b8a6";
    const green: RGB = lime ? [0.75, 0.95, 0.39] : [0.29, 0.85, 0.5];

    const toward = (target: number, amount: number) =>
      `rgb(${green.map((channel) => Math.round((channel + (target - channel) * amount) * 255)).join(" ")})`;

    context.beginPath();
    context.moveTo(0, 0);
    context.quadraticCurveTo(-size * 0.02, -size * 0.05, 0, -size * 0.1);
    context.strokeStyle = toward(0, 0.3);
    context.lineWidth = size * 0.03;
    context.lineCap = "round";
    context.stroke();

    for (const side of [-1, 1]) {
      context.save();
      context.translate(0, -size * 0.1);
      context.rotate(((side * 50 - 8) * Math.PI) / 180);

      const gradient = context.createLinearGradient(0, -size * 0.1, 0, 0);

      gradient.addColorStop(0, toward(1, 0.25));
      gradient.addColorStop(1, toward(0, 0));
      context.fillStyle = gradient;
      this.oval(context, [0, -size * 0.05], size * 0.075, size * 0.115);
      context.fill();
      context.restore();
    }
  }

  private paintTuft(context: Context) {
    const size = this.size;

    context.strokeStyle = this.look.tint(-0.3);
    context.lineWidth = size * 0.034;
    context.lineCap = "round";

    for (const [angle, length] of [
      [-28, 0.085],
      [0, 0.11],
      [28, 0.08],
    ] as const) {
      context.save();
      context.rotate((angle * Math.PI) / 180);
      context.beginPath();
      context.moveTo(0, 0);
      context.quadraticCurveTo(
        -size * 0.03,
        -size * length * 0.6,
        size * 0.035,
        -size * length,
      );
      context.stroke();
      context.restore();
    }
  }
}

/** Two Zs rise from a sleeping bot, grow, and fade, one after the other. */
export function paintZs(
  context: Context,
  size: number,
  time: number,
  opacity: number,
  color: string,
) {
  context.save();
  context.fillStyle = color;
  context.textAlign = "center";
  context.textBaseline = "middle";

  for (const index of [0, 1]) {
    const phase = (time / 3 + index * 0.5) % 1;
    const scale = (0.16 + 0.1 * phase) / 0.26;

    context.save();
    context.globalAlpha = opacity * Math.sin(phase * Math.PI);
    context.translate(
      size * (0.5 + 0.34 + 0.12 * phase),
      size * (0.5 - 0.22 - 0.32 * phase),
    );
    context.scale(scale, scale);
    context.font = `900 ${size * 0.26}px ui-rounded, system-ui, sans-serif`;
    context.fillText("z", 0, 0);
    context.restore();
  }

  context.restore();
}
