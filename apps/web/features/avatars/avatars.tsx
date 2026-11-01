import {
  IconArrowsShuffle,
  IconCopy,
  IconDownload,
  IconPalette,
  IconSparkles,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WorkspacePage } from "@/components/workspace";
import { type Bot, botsQuery } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  BotAvatar,
  type BotAvatarHandle,
  type BotState,
} from "@/features/bots/avatar";
import {
  type AvatarChoice,
  BotPainter,
  EXPRESSIONS,
  type Expression,
  PALETTE,
  REST,
  SILHOUETTES,
  expressionOf,
  formatAvatar,
  lookOf,
  parseAvatar,
} from "@/features/bots/bot-avatar";
import { GESTURES, type Gesture } from "@/features/bots/bot-gestures";

const STATES: BotState[] = ["idle", "working", "sleeping"];

const COLOR_NAMES = {
  "#8b5cf6": "Violet",
  "#38bdf8": "Sky",
  "#14b8a6": "Teal",
  "#22c55e": "Green",
  "#f59e0b": "Amber",
  "#f97316": "Orange",
  "#ef4444": "Red",
  "#ec4899": "Pink",
} satisfies Record<(typeof PALETTE)[number], string>;

const colorName = (hex: string) =>
  Object.entries(COLOR_NAMES).find(([each]) => each === hex)?.[1] ?? hex;

type Sample = { id: string; avatar: string };

/** A grid cell that picks one option, with a small avatar above its label. */
function Tile({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        "relative flex min-h-20 flex-col items-center gap-1.5 bg-background p-3 text-xs text-muted-foreground capitalize transition-colors outline-none hover:bg-muted focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        pressed &&
          "bg-muted font-medium text-foreground ring-1 ring-foreground/20 ring-inset",
      )}
      onClick={onClick}
    >
      {children}
      {label}
    </button>
  );
}

function Group({
  title,
  value,
  children,
}: {
  title: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2 font-mono text-xs tracking-wide text-muted-foreground uppercase">
        <span>{title}</span>
        <span className="text-foreground capitalize">{value}</span>
      </div>
      <div className="grid grid-cols-4 gap-px border-b bg-border">
        {children}
      </div>
    </div>
  );
}

const GESTURE_FACES: Record<Gesture, Expression> = {
  boop: "happy",
  giggle: "happy",
  dizzy: "dizzy",
  startle: "surprised",
  cheer: "delighted",
  yawn: "yawning",
  wiggle: "wink",
  hop: "delighted",
  lookaround: "curious",
  shy: "shy",
};

/** Still thumbnails keep attention on the gesture playing in the main preview. */
function GestureTile({
  bot,
  gesture,
  onClick,
}: {
  bot: Sample;
  gesture: Gesture;
  onClick: () => void;
}) {
  return (
    <Tile label={gesture} pressed={false} onClick={onClick}>
      <BotAvatar bot={bot} size={44} face={GESTURE_FACES[gesture]} />
    </Tile>
  );
}

function download(bot: Sample, face: Expression | undefined, name: string) {
  const canvas = document.createElement("canvas");

  canvas.width = 512;
  canvas.height = 512;
  new BotPainter(lookOf(bot), 512).paint(canvas.getContext("2d")!, REST, [
    [face ?? "calm", 1],
  ]);
  canvas.toBlob((blob) => {
    if (!blob) return;

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `${name}.png`;
    link.click();
    URL.revokeObjectURL(url);
  });
}

function ExportBar({
  bot,
  expression,
  name,
}: {
  bot: Sample;
  expression: Expression;
  name: string;
}) {
  const [copyStatus, setCopyStatus] = useState("");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(bot.avatar);
      setCopyStatus("Avatar copied");
    } catch {
      setCopyStatus("Could not copy avatar");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
      <Button onClick={() => download(bot, expression, name)}>
        <IconDownload />
        PNG
      </Button>
      <Button variant="outline" onClick={() => void copy()}>
        <IconCopy />
        Copy avatar
      </Button>
      <span role="status" className="text-xs text-muted-foreground">
        {copyStatus}
      </span>
      <span className="w-full text-xs text-muted-foreground">
        PNG exports the selected expression in a still pose.
      </span>
    </div>
  );
}

function ColorPicker({
  hex,
  onPick,
}: {
  hex: string;
  onPick: (color: string) => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-4 py-2 font-mono text-xs tracking-wide text-muted-foreground uppercase">
        <span>Color</span>
        <span className="text-foreground">{colorName(hex)}</span>
      </div>
      <div className="flex flex-wrap gap-2 border-b px-4 pb-4">
        {PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={colorName(color)}
            aria-pressed={hex === color}
            className={cn(
              "size-10 rounded-full border-4 border-background outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              hex === color &&
                "ring-2 ring-foreground ring-offset-2 ring-offset-background",
            )}
            style={{ background: color }}
            onClick={() => onPick(color)}
          />
        ))}
      </div>
    </>
  );
}

/** Your bots as tiles, to load one's look into the studio. */
function BotPicker({
  current,
  onPick,
}: {
  current: string;
  onPick: (bot: Bot) => void;
}) {
  const bots = useQuery(botsQuery).data ?? [];

  if (!bots.length) return null;

  return (
    <Group title="Your bots" value="">
      {bots.map((each) => (
        <Tile
          key={each.id}
          label={each.name}
          pressed={each.avatar === current}
          onClick={() => onPick(each)}
        >
          <BotAvatar bot={each} size={40} />
        </Tile>
      ))}
    </Group>
  );
}

/**
 * A page outside the navigation for trying bot avatars, laid out like an avatar studio: a live
 * preview to poke and pet, the look on one tab and the states and gestures on the other.
 */
export function AvatarsPage() {
  const [seed, setSeed] = useState("crumble");
  const [choice, setChoice] = useState<AvatarChoice>({});
  const [face, setFace] = useState<Expression>();
  const [state, setState] = useState<BotState>("idle");
  const [animated, setAnimated] = useState(true);
  const [playback, setPlayback] = useState<{ gesture: Gesture }>();
  const avatar = useRef<BotAvatarHandle>(null);
  const bot: Sample = { id: seed, avatar: formatAvatar(seed, choice) };
  const look = lookOf(bot);

  useEffect(() => {
    if (playback) avatar.current?.play(playback.gesture);
  }, [playback]);

  const play = (gesture: Gesture) => {
    setAnimated(true);
    setFace(undefined);
    setPlayback({ gesture });
  };

  const tileBot = (picked: AvatarChoice) => ({
    id: seed,
    avatar: formatAvatar(seed, { ...choice, ...picked }),
  });

  const name = `${colorName(look.hex)} ${look.silhouette}`;

  return (
    <WorkspacePage title="Avatars">
      <div className="grid overflow-hidden rounded-xl border lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col border-b lg:border-r lg:border-b-0">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
            <span className="truncate font-mono text-xs tracking-wide text-muted-foreground uppercase">
              {name} · {face ?? look.temperament}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSeed(crypto.randomUUID());
                setChoice({});
              }}
            >
              <IconArrowsShuffle />
              Surprise me
            </Button>
          </div>
          <div className="flex min-h-100 flex-1 flex-col items-center justify-center gap-6 px-4 py-10">
            <BotAvatar
              ref={avatar}
              bot={bot}
              size={240}
              live={animated}
              state={state}
              {...(face && { face })}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                aria-pressed={!animated}
                onClick={() => setAnimated((value) => !value)}
              >
                {animated ? "Use still preview" : "Animate preview"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => play("cheer")}>
                Celebrate
              </Button>
            </div>
            <span className="text-center text-xs text-muted-foreground">
              Click to poke, stroke side to side to pet, swipe in fast to
              startle.
              <br />
              {look.temperament}, energy {Math.round(look.energy * 100)}%
            </span>
          </div>
          <div
            className="flex items-end justify-center gap-8 border-t bg-muted/20 px-4 py-5"
            aria-label="Avatar size comparisons"
          >
            {[24, 40, 64].map((size) => (
              <div key={size} className="flex flex-col items-center gap-2">
                <BotAvatar
                  bot={bot}
                  size={size}
                  state={state}
                  {...(face && { face })}
                />
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {size}px
                </span>
              </div>
            ))}
          </div>
          <ExportBar
            bot={bot}
            expression={face ?? expressionOf(state)}
            name={name}
          />
        </div>
        <Tabs defaultValue="look" className="gap-0">
          <TabsList variant="line" className="h-10! w-full border-b px-2">
            <TabsTrigger value="look">
              <IconPalette />
              Look
            </TabsTrigger>
            <TabsTrigger value="move">
              <IconSparkles />
              Move
            </TabsTrigger>
          </TabsList>
          <TabsContent value="look">
            <Group title="Body" value={look.silhouette}>
              {SILHOUETTES.map((silhouette) => (
                <Tile
                  key={silhouette}
                  label={silhouette}
                  pressed={look.silhouette === silhouette}
                  onClick={() => setChoice({ ...choice, silhouette })}
                >
                  <BotAvatar bot={tileBot({ silhouette })} size={40} />
                </Tile>
              ))}
            </Group>
            <Group title="Face" value={face ?? "auto"}>
              <Tile
                label="auto"
                pressed={!face}
                onClick={() => setFace(undefined)}
              >
                <BotAvatar bot={bot} size={40} state={state} />
              </Tile>
              {EXPRESSIONS.map((expression) => (
                <Tile
                  key={expression}
                  label={expression}
                  pressed={face === expression}
                  onClick={() => setFace(expression)}
                >
                  <BotAvatar bot={bot} size={40} face={expression} />
                </Tile>
              ))}
            </Group>
            <ColorPicker
              hex={look.hex}
              onPick={(color) => setChoice({ ...choice, color })}
            />
            <BotPicker
              current={bot.avatar}
              onPick={(each) => {
                const parsed = parseAvatar(each);

                setSeed(parsed.seed);
                setChoice(parsed.choice);
              }}
            />
          </TabsContent>
          <TabsContent value="move">
            <Group title="State" value={state}>
              {STATES.map((each) => (
                <Tile
                  key={each}
                  label={each}
                  pressed={state === each}
                  onClick={() => setState(each)}
                >
                  <BotAvatar bot={bot} size={44} state={each} />
                </Tile>
              ))}
            </Group>
            <Group title="Gestures" value="">
              {GESTURES.map((gesture) => (
                <GestureTile
                  key={gesture}
                  bot={bot}
                  gesture={gesture}
                  onClick={() => play(gesture)}
                />
              ))}
            </Group>
          </TabsContent>
        </Tabs>
      </div>
    </WorkspacePage>
  );
}
