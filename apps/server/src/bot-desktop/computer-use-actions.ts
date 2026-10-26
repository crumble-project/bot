import type { Context } from "@earendil-works/chord";
import type { ComputerUseArgs } from "./computer-use";
import { elementToken } from "./computer-use-capture";
import {
  cleanHint,
  driverCall,
  messageOf,
  refusalOf,
  wantsForeground,
  type DriverArgs,
  type DriverReply,
  type Window,
} from "./computer-use-driver";
import type { ComputerUseState } from "./computer-use-state";

export type Acted = { reply: DriverReply; route: "background" | "foreground" };

/** An action the tool refused before reaching cua-driver, such as a missing argument. */
export type Invalid = { invalid: string };

/** One action's arguments and the window it acts on. */
type ActionCall = {
  args: ComputerUseArgs;
  base: DriverArgs;
  target: Window;
  context: Context;
};

type Action = (
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
    messageOf(reply),
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
      direction: args.direction ?? "down",
      amount: args.amount ?? 3,
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

  const keys = args.keys.split("+").map((key) => key.trim().toLowerCase());

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

const ACTIONS = new Map<string, Action>([
  ["focus_window", focusWindow],
  ["click", (state, call) => click(state, "click", call)],
  ["double_click", (state, call) => click(state, "double_click", call)],
  ["right_click", (state, call) => click(state, "right_click", call)],
  ["drag", drag],
  ["scroll", scroll],
  ["type", typeText],
  ["key", pressKey],
  ["set_value", setValue],
]);

export async function perform(
  state: ComputerUseState,
  args: ComputerUseArgs,
  target: Window,
  context: Context,
): Promise<Acted | Invalid> {
  const base = { pid: target.pid, window_id: target.window_id };
  const action = ACTIONS.get(args.action);

  if (!action) return { invalid: `unknown action ${args.action}` };

  return action(state, { args, base, target, context });
}
