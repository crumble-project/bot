// Ported from Hermes Agent's computer_use tool (tools/computer_use/schema.py, MIT, Nous Research). Changes, measured in
// the bot desktop spike: captures default to the accessibility tree with diff reads instead of screenshots, input
// climbs from background to foreground on its own (the bot owns its display), and only actions an intent check holds
// wait for approval.
import type { Context } from "@earendil-works/chord";
import {
  StringEnum,
  Type,
  type Static,
  type ImageContent,
  type TextContent,
} from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ControlState } from "./desktop-control";
import type { DesktopFills, LoginFill } from "./computer-use-login";
import {
  computerUseState,
  type ComputerUseOptions,
} from "./computer-use-state";
import { runAction } from "./computer-use-run";
import type { IntentGate } from "./computer-use-intent";

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

const check = Type.Object({
  role: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  text: Type.Optional(
    Type.String({ description: "Any row of the tree, static text included." }),
  ),
  gone: Type.Optional(
    Type.Boolean({ description: "Wait for it to disappear instead." }),
  ),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
});

const step = Type.Object({
  action: StringEnum([
    "click",
    "double_click",
    "right_click",
    "set_value",
    "type",
    "key",
    "scroll",
  ]),
  role: Type.Optional(
    Type.String({
      description:
        "The element's role as captures show it, such as 'button', 'entry', 'check box'.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: "The element's label; an exact match wins over a substring.",
    }),
  ),
  nth: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "0-based, when several elements match.",
    }),
  ),
  text: Type.Optional(Type.String()),
  keys: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  direction: Type.Optional(StringEnum(["up", "down", "left", "right"])),
  amount: Type.Optional(Type.Integer()),
  wait_for: Type.Optional(check),
  expect: Type.Optional(Type.Array(check, { maxItems: 4 })),
});

export type StepArgs = Static<typeof step>;

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
      "open",
      "read",
      "steps",
      "fill_login",
    ],
    {
      description:
        "Which action to perform. `capture` and `read` have no side effects. Use `set_value` for text fields and select or combo boxes when the element supports it. " +
        "`open` loads a URL in Chromium's current tab and returns a read of the page; `read` returns the page's content and the elements to act on by ref. " +
        "`steps` runs several accessibility actions in one call, each naming its element by role and name. " +
        "`fill_login` types a field of one of the bot's logins into a page field by ref; you never see the value.",
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
  query: Type.Optional(
    Type.String({
      description:
        "capture and read: only elements whose role, name, or visible text matches, such as 'Born' or 'Sign in'. Use it on large pages instead of reading everything.",
    }),
  ),
  url: Type.Optional(
    Type.String({ description: "open: the http, https, or about: URL." }),
  ),
  ref: Type.Optional(
    Type.String({
      description:
        "A page element ref like p5:0 from the latest read. click, double_click, right_click, scroll, type, and set_value act on it in the page instead of on an element; read with a ref reads only that part of the page.",
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
  login: Type.Optional(
    Type.String({ description: "fill_login: the login's name." }),
  ),
  field: Type.Optional(
    StringEnum(["username", "password", "one_time_code"], {
      description: "fill_login: which field of the login to type.",
    }),
  ),
  steps: Type.Optional(
    Type.Array(step, {
      minItems: 1,
      maxItems: 20,
      description:
        "steps: actions run in order in the target window, stopping at the first failure; then what changed in the window (narrowed by query). wait_for is checked before a step, expect after it.",
    }),
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
  query?: string;
  url?: string;
  ref?: string;
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
  steps?: StepArgs[];
  login?: string;
  field?: string;
};

/** The bot's turn on its desktop: resolves once the bot holds control. */
export type ControlGate = {
  untilBot(context: Context): Promise<ControlState>;
};

export function createComputerUse(
  shell: DesktopShell,
  options: ComputerUseOptions = {},
) {
  const state = computerUseState(shell, options);

  return {
    run: (raw: ComputerUseArgs, context: Context, intent?: IntentGate) =>
      runAction(state, raw, context, intent),
    reset: () => {
      state.snapshots.clear();
      state.lastRead = undefined;
    },
  };
}

/** The tool for a desktop job, over the job's environment. One instance per job conversation keeps its snapshots. */
export function computerUseTool({
  gateFor,
  logins,
  fills,
  intentFor,
}: {
  gateFor?: ((conversationId: string) => ControlGate) | undefined;
  logins?: LoginFill | undefined;
  fills?: DesktopFills | undefined;
  /** The intent check of one call, which reads the job's request and posts a held action's card. */
  intentFor?: ((api: ToolExecutionApi) => IntentGate) | undefined;
} = {}) {
  const instances = new Map<string, ReturnType<typeof createComputerUse>>();

  return defineTool({
    name: COMPUTER_USE_TOOL_NAME,
    description:
      "Operate the bot desktop (Openbox, Chromium, other X11 apps) through its accessibility tree, mouse, and keyboard. " +
      "Workflow: action='capture' returns the focused window's accessibility tree; every actionable element is tagged [N]. " +
      "Act on elements by index (element=N), which is more reliable than coordinates. Later captures of the same window list only what changed " +
      "(+ added, ~ changed, - removed) and keep earlier [N] unless a 'reindexed' line says otherwise. Use mode='vision' for a screenshot when the " +
      "tree is missing something; coordinates are pixels of that screenshot. Narrow a large capture with query. " +
      "Web pages in Chromium: action='open' loads a URL and action='read' returns the page with its elements tagged [pN:M]; act on them with ref " +
      "instead of element. Refs last until the page navigates or is read again. " +
      "When you know several steps ahead, action='steps' runs them in one call, naming each element by role and name, with expect checks. " +
      "Each result carries a verdict: never repeat confirmed input; capture or read to check an unverified one before retrying.",
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
        computer = createComputerUse(env, {
          gate: gateFor?.(key),
          logins,
          fills,
        });
        instances.set(key, computer);
      }

      const result = await computer.run(args, callContext, intentFor?.(api));

      return { output: result.content, isError: result.isError };
    },
  });
}
