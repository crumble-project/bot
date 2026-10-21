// Ported from Hermes Agent's computer_use tool (tools/computer_use/schema.py, MIT, Nous Research). Changes, measured in
// the bot desktop spike: captures default to the accessibility tree with diff reads instead of screenshots, input
// climbs from background to foreground on its own (the bot owns its display), and there is no per-action approval.
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  StringEnum,
  Type,
  type ImageContent,
  type TextContent,
} from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { z } from "zod";

export const COMPUTER_USE_TOOL_NAME = "computer_use";

/** The part of a job's environment the tool needs. */
export type DesktopShell = Pick<
  ExecutionEnv,
  "exec" | "writeFile" | "readBinaryFile"
>;

export type ComputerUseResult = {
  content: (TextContent | ImageContent)[];
  isError: boolean;
};

const ENV_FILE = "/run/crumble-desktop.env";
const SESSION = "crumble-desktop-job";
const MAX_TREE_CHARS = 12_000;

const point = (description: string) =>
  Type.Array(Type.Integer(), { minItems: 2, maxItems: 2, description });

export const computerUseParameters = Type.Object({
  action: StringEnum(
    [
      "capture",
      "click",
      "double_click",
      "right_click",
      "drag",
      "scroll",
      "type",
      "key",
      "set_value",
      "wait",
      "list_windows",
      "focus_window",
    ],
    {
      description:
        "Which action to perform. `capture` has no side effects. Use `set_value` for text fields and select or combo boxes when the element supports it.",
    },
  ),
  mode: Type.Optional(
    StringEnum(["ax", "vision"], {
      description:
        "Capture mode. `ax` (default): accessibility tree only, as a diff after the first read. `vision`: full tree plus a screenshot.",
    }),
  ),
  full: Type.Optional(
    Type.Boolean({
      description: "capture: return the whole tree instead of a diff.",
    }),
  ),
  window_id: Type.Optional(
    Type.Integer({
      description:
        "Target window (from list_windows). Omit for the focused window.",
    }),
  ),
  element: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Element index [N] from the latest capture of the target window. Omit when unused.",
    }),
  ),
  coordinate: Type.Optional(
    point(
      "[x, y] in pixels of the latest vision screenshot. Only when no element index fits.",
    ),
  ),
  from_coordinate: Type.Optional(point("drag: source [x, y].")),
  to_coordinate: Type.Optional(point("drag: target [x, y].")),
  direction: Type.Optional(
    StringEnum(["up", "down", "left", "right"], {
      description: "scroll direction.",
    }),
  ),
  amount: Type.Optional(
    Type.Integer({ description: "scroll: wheel steps, default 3." }),
  ),
  text: Type.Optional(
    Type.String({
      description:
        "type: text typed at the focus, or into `element`. Typing appends; use set_value to replace.",
    }),
  ),
  keys: Type.Optional(
    Type.String({
      description:
        "key: a key or combo, such as 'return', 'escape', 'tab', 'ctrl+l'.",
    }),
  ),
  value: Type.Optional(
    Type.String({
      description:
        "set_value: the value, or the option label for a select or combo box.",
    }),
  ),
  seconds: Type.Optional(
    Type.Number({ description: "wait: seconds to pause, at most 30." }),
  ),
  capture_after: Type.Optional(
    Type.Boolean({
      description:
        "After the action, include a capture (diff) of the target window. Saves a round trip.",
    }),
  ),
});

export type ComputerUseArgs = {
  action: string;
  mode?: string;
  full?: boolean;
  window_id?: number;
  element?: number;
  coordinate?: number[];
  from_coordinate?: number[];
  to_coordinate?: number[];
  direction?: string;
  amount?: number;
  text?: string;
  keys?: string;
  value?: string;
  seconds?: number;
  name?: string;
  capture_after?: boolean;
};

const loose = <T extends z.ZodType>(schema: T) =>
  schema.optional().catch(undefined);

const window = z.object({
  pid: z.number(),
  window_id: z.number(),
  app_name: z.string(),
  title: z.string(),
});

type Window = z.infer<typeof window>;

// cua-driver reports refusals in several shapes; an error is a message or an object with a code.
const driverError = z.union([
  z.string().transform((message) => ({ code: undefined, message })),
  z.object({ code: loose(z.string()), message: loose(z.string()) }),
]);

/** A cua-driver tool result: the fields this tool reads, each dropped when its shape is unexpected. */
const driverReply = z.object({
  status: loose(z.string()),
  effect: loose(z.string()),
  code: loose(z.string()),
  summary: loose(z.string()),
  message: loose(z.string()),
  detail: loose(z.string()),
  hint: loose(z.string()),
  error: loose(driverError),
  refusal: loose(
    z.object({ code: loose(z.string()), message: loose(z.string()) }),
  ),
  escalation: loose(z.object({ recommended: loose(z.string()) })),
  snapshot_id: loose(z.string()),
  tree_markdown: loose(z.string()),
  tree_diff: loose(z.string()),
  degraded: loose(z.boolean()),
  degraded_reason: loose(z.string()),
  truncated: loose(z.boolean()),
  screenshot_width: loose(z.number()),
  screenshot_height: loose(z.number()),
  windows: loose(z.array(window)),
});

type DriverReply = z.infer<typeof driverReply>;

/** Arguments for a cua-driver tool. */
type DriverArgs = Record<string, string | number | boolean | string[]>;

function parseReply(output: string): DriverReply {
  try {
    const parsed = driverReply.safeParse(JSON.parse(output));

    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON: cua-driver printed an error.
  }

  return {
    error: {
      code: undefined,
      message: output.trim().slice(0, 500) || "cua-driver returned nothing",
    },
  };
}

// Chromium names container panels with U+FFFC placeholders and gives every node showContextMenu: tokens, no meaning.
const compact = (tree: string) =>
  tree.replace(/￼+/g, "").replace(/,showContextMenu|showContextMenu,?/g, "");

// cua-driver's hints sometimes name its own tools (run_steps, get_window_state); keep only advice that fits ours.
const cleanHint = (hint = "") =>
  hint
    .replace(/\s*Three single actions in a row:.*$/s, "")
    .replace(/get_window_state/g, "capture")
    .trim();

const codeOf = (reply: DriverReply) =>
  reply.code ?? reply.refusal?.code ?? reply.error?.code;

const refusalOf = (reply: DriverReply) => {
  const code = codeOf(reply);

  const refused =
    reply.status === "refused" ||
    reply.effect === "refused" ||
    reply.effect === "none" ||
    reply.error !== undefined ||
    Boolean(code?.endsWith("_unavailable"));

  return refused ? (code ?? "refused") : undefined;
};

const wantsForeground = (reply: DriverReply) =>
  Boolean(codeOf(reply)?.endsWith("_unavailable")) ||
  reply.escalation?.recommended === "foreground";

const messageOf = (reply: DriverReply) =>
  [
    reply.summary,
    reply.refusal?.message,
    reply.message,
    reply.detail,
    reply.error?.message,
  ].find(Boolean);

/** Normalizes placeholder arguments: some models (gpt-6-luna) fill every optional field with 0, "", or [0, 0]. */
function normalize(raw: ComputerUseArgs): ComputerUseArgs {
  const args = { ...raw };
  const unsetPoint = (p?: number[]) => !p || (p[0] === 0 && p[1] === 0);

  if (!args.window_id) delete args.window_id;

  // Element [0] is the window frame itself, never a useful target.
  if (!args.element) delete args.element;

  if (unsetPoint(args.coordinate)) delete args.coordinate;

  if (unsetPoint(args.from_coordinate)) delete args.from_coordinate;

  if (unsetPoint(args.to_coordinate)) delete args.to_coordinate;

  if (!args.amount) delete args.amount;

  if (!args.seconds) delete args.seconds;

  for (const key of ["keys", "name", "mode"] as const)
    if (args[key] === "") delete args[key];

  // An empty set_value clears a field.
  if (args.value === "" && args.action !== "set_value") delete args.value;

  if (args.text === "" && args.action !== "type") delete args.text;

  return args;
}

type Acted = { reply: DriverReply; route: "background" | "foreground" };

/** An action the tool refused before reaching cua-driver, such as a missing argument. */
type Invalid = { invalid: string };

type Pointer = { element_token: string } | { x: number; y: number };

export function createComputerUse(shell: DesktopShell) {
  // Latest snapshot per window: element tokens are `${snapshot}:${N}`, and the next capture diffs against it.
  const snapshots = new Map<number, string>();

  async function sh(command: string, context: Context) {
    let output = "";

    const result = await shell.exec(
      `. ${ENV_FILE}; ${command}`,
      { onOutput: (text) => (output += text) },
      context,
    );

    if (!result.ok) throw result.error;

    return output;
  }

  async function driver(
    tool: string,
    args: DriverArgs,
    context: Context,
    screenshot = false,
  ) {
    // Unique per call: a file left by another job's call can never stand in for this one's.
    const id = randomUUID();
    const argsFile = `/tmp/computer-use-${id}.json`;
    const png = `/tmp/computer-use-${id}.png`;
    const jpg = `/tmp/computer-use-${id}.jpg`;

    const written = await shell.writeFile(
      argsFile,
      JSON.stringify({ session: SESSION, ...args }),
      context,
    );

    if (!written.ok) throw written.error;

    const shot = screenshot ? ` --screenshot-out-file ${png}` : "";

    const reply = parseReply(
      await sh(
        `cua-driver call ${tool}${shot} "$(cat ${argsFile})"; rm -f ${argsFile}`,
        context,
      ),
    );

    if (!screenshot) return { reply };

    try {
      const converted = await shell.exec(
        `convert ${png} -quality 75 ${jpg}`,
        undefined,
        context,
      );

      if (!converted.ok || converted.value.exitCode !== 0) return { reply };

      const image = await shell.readBinaryFile(jpg, context);

      return {
        reply,
        image: image.ok
          ? Buffer.from(image.value).toString("base64")
          : undefined,
      };
    } finally {
      await shell.exec(`rm -f ${png} ${jpg}`, undefined, context);
    }
  }

  async function windows(context: Context) {
    const { reply } = await driver("list_windows", {}, context);

    return (reply.windows ?? []).filter((each) => each.app_name !== "Tint2");
  }

  async function target(windowId: number | undefined, context: Context) {
    const list = await windows(context);

    if (windowId !== undefined) {
      const found = list.find((each) => each.window_id === windowId);

      if (!found) throw new Error(`no window ${windowId}; call list_windows`);

      return found;
    }

    const active = Number(
      (await sh("xdotool getactivewindow 2>/dev/null", context)).trim(),
    );

    const found = list.find((each) => each.window_id === active) ?? list[0];

    if (!found) throw new Error("no windows are open");

    return found;
  }

  // Background first, then foreground: GTK apps need background accessibility actions, Chromium foreground keys.
  async function act(
    tool: string,
    args: DriverArgs,
    context: Context,
  ): Promise<Acted> {
    const background = (await driver(tool, args, context)).reply;

    if (!refusalOf(background) || !wantsForeground(background))
      return { reply: background, route: "background" };

    const foreground = (
      await driver(tool, { ...args, delivery_mode: "foreground" }, context)
    ).reply;

    return { reply: foreground, route: "foreground" };
  }

  function verdict({ reply, route }: Acted) {
    const code = refusalOf(reply);
    const hint = cleanHint(reply.hint);

    const parts = [
      code ? `REFUSED (${code})` : `effect: ${reply.effect ?? "ok"}`,
      `delivery: ${route}`,
      messageOf(reply),
      hint ? `hint: ${hint}` : undefined,
    ];

    return { text: parts.filter(Boolean).join(" | "), error: Boolean(code) };
  }

  async function capture(
    target: Window,
    mode: string,
    full: boolean,
    context: Context,
  ): Promise<(TextContent | ImageContent)[]> {
    const since =
      mode === "ax" && !full ? snapshots.get(target.window_id) : undefined;

    const vision = mode === "vision";

    const { reply, image } = await driver(
      "get_window_state",
      {
        pid: target.pid,
        window_id: target.window_id,
        include_screenshot: vision,
        ...(since && { since }),
      },
      context,
      vision,
    );

    if (refusalOf(reply))
      return [
        {
          type: "text",
          text: `capture failed: ${messageOf(reply) ?? codeOf(reply) ?? "unknown error"}`,
        },
      ];

    if (reply.snapshot_id) snapshots.set(target.window_id, reply.snapshot_id);

    const others = (await windows(context))
      .filter((each) => each.window_id !== target.window_id)
      .map((each) => `${each.window_id} ${each.app_name} "${each.title}"`);

    let tree = compact(reply.tree_diff ?? reply.tree_markdown ?? "");

    if (tree.length > MAX_TREE_CHARS)
      tree = `${tree.slice(0, MAX_TREE_CHARS)}\n[tree cut at ${MAX_TREE_CHARS} characters; scroll or capture a smaller window]`;

    const header = [
      `window ${target.window_id} ${target.app_name} "${target.title}" (snapshot ${reply.snapshot_id ?? "none"}${since ? `, changes since ${since}` : ""})`,
      others.length ? `other windows: ${others.join("; ")}` : undefined,
      reply.degraded ? `degraded: ${reply.degraded_reason ?? ""}` : undefined,
      reply.truncated
        ? "tree truncated: capture with full=true or narrow the window"
        : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    const content: (TextContent | ImageContent)[] = [
      { type: "text", text: `${header}\n${tree}` },
    ];

    if (image)
      content.push(
        {
          type: "text",
          text: `screenshot ${reply.screenshot_width ?? "?"}x${reply.screenshot_height ?? "?"}, coordinates are pixels of this image`,
        },
        { type: "image", data: image, mimeType: "image/jpeg" },
      );

    return content;
  }

  const tokenFor = (target: Window, element: number) => {
    const snapshot = snapshots.get(target.window_id);

    if (!snapshot)
      throw new Error("no capture of this window yet; capture first");

    return `${snapshot}:${element}`;
  };

  const pointer = (
    target: Window,
    args: ComputerUseArgs,
  ): Pointer | undefined => {
    if (args.element !== undefined)
      return { element_token: tokenFor(target, args.element) };

    const [x, y] = args.coordinate ?? [];

    return x === undefined || y === undefined ? undefined : { x, y };
  };

  async function perform(
    args: ComputerUseArgs,
    target: Window,
    context: Context,
  ): Promise<Acted | Invalid> {
    const base = { pid: target.pid, window_id: target.window_id };

    switch (args.action) {
      case "focus_window":
        return {
          reply: (await driver("bring_to_front", base, context)).reply,
          route: "foreground",
        };
      case "click":
      case "double_click":
      case "right_click": {
        const at = pointer(target, args);

        if (!at)
          return { invalid: `${args.action} needs element or coordinate` };

        return act(args.action, { ...base, ...at }, context);
      }

      case "drag": {
        const [fromX, fromY] = args.from_coordinate ?? [];
        const [toX, toY] = args.to_coordinate ?? [];

        if (
          fromX === undefined ||
          fromY === undefined ||
          toX === undefined ||
          toY === undefined
        )
          return { invalid: "drag needs from_coordinate and to_coordinate" };

        return act(
          "drag",
          { ...base, from_x: fromX, from_y: fromY, to_x: toX, to_y: toY },
          context,
        );
      }

      case "scroll":
        return act(
          "scroll",
          {
            ...base,
            ...pointer(target, args),
            direction: args.direction ?? "down",
            amount: args.amount ?? 3,
          },
          context,
        );
      case "type":
        if (args.text === undefined) return { invalid: "type needs text" };

        return act(
          "type_text",
          {
            ...base,
            ...(args.element !== undefined && {
              element_token: tokenFor(target, args.element),
            }),
            text: args.text,
          },
          context,
        );
      case "key": {
        if (!args.keys) return { invalid: "key needs keys" };

        const keys = args.keys
          .split("+")
          .map((key) => key.trim().toLowerCase());

        return keys.length > 1
          ? act("hotkey", { ...base, keys }, context)
          : act("press_key", { ...base, key: keys[0] ?? "" }, context);
      }

      case "set_value":
        if (args.element === undefined || args.value === undefined)
          return { invalid: "set_value needs element and value" };

        return act(
          "set_value",
          {
            ...base,
            element_token: tokenFor(target, args.element),
            value: args.value,
          },
          context,
        );
      default:
        return { invalid: `unknown action ${args.action}` };
    }
  }

  async function run(
    raw: ComputerUseArgs,
    context: Context,
  ): Promise<ComputerUseResult> {
    const args = normalize(raw);

    const text = (value: string, isError = false): ComputerUseResult => ({
      content: [{ type: "text", text: value }],
      isError,
    });

    try {
      if (args.action === "list_windows")
        return text(
          (await windows(context))
            .map((each) => `${each.window_id} ${each.app_name} "${each.title}"`)
            .join("\n") || "no windows",
        );

      if (args.action === "wait") {
        const seconds = Math.min(Math.max(args.seconds ?? 1, 0), 30);

        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

        return text(`waited ${seconds}s`);
      }

      const window = await target(args.window_id, context);

      if (args.action === "capture")
        return {
          content: await capture(
            window,
            args.mode ?? "ax",
            args.full === true,
            context,
          ),
          isError: false,
        };

      const acted = await perform(args, window, context);

      if ("invalid" in acted) return text(acted.invalid, true);

      const { text: summary, error } = verdict(acted);

      const after =
        args.capture_after && !error
          ? await capture(
              await target(args.window_id, context),
              "ax",
              false,
              context,
            )
          : [];

      return {
        content: [{ type: "text", text: summary }, ...after],
        isError: error,
      };
    } catch (error) {
      return text(
        `error: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  return { run, reset: () => snapshots.clear() };
}

/** The tool for a desktop job, over the job's environment. One instance per job conversation keeps its snapshots. */
export function computerUseTool() {
  const instances = new Map<string, ReturnType<typeof createComputerUse>>();

  return defineTool({
    name: COMPUTER_USE_TOOL_NAME,
    description:
      "Operate the bot desktop (Openbox, Chromium, other X11 apps) through its accessibility tree, mouse, and keyboard. " +
      "Workflow: action='capture' returns the focused window's accessibility tree; every actionable element is tagged [N]. " +
      "Act on elements by index (element=N), which is more reliable than coordinates. Later captures of the same window list only what changed " +
      "(+ added, ~ changed, - removed) and keep earlier [N] unless a 'reindexed' line says otherwise. Use mode='vision' for a screenshot when the " +
      "tree is missing something; coordinates are pixels of that screenshot. Each result carries a verdict: never repeat confirmed input; capture " +
      "to check an unverified one before retrying.",
    parameters: computerUseParameters,
    callers: ["model"],
    // Input already sent cannot be taken back; after a crash the job captures and decides.
    replay: "unsafe",
    execute: async (args, api, callContext) => {
      const env = api.env;

      if (!env)
        return {
          output: [
            {
              type: "text" as const,
              text: "No bot desktop is available here.",
            },
          ],
          isError: true,
        };

      const key = String(api.conversationId);
      let computer = instances.get(key);

      if (!computer) {
        computer = createComputerUse(env);
        instances.set(key, computer);
      }

      const result = await computer.run(args, callContext);

      return { output: result.content, isError: result.isError };
    },
  });
}
