// Web-only gestures layered on the ported poses: bots react to pokes, petting and fast pointers,
// fidget while idle, act out what they are doing, and celebrate finished work, each in its own
// temperament.
import type { Activity } from "./activity";
import type {
  BotLook,
  BotState,
  Expression,
  Pose,
  Temperament,
} from "./bot-avatar";

export type Gesture =
  | "boop"
  | "giggle"
  | "dizzy"
  | "startle"
  | "cheer"
  | "yawn"
  | "wiggle"
  | "hop"
  | "lookaround"
  | "shy";

type Motion = {
  duration: number;
  /** Seconds to ease in and out; slow looks get longer ones than quick bumps. */
  ease?: [number, number];
  face: Expression | null;
  pose: (base: Pose, elapsed: number, bounce: number) => Pose;
};

const decay = (elapsed: number, rate: number) => Math.exp(-elapsed * rate);

/** A half sine from `start` lasting `length` seconds, zero outside it. */
const arc = (elapsed: number, start: number, length: number) =>
  elapsed < start || elapsed > start + length
    ? 0
    : Math.sin(((elapsed - start) / length) * Math.PI);

const MOTIONS: Record<Gesture, Motion> = {
  boop: {
    duration: 0.75,
    face: "happy",
    pose: (base, time, bounce) => {
      const squash = decay(time, 7) * Math.cos(time * 20);

      return {
        ...base,
        scaleX: base.scaleX * (1 + 0.1 * bounce * squash),
        scaleY: base.scaleY * (1 - 0.13 * bounce * squash),
        lift: base.lift + 0.035 * bounce * arc(time, 0.1, 0.4),
        roll: base.roll + 6 * decay(time, 4) * Math.sin(time * 12),
        sway: base.sway + 16 * decay(time, 4) * Math.sin(time * 11),
        blush: 0.6,
      };
    },
  },
  giggle: {
    duration: 1.3,
    face: "happy",
    pose: (base, time, bounce) => {
      const shake = Math.sin(time * 17) * decay(time, 1.5);

      return {
        ...base,
        roll: base.roll + 7 * bounce * shake,
        scaleY: base.scaleY * (1 + 0.03 * Math.abs(shake)),
        lift: base.lift + 0.012 * bounce * Math.abs(Math.sin(time * 8.5)),
        sway: base.sway + 14 * shake,
        blush: 1,
      };
    },
  },
  dizzy: {
    duration: 2.6,
    ease: [0.15, 0.6],
    face: "dizzy",
    pose: (base, time) => ({
      ...base,
      gazeX: 0.018 * Math.cos(time * 6),
      gazeY: 0.012 * Math.sin(time * 6),
      roll: base.roll + 9 * Math.sin(time * 4.5),
      scaleX: base.scaleX * (1 + 0.03 * Math.sin(time * 9)),
      scaleY: base.scaleY * (1 - 0.03 * Math.sin(time * 9)),
      sway: base.sway + 16 * Math.sin(time * 4.5 + 1),
      spin: time * 10,
      lift: base.lift * 0.3,
    }),
  },
  startle: {
    duration: 0.8,
    face: "surprised",
    pose: (base, time, bounce) => ({
      ...base,
      lift: base.lift + 0.075 * bounce * arc(time, 0, 0.38),
      scaleX: base.scaleX * (1 - 0.05 * decay(time, 6)),
      scaleY: base.scaleY * (1 + 0.09 * decay(time, 6)),
      sway: base.sway + 22 * decay(time, 5) * Math.sin(time * 18),
      gazeY: -0.01,
      lid: 1,
    }),
  },
  cheer: {
    duration: 1.4,
    ease: [0.08, 0.35],
    face: "delighted",
    pose: (base, time, bounce) => {
      const hops = arc(time, 0, 0.5) + 0.6 * arc(time, 0.55, 0.42);
      const land = arc(time, 0.48, 0.12) + arc(time, 0.95, 0.12);

      return {
        ...base,
        lift: base.lift + 0.065 * bounce * hops,
        scaleX: base.scaleX * (1 + 0.06 * land),
        scaleY: base.scaleY * (1 - 0.07 * land + 0.04 * hops),
        roll: base.roll + 5 * Math.sin(time * 8),
        sway: base.sway - 12 * Math.sin(time * 8) * hops,
        glow: 1,
        blush: 0.5,
      };
    },
  },
  yawn: {
    duration: 2.2,
    ease: [0.35, 0.45],
    face: "yawning",
    pose: (base, time) => {
      const stretch = arc(time, 0.1, 1.8);

      return {
        ...base,
        scaleX: base.scaleX * (1 - 0.045 * stretch),
        scaleY: base.scaleY * (1 + 0.08 * stretch),
        roll: base.roll - 4 * stretch,
        mouthOpen: stretch,
        sway: base.sway + 6 * stretch,
      };
    },
  },
  wiggle: {
    duration: 1.1,
    face: null,
    pose: (base, time, bounce) => {
      const shimmy = Math.sin(time * 14) * arc(time, 0, 1.1);

      return {
        ...base,
        roll: base.roll + 6 * bounce * shimmy,
        scaleX: base.scaleX * (1 + 0.02 * Math.abs(shimmy)),
        sway: base.sway + 16 * shimmy,
      };
    },
  },
  hop: {
    duration: 0.95,
    face: "delighted",
    pose: (base, time, bounce) => {
      const hops = arc(time, 0.05, 0.4) + 0.45 * arc(time, 0.5, 0.3);
      const land = arc(time, 0.42, 0.1) + 0.6 * arc(time, 0.78, 0.1);

      return {
        ...base,
        lift: base.lift + 0.05 * bounce * hops,
        scaleX: base.scaleX * (1 + 0.06 * land),
        scaleY: base.scaleY * (1 - 0.07 * land),
        sway: base.sway - 12 * hops,
      };
    },
  },
  lookaround: {
    duration: 2.4,
    ease: [0.3, 0.45],
    face: null,
    pose: (base, time) => {
      const sweep = Math.sin((time / 2.4) * Math.PI * 2);

      return {
        ...base,
        gazeX: 0.042 * sweep,
        gazeY: -0.012 * arc(time, 0, 2.4),
        roll: base.roll + 4 * sweep,
        sway: base.sway - 6 * sweep,
      };
    },
  },
  shy: {
    duration: 2.2,
    ease: [0.35, 0.5],
    face: "shy",
    pose: (base) => ({
      ...base,
      gazeX: -0.04,
      gazeY: 0.022,
      roll: base.roll - 5,
      scaleY: base.scaleY * 0.98,
      lift: base.lift * 0.5,
      blush: 1,
    }),
  },
};

export const GESTURES: Gesture[] = [
  "boop",
  "giggle",
  "dizzy",
  "startle",
  "cheer",
  "yawn",
  "wiggle",
  "hop",
  "lookaround",
  "shy",
];

const FIDGETS: Record<Temperament, Gesture[]> = {
  curious: ["lookaround", "lookaround", "hop", "wiggle"],
  shy: ["lookaround", "wiggle"],
  playful: ["hop", "wiggle", "wiggle", "lookaround"],
  sleepy: ["yawn", "yawn", "lookaround"],
};

const POSE_KEYS: (keyof Pose)[] = [
  "gazeX",
  "gazeY",
  "roll",
  "lid",
  "lift",
  "scaleX",
  "scaleY",
  "mouthOpen",
  "sway",
  "glow",
  "blush",
  "spin",
];

function lerpPose(from: Pose, to: Pose, amount: number): Pose {
  const pose = { ...from };

  for (const key of POSE_KEYS)
    pose[key] = from[key] + (to[key] - from[key]) * amount;

  return pose;
}

const smooth = (value: number) => {
  const clamped = Math.min(1, Math.max(0, value));

  return clamped * clamped * (3 - 2 * clamped);
};

/** How strongly a gesture shows `elapsed` seconds in, eased at both ends. */
function envelope(motion: Motion, elapsed: number) {
  if (elapsed < 0 || elapsed >= motion.duration) return 0;

  const [rise, fall] = motion.ease ?? [0.1, 0.3];

  return smooth(Math.min(elapsed / rise, (motion.duration - elapsed) / fall));
}

/** Faces swap in the first half of a gesture's rise, so two faces barely overlap. */
const faceWeight = (amount: number) => smooth(amount * 2);

/** A handed-over gesture fades out over this many seconds instead of stopping. */
const HANDOFF = 0.25;

/** Moves `value` toward `target`, closing the gap at `rate` per second independent of frame rate. */
const approach = (
  value: number,
  target: number,
  rate: number,
  elapsed: number,
) => target + (value - target) * Math.exp(-rate * elapsed);

type Act = { face: Expression; pose: (base: Pose, time: number) => Pose };

/** How each activity changes the working pose; writing keeps the plain one. */
const ACTS: Record<Exclude<Activity, "idle" | "writing">, Act> = {
  thinking: {
    face: "curious",
    pose: (base, time) => ({
      ...base,
      lift: 0.006 * (1 + Math.sin(time * 2)),
      scaleX: 1,
      scaleY: 1 + 0.012 * Math.sin(time * 2),
      gazeX: -0.02 + 0.01 * Math.sin(time * 0.9),
      gazeY: -0.03,
      roll: 6 * Math.sin(time * 0.8),
      mouthOpen: 0,
      glow: 0.45 + 0.3 * Math.sin(time * 3),
    }),
  },
  searching: {
    face: "curious",
    pose: (base, time) => ({
      ...base,
      gazeX: 0.04 * Math.sin(time * 2.6),
      gazeY: -0.008,
      roll: base.roll + 4 * Math.sin(time * 2.6),
      glow: 1,
    }),
  },
  remembering: {
    face: "skeptical",
    pose: (base, time) => ({
      ...base,
      lift: 0.004,
      scaleX: 1,
      scaleY: 1,
      gazeX: 0.025,
      gazeY: -0.035,
      roll: -5 + 1.5 * Math.sin(time * 1.3),
      mouthOpen: 0,
    }),
  },
  tinkering: {
    face: "focused",
    pose: (base, time) => ({
      ...base,
      lift: base.lift * 0.6,
      gazeX: 0.012 * Math.sin(time * 7),
      gazeY: 0.025,
      roll: base.roll * 0.5 + 3,
    }),
  },
  struggling: {
    face: "worried",
    pose: (base, time) => ({
      ...base,
      lift: base.lift * 0.3,
      roll: base.roll * 0.4 + 2 * Math.sin(time * 11),
      scaleY: base.scaleY * 0.98,
      sway: base.sway + 6 * Math.sin(time * 9),
      gazeY: 0.01,
      mouthOpen: 0,
    }),
  },
  failed: {
    face: "worried",
    pose: (base) => ({
      ...base,
      gazeX: -0.01,
      gazeY: 0.03,
      roll: base.roll * 0.5 - 4,
      scaleX: base.scaleX * 1.015,
      scaleY: base.scaleY * 0.97,
      lift: 0,
      sway: base.sway - 8,
    }),
  },
};

const ACTED: (keyof typeof ACTS)[] = [
  "thinking",
  "searching",
  "remembering",
  "tinkering",
  "struggling",
  "failed",
];

/** Blends `face` in by `amount` over the faces so far, keeping the weights summing to one. */
function overlay(
  weights: Map<Expression, number>,
  face: Expression,
  amount: number,
) {
  if (amount <= 0) return;

  for (const [each, weight] of weights)
    weights.set(each, weight * (1 - amount));

  weights.set(face, (weights.get(face) ?? 0) + amount);
}

/** One bot's reactions, shared by all its live avatars: which gesture runs, how petted it feels, and when it fidgets next. */
export class Gestures {
  private gesture: Gesture | null = null;
  private since = 0;
  private previous: { gesture: Gesture; since: number } | null = null;
  private handedAt = -Infinity;
  private pokes: number[] = [];
  private pet = 0;
  private petTarget = 0;
  private lean = 0;
  private pointerX = 0.5;
  private strokes: number[] = [];
  private heading = 0;
  private travel = 0;
  private last: [number, number, number] | null = null;
  private enteredAt = -Infinity;
  private startledAt = -Infinity;
  private watchedSince: number | null = null;
  private shyAt = -Infinity;
  private watchedAt = -Infinity;
  private acting = new Map<keyof typeof ACTS, number>();
  private updatedAt: number;
  private nextFidget: number;
  private readonly bounce: number;

  constructor(
    readonly look: BotLook,
    time: number,
    private state: BotState,
    private activity: Activity,
  ) {
    this.updatedAt = time;
    this.nextFidget = time + this.fidgetGap();
    this.bounce =
      0.7 + 0.6 * look.energy + (look.temperament === "playful" ? 0.2 : 0);
  }

  private fidgetGap() {
    const gap = 6 + (1 - this.look.energy) * 10 + Math.random() * 6;

    return this.look.temperament === "sleepy" ? gap * 1.4 : gap;
  }

  private active(time: number) {
    const { gesture } = this;

    return gesture && time - this.since < MOTIONS[gesture].duration
      ? gesture
      : null;
  }

  play(gesture: Gesture, time: number) {
    const running = this.active(time);

    this.previous = running ? { gesture: running, since: this.since } : null;
    this.handedAt = time;
    this.gesture = gesture;
    this.since = time;
  }

  /** A click or tap: a boop, a giggle when repeated, dizzy when overdone; sleepers stir. */
  poke(time: number, state: BotState) {
    this.pokes = [...this.pokes.filter((at) => time - at < 1.6), time];

    if (state === "sleeping") return this.play("yawn", time);

    if (this.active(time) === "dizzy") return;

    const playful = this.look.temperament === "playful";
    const count = this.pokes.length;

    if (count >= (playful ? 5 : 6)) {
      this.pokes = [];
      this.play("dizzy", time);
    } else this.play(count >= (playful ? 2 : 3) ? "giggle" : "boop", time);
  }

  enter(time: number) {
    this.enteredAt = time;
    this.last = null;
  }

  leave() {
    this.last = null;
    this.watchedSince = null;
  }

  /** A pointer move, in fractions of the avatar: fast arrivals startle, back-and-forth strokes pet. */
  move([x, y]: [number, number], time: number, width: number) {
    const last = this.last;

    this.last = [x, y, time];

    if (!last) return;

    const dx = x - last[0];

    this.pointerX = x;

    const speed =
      (Math.hypot(dx, y - last[1]) * width) / Math.max(0.008, time - last[2]);

    this.startleIfRushed(speed, time);
    this.stroke(dx, time);
  }

  private startleIfRushed(speed: number, time: number) {
    const jumpy = this.look.temperament === "shy" ? 900 : 1500;
    const arriving = time - this.enteredAt < 0.15;
    const rested = time - this.startledAt > 3 && !this.active(time);

    if (!arriving || speed <= jumpy || !rested) return;

    this.startledAt = time;
    this.play("startle", time);
  }

  /** Counts direction changes after a real sweep; three in a second and a bit pet the bot. */
  private stroke(dx: number, time: number) {
    const heading = Math.sign(dx);

    if (heading && heading !== this.heading) {
      if (this.travel > 0.15) {
        this.strokes = [...this.strokes.filter((at) => time - at < 1.2), time];

        if (this.strokes.length >= 3)
          this.petTarget = Math.min(1, this.petTarget + 0.35);
      }

      this.heading = heading;
      this.travel = 0;
    }

    this.travel += Math.abs(dx);
  }

  /**
   * The bot's state and activity as one avatar sees them; every copy reports, the first change
   * counts. Finished work is cheered unless it failed, sleep comes and goes with a yawn, and a
   * failing tool startles.
   */
  observe(state: BotState, activity: Activity, time: number) {
    const { state: was, activity: did } = this;

    this.state = state;
    this.activity = activity;

    if (state !== was) {
      if (was === "working" && state === "idle" && activity !== "failed")
        this.play("cheer", time);
      else if (was === "sleeping" || state === "sleeping")
        this.play("yawn", time);
    } else if (activity !== did && activity === "struggling")
      this.play("startle", time);
  }

  /** Advances the clock: petting and activities ease, idle bots fidget, shy ones look away when watched. */
  update(time: number, idle: boolean, watching: boolean) {
    const elapsed = Math.min(0.1, Math.max(0, time - this.updatedAt));

    this.updatedAt = time;
    this.ease(elapsed);

    if (watching) this.watchedAt = time;

    if (!idle) {
      this.watchedSince = null;
      this.nextFidget = time + this.fidgetGap();

      return;
    }

    const seen = time - this.watchedAt < 0.1;
    const busy = this.active(time) !== null || this.pet > 0;

    this.blushWhenWatched(time, seen, busy);
    this.fidget(time, busy || seen || this.activity === "failed");
  }

  private ease(elapsed: number) {
    this.petTarget = Math.max(0, this.petTarget - elapsed * 0.45);
    this.pet = approach(this.pet, this.petTarget, 6, elapsed);

    if (this.pet < 0.002 && this.petTarget === 0) this.pet = 0;

    this.lean = approach(this.lean, this.pointerX - 0.5, 8, elapsed);
    this.easeActing(elapsed);
  }

  /** Fades the current activity in and the others out; a sleeping bot acts out only a failure. */
  private easeActing(elapsed: number) {
    const asleep = this.state === "sleeping";

    for (const act of ACTED) {
      const target =
        act === this.activity && (!asleep || act === "failed") ? 1 : 0;

      const weight = approach(this.acting.get(act) ?? 0, target, 5, elapsed);

      if (weight < 0.002 && target === 0) this.acting.delete(act);
      else this.acting.set(act, weight);
    }
  }

  private blushWhenWatched(time: number, seen: boolean, busy: boolean) {
    if (!seen) {
      this.watchedSince = null;

      return;
    }

    this.watchedSince ??= time;

    const shy = this.look.temperament === "shy";
    const long = time - this.watchedSince > 2.5 && time - this.shyAt > 7;

    if (!shy || !long || busy) return;

    this.shyAt = time;
    this.play("shy", time);
  }

  private fidget(time: number, held: boolean) {
    if (time < this.nextFidget) return;

    this.nextFidget = time + this.fidgetGap();

    if (held) return;

    const fidgets = FIDGETS[this.look.temperament];

    this.play(fidgets[Math.floor(Math.random() * fidgets.length)]!, time);
  }

  /** The gestures showing now: one handed over and fading, and the running one, each with its strength. */
  private layers(time: number) {
    const layers: { motion: Motion; elapsed: number; amount: number }[] = [];
    const handoff = this.previous;

    if (handoff && time - this.handedAt < HANDOFF) {
      const motion = MOTIONS[handoff.gesture];
      const elapsed = time - handoff.since;
      const fade = 1 - smooth((time - this.handedAt) / HANDOFF);

      layers.push({
        motion,
        elapsed,
        amount: envelope(motion, elapsed) * fade,
      });
    }

    const gesture = this.active(time);

    if (gesture) {
      const motion = MOTIONS[gesture];
      const elapsed = time - this.since;

      layers.push({ motion, elapsed, amount: envelope(motion, elapsed) });
    }

    return layers;
  }

  private petted(pose: Pose): Pose {
    return {
      ...pose,
      roll: pose.roll + this.lean * 10,
      scaleX: pose.scaleX * 1.02,
      scaleY: pose.scaleY * 0.97,
      lift: pose.lift * 0.5,
      blush: Math.max(pose.blush, 1),
    };
  }

  /** The pose and blended faces with the activity, gestures, and petting on top. */
  apply(pose: Pose, faces: [Expression, number][], time: number) {
    let shown = pose;
    const weights = new Map(faces);

    for (const [act, weight] of this.acting) {
      shown = lerpPose(shown, ACTS[act].pose(shown, time), weight);
      overlay(weights, ACTS[act].face, weight);
    }

    const layers = this.layers(time);

    for (const { motion, elapsed, amount } of layers)
      shown = lerpPose(shown, motion.pose(shown, elapsed, this.bounce), amount);

    shown = lerpPose(shown, this.petted(shown), this.pet);
    overlay(weights, "happy", this.pet);

    for (const { motion, amount } of layers)
      if (motion.face) overlay(weights, motion.face, faceWeight(amount));

    return { pose: shown, faces: [...weights] };
  }
}
