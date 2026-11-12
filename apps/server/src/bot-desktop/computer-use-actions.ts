import { sleep } from "../shared/time";
import type { Context } from "@earendil-works/chord";
import type { ComputerUseResult } from "./computer-use";
import type { ComputerUseArgs } from "./computer-use-args";
import { captureWindow, elementToken } from "./computer-use-capture";
import {
  SCROLL_DEFAULTS,
  cleanHint,
  comboKeys,
  driverCall,
  listWindows,
  messageOf,
  ourNames,
  refusalOf,
  targetWindow,
  wantsForeground,
  windowLine,
  type DriverArgs,
  type DriverReply,
  type Window,
} from "./computer-use-driver";
import { launchApp, listApps } from "./computer-use-launch";
import { fillLogin } from "./computer-use-login";
import {
  REF_CALLS,
  actOnRef,
  chromiumWindow,
  openPage,
  readPage,
  type RefCallBuilder,
} from "./computer-use-page";
import {
  pageHost,
  textResult,
  type ComputerUseState,
} from "./computer-use-state";
import type { Place } from "./intent-check";
import { runSteps } from "./computer-use-steps";
import { isTerminal, readTerminal } from "./computer-use-terminal";

export type Acted = {
  reply: DriverReply;
  route: "background" | "foreground" | "page";
};

export type Invalid = { invalid: string };

type ActionCall = {
  args: ComputerUseArgs;
  base: DriverArgs;
  target: Window;
  context: Context;
};

type WindowInput = (
  state: ComputerUseState,
  call: ActionCall,
) => Acted | Invalid | Promise<Acted | Invalid>;

type Pointer = { element_token: string } | { x: number; y: number };

// Background first, then foreground: GTK apps need background accessibility actions, Chromium foreground keys.
export async function act(
  state: ComputerUseState,
  tool: string,
  args: DriverArgs,
  context: Context,
): Promise<Acted> {
  const background = (await driverCall(state, tool, args, context)).reply;

  if (!refusalOf(background) || !wantsForeground(background))
    return { reply: background, route: "background" };

  const foreground = (
    await driverCall(
      state,
      tool,
      { ...args, delivery_mode: "foreground" },
      context,
    )
  ).reply;

  return { reply: foreground, route: "foreground" };
}

export function verdict({ reply, route }: Acted) {
  const code = refusalOf(reply);
  const hint = cleanHint(reply.hint);

  const parts = [
    code ? `REFUSED (${code})` : `effect: ${reply.effect ?? "ok"}`,
    `delivery: ${route}`,
    ourNames(messageOf(reply) ?? ""),
    hint ? `hint: ${hint}` : undefined,
  ];

  return { text: parts.filter(Boolean).join(" | "), error: Boolean(code) };
}

function pair(coordinates?: number[]): [number, number] | undefined {
  const [x, y] = coordinates ?? [];

  return x === undefined || y === undefined ? undefined : [x, y];
}

function pointer(
  state: ComputerUseState,
  target: Window,
  args: ComputerUseArgs,
): Pointer | undefined {
  if (args.element !== undefined)
    return { element_token: elementToken(state, target, args.element) };

  const [x, y] = args.coordinate ?? [];

  return x === undefined || y === undefined ? undefined : { x, y };
}

async function focusWindow(
  state: ComputerUseState,
  { base, context }: ActionCall,
): Promise<Acted> {
  return {
    reply: (await driverCall(state, "bring_to_front", base, context)).reply,
    route: "foreground",
  };
}

function click(
  state: ComputerUseState,
  action: string,
  { args, base, target, context }: ActionCall,
) {
  const at = pointer(state, target, args);

  if (!at) return { invalid: `${action} needs element or coordinate` };

  return act(state, action, { ...base, ...at }, context);
}

function drag(state: ComputerUseState, { args, base, context }: ActionCall) {
  const from = pair(args.from_coordinate);
  const to = pair(args.to_coordinate);

  if (!from || !to)
    return { invalid: "drag needs from_coordinate and to_coordinate" };

  return act(
    state,
    "drag",
    { ...base, from_x: from[0], from_y: from[1], to_x: to[0], to_y: to[1] },
    context,
  );
}

function scroll(
  state: ComputerUseState,
  { args, base, target, context }: ActionCall,
) {
  return act(
    state,
    "scroll",
    {
      ...base,
      ...pointer(state, target, args),
      direction: args.direction ?? SCROLL_DEFAULTS.direction,
      amount: args.amount ?? SCROLL_DEFAULTS.amount,
    },
    context,
  );
}

function typeText(
  state: ComputerUseState,
  { args, base, target, context }: ActionCall,
) {
  if (args.text === undefined) return { invalid: "type needs text" };

  return act(
    state,
    "type_text",
    {
      ...base,
      ...(args.element !== undefined && {
        element_token: elementToken(state, target, args.element),
      }),
      text: args.text,
    },
    context,
  );
}

function pressKey(
  state: ComputerUseState,
  { args, base, context }: ActionCall,
) {
  if (!args.keys) return { invalid: "key needs keys" };

  const keys = comboKeys(args.keys);

  return keys.length > 1
    ? act(state, "hotkey", { ...base, keys }, context)
    : act(state, "press_key", { ...base, key: keys[0] ?? "" }, context);
}

function setValue(
  state: ComputerUseState,
  { args, base, target, context }: ActionCall,
) {
  if (args.element === undefined || args.value === undefined)
    return { invalid: "set_value needs element and value" };

  return act(
    state,
    "set_value",
    {
      ...base,
      element_token: elementToken(state, target, args.element),
      value: args.value,
    },
    context,
  );
}

async function perform(
  state: ComputerUseState,
  args: ComputerUseArgs,
  target: Window,
  context: Context,
): Promise<Acted | Invalid> {
  const base = { pid: target.pid, window_id: target.window_id };
  const input = ACTIONS.get(args.action)?.input;

  if (!input) return { invalid: `unknown action ${args.action}` };

  return input(state, { args, base, target, context });
}

async function actAndReport(
  state: ComputerUseState,
  args: ComputerUseArgs,
  window: Window,
  context: Context,
): Promise<ComputerUseResult> {
  const { ref } = args;

  const acted =
    ref === undefined
      ? await perform(state, args, window, context)
      : await actOnRef(
          state,
          ACTIONS.get(args.action)?.refCall,
          { ...args, ref },
          context,
        );

  if ("invalid" in acted) return textResult(acted.invalid, true);

  const { text: summary, error } = verdict(acted);

  const afterOf = async () => {
    if (!args.capture_after || error) return [];

    if (ref !== undefined)
      return (await readPage(state, {}, window, context)).content;

    return captureWindow(
      state,
      await targetWindow(state, args.window_id, context),
      "ax",
      false,
      undefined,
      context,
    );
  };

  const after = await afterOf();

  return {
    content: [{ type: "text", text: summary }, ...after],
    isError: error,
  };
}

type WindowAction = (
  state: ComputerUseState,
  args: ComputerUseArgs,
  window: Window,
  context: Context,
) => Promise<ComputerUseResult>;

type Run = (
  state: ComputerUseState,
  args: ComputerUseArgs,
  context: Context,
) => Promise<ComputerUseResult>;

const inWindow =
  (action: WindowAction): Run =>
  async (state, args, context) =>
    action(
      state,
      args,
      await targetWindow(state, args.window_id, context),
      context,
    );

const inChromium =
  (action: WindowAction): Run =>
  async (state, args, context) =>
    action(
      state,
      args,
      await chromiumWindow(state, args.window_id, context),
      context,
    );

const capture: WindowAction = async (state, args, window, context) => ({
  content: await captureWindow(
    state,
    window,
    args.mode ?? "ax",
    args.full === true,
    args.query,
    context,
  ),
  isError: false,
});

const read: Run = async (state, args, context) => {
  const window = await targetWindow(state, args.window_id, context);

  return isTerminal(window)
    ? readTerminal(state, window, context)
    : readPage(
        state,
        args,
        await chromiumWindow(state, args.window_id, context),
        context,
      );
};

const listing: Run = async (state, _args, context) =>
  textResult(
    (await listWindows(state, context)).map(windowLine).join("\n") ||
      "no windows",
  );

const pause: Run = async (_state, args) => {
  const bounded = Math.min(Math.max(args.seconds ?? 1, 0), 30);

  await sleep(bounded * 1000);

  return textResult(`waited ${bounded}s`);
};

const inPage: Run = (state, args, context) =>
  args.element !== undefined
    ? Promise.resolve(textResult("use element or ref, not both", true))
    : inChromium(actAndReport)(state, args, context);

const reportedInput = inWindow(actAndReport);

type ActionEntry = {
  /**
   * `observe`: stays allowed right after control changed hands, and no intent check runs.
   * `act`: refused as stale after a handover, and checked by the intent check.
   * `unchecked`: refused as stale after a handover, but not checked. Choosing it for a new action needs a reason here.
   */
  effect: "observe" | "act" | "unchecked";
  run?: Run;
  input?: WindowInput;
  targeted?: boolean;
  refCall?: RefCallBuilder;
  /** Where an action lands that doesn't act in a target window, so no window is pinned for it. */
  place?: (args: ComputerUseArgs) => Place;
};

export const ACTIONS = new Map<string, ActionEntry>([
  ["capture", { effect: "observe", run: inWindow(capture) }],
  [
    "click",
    {
      effect: "act",
      input: (state, call) => click(state, "click", call),
      targeted: true,
      refCall: REF_CALLS.click,
    },
  ],
  [
    "double_click",
    {
      effect: "act",
      input: (state, call) => click(state, "double_click", call),
      targeted: true,
      refCall: REF_CALLS.double_click,
    },
  ],
  [
    "right_click",
    {
      effect: "act",
      input: (state, call) => click(state, "right_click", call),
      targeted: true,
      refCall: REF_CALLS.right_click,
    },
  ],
  ["drag", { effect: "act", input: drag }],
  // Unchecked on its own; as a step of a `steps` call the whole call is judged.
  [
    "scroll",
    {
      effect: "unchecked",
      input: scroll,
      targeted: true,
      refCall: REF_CALLS.scroll,
    },
  ],
  [
    "type",
    {
      effect: "act",
      input: typeText,
      targeted: true,
      refCall: REF_CALLS.type,
    },
  ],
  ["key", { effect: "act", input: pressKey }],
  [
    "set_value",
    {
      effect: "act",
      input: setValue,
      targeted: true,
      refCall: REF_CALLS.set_value,
    },
  ],
  ["wait", { effect: "observe", run: pause }],
  ["list_windows", { effect: "observe", run: listing }],
  // Moves focus only.
  ["focus_window", { effect: "unchecked", input: focusWindow }],
  ["launch", { effect: "act", run: launchApp, place: () => ({}) }],
  ["list_apps", { effect: "observe", run: (s, _a, c) => listApps(s, c) }],
  [
    "open",
    {
      effect: "act",
      run: inChromium(openPage),
      place: ({ url }) => ({ page: url, host: pageHost(url) }),
    },
  ],
  ["read", { effect: "observe", run: read }],
  ["steps", { effect: "act", run: inWindow(runSteps) }],
  ["fill_login", { effect: "act", run: fillLogin, targeted: true }],
]);

export const ACTION_NAMES: string[] = [...ACTIONS.keys()];

export const effectOf = (action: string) => ACTIONS.get(action)?.effect;

export function dispatch(
  state: ComputerUseState,
  args: ComputerUseArgs,
  context: Context,
) {
  const action = ACTIONS.get(args.action);

  if (args.ref !== undefined && action?.refCall)
    return inPage(state, args, context);

  return (action?.run ?? reportedInput)(state, args, context);
}
