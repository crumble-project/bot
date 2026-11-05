import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import { WORKSPACE_PATH } from "../../workspace-image/guest";
import { ACTION_NAMES } from "./computer-use-actions";
import { STEP_ACTION_NAMES } from "./computer-use-steps";

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
  action: StringEnum(STEP_ACTION_NAMES),
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

const point = (description: string) =>
  Type.Array(Type.Integer(), { minItems: 2, maxItems: 2, description });

export const computerUseParameters = Type.Object({
  action: StringEnum(ACTION_NAMES, {
    description:
      "Which action to perform. `capture` and `read` have no side effects. Use `set_value` for text fields and select or combo boxes when the element supports it. " +
      "`launch` starts an app, such as Files or Terminal at a folder, or any app `list_apps` names; use it instead of clicking the panel. " +
      "`open` loads a URL in Chromium's current tab and returns a read of the page; `read` returns the page's content and the elements to act on by ref; on a terminal window it returns the terminal's text, which capture can't show. " +
      "`steps` runs several accessibility actions in one call, each naming its element by role and name. " +
      "`fill_login` types a field of one of the bot's logins into a page field by ref; you never see the value.",
  }),
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
  app: Type.Optional(
    Type.String({
      description:
        "launch: Files, Terminal, or another installed app's name from list_apps.",
    }),
  ),
  path: Type.Optional(
    Type.String({
      description: `launch: an absolute folder or file to open the app on. Files and Terminal default to ${WORKSPACE_PATH}.`,
    }),
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

export type StepArgs = Static<typeof step>;

/** Arguments of a `computer_use` call. `action` is a plain string: a model can send one the schema doesn't name. */
export type ComputerUseArgs = Static<typeof computerUseParameters>;

type OptionalArg = Exclude<keyof ComputerUseArgs, "action">;

const OPTIONAL_ARGS = Object.keys(computerUseParameters.properties).filter(
  (name): name is OptionalArg => name !== "action",
);

const KEEPS_EMPTY: Partial<Record<OptionalArg, string>> = {
  value: "set_value",
  text: "type",
};

// Element [0] is the window frame itself, never a useful target.
const isPlaceholder = (value: ComputerUseArgs[OptionalArg]) =>
  value === 0 ||
  value === "" ||
  (Array.isArray(value) &&
    value.length > 0 &&
    value.every((coordinate) => coordinate === 0));

/** Normalizes placeholder arguments: some models (gpt-6-luna) fill every optional field with 0, "", or [0, 0]. */
export function normalize(raw: ComputerUseArgs): ComputerUseArgs {
  const args = { ...raw };

  for (const name of OPTIONAL_ARGS)
    if (isPlaceholder(args[name]) && KEEPS_EMPTY[name] !== args.action)
      delete args[name];

  return args;
}
