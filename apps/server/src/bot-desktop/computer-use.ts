// Ported from Hermes Agent's computer_use tool (tools/computer_use/schema.py, MIT, Nous Research). Changes, measured in
// the bot desktop spike: captures default to the accessibility tree with diff reads instead of screenshots, input
// climbs from background to foreground on its own (the bot owns its display), and there is no per-action approval.
import type { Context } from "@earendil-works/chord";
import {
  StringEnum,
  Type,
  type ImageContent,
  type TextContent,
} from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ControlState } from "./desktop-control";
import { computerUseState } from "./computer-use-state";
import { runAction } from "./computer-use-run";

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

/** The bot's turn on its desktop: resolves once the bot holds control. */
export type ControlGate = {
  untilBot(context: Context): Promise<ControlState>;
};

export function createComputerUse(shell: DesktopShell, gate?: ControlGate) {
  const state = computerUseState(shell, gate);

  return {
    run: (raw: ComputerUseArgs, context: Context) =>
      runAction(state, raw, context),
    reset: () => state.snapshots.clear(),
  };
}

/** The tool for a desktop job, over the job's environment. One instance per job conversation keeps its snapshots. */
export function computerUseTool(
  gateFor?: (conversationId: string) => ControlGate,
) {
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
        computer = createComputerUse(env, gateFor?.(key));
        instances.set(key, computer);
      }

      const result = await computer.run(args, callContext);

      return { output: result.content, isError: result.isError };
    },
  });
}
