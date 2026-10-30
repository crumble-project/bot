import type { Context } from "@earendil-works/chord";
import type { Usage } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ComputerUseArgs, StepArgs } from "./computer-use";
import type { DriverReply, Window } from "./computer-use-driver";
import type { ComputerUseState } from "./computer-use-state";
import {
  ACTING_ACTIONS,
  type IntentStep,
  type IntentTarget,
  type ProposedAction,
} from "./intent-check";

/** Whether an acting call may run: a refusal stops it. Waits while the owner decides. `usage` is the judge's spend. */
export type IntentGate = (
  proposal: { action: ProposedAction; page: string | undefined },
  context: Context,
) => Promise<{ refusal?: string; usage?: Usage }>;

// `- [3] push button "Pay now" [actions=...]` in a full tree; a diff marks lines `+`, `~`, or `-` (removed). The role
// runs up to the name's quote or the first `[`, so it keeps every word.
const ELEMENT_LINE =
  /^\s*([-+~])?\s*\[(\d+)\]\s+([^"[\n]*)(?:"((?:[^"\\]|\\.)*)")?/;

const unquote = (name: string) => {
  try {
    return z
      .string()
      .catch(name)
      .parse(JSON.parse(`"${name}"`));
  } catch {
    return name;
  }
};

const treeOf = (reply: DriverReply) =>
  reply.tree_diff ?? reply.tree_markdown ?? "";

type ElementLine = { index: number; removed: boolean; target: IntentTarget };

function elementLine(line: string, diff: boolean): ElementLine | undefined {
  const match = ELEMENT_LINE.exec(line);

  if (!match) return undefined;

  const [, mark, index, role = "", name] = match;
  const target: IntentTarget = {};

  if (role.trim()) target.role = role.trim();

  if (name !== undefined) target.name = unquote(name);

  // Only a diff marks removals; a full tree's `-` is a list bullet.
  return { index: Number(index), removed: diff && mark === "-", target };
}

/**
 * Keeps the role and name of each element a capture shows under its snapshot, so an action by index can name its
 * target. Call before the snapshot becomes the window's latest: a diff applies to the one before it.
 */
export function recordElements(
  state: ComputerUseState,
  windowId: number,
  snapshot: string,
  reply: DriverReply,
) {
  const diff = reply.tree_diff !== undefined;
  const previous = state.snapshots.get(windowId);
  const known = new Map(diff ? state.elements.get(previous ?? "") : undefined);

  for (const line of treeOf(reply).split("\n")) {
    const element = elementLine(line, diff);

    if (element?.removed) known.delete(element.index);
    else if (element) known.set(element.index, element.target);
  }

  if (previous) state.elements.delete(previous);
  state.elements.set(snapshot, known);
}

function hostOf(url: string | undefined) {
  if (!url) return undefined;

  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

// Steps and actions that act on the element they name; a key press goes to the focus whatever else the call says.
const TARGETED = new Set([
  "click",
  "double_click",
  "right_click",
  "set_value",
  "type",
  "scroll",
]);

function refTarget(state: ComputerUseState, ref: string) {
  const found = state.lastRead?.read.refs.find((each) => each.ref === ref);

  if (!found) return undefined;

  const target: IntentTarget = {};

  if (found.role) target.role = found.role;

  if (found.name) target.name = found.name;

  return target;
}

/** The element the call acts on, in the window it runs in; undefined when it acts on the focus or a point. */
function targetOf(
  state: ComputerUseState,
  args: Pick<ComputerUseArgs, "action" | "ref" | "element">,
  window: Window | undefined,
): IntentTarget | undefined {
  if (!TARGETED.has(args.action)) return undefined;

  if (args.ref !== undefined) return refTarget(state, args.ref);

  const snapshot = window && state.snapshots.get(window.window_id);

  return args.element === undefined || !snapshot
    ? undefined
    : state.elements.get(snapshot)?.get(args.element);
}

function stepTarget(step: StepArgs): IntentTarget | undefined {
  if (!TARGETED.has(step.action)) return undefined;

  if (step.role === undefined && step.name === undefined) return undefined;

  return {
    ...(step.role !== undefined && { role: step.role }),
    ...(step.name !== undefined && { name: step.name }),
  };
}

function stepOf(
  action: string,
  target: IntentTarget | undefined,
  args: Pick<ComputerUseArgs, "text" | "keys" | "value">,
): IntentStep {
  const step: IntentStep = { action };

  if (target) step.target = target;

  if (args.text !== undefined) step.text = args.text;

  if (args.keys !== undefined) step.keys = args.keys;

  if (args.value !== undefined) step.value = args.value;

  return step;
}

const isBrowser = (window: Window | undefined) =>
  window !== undefined && /chrom/i.test(window.app_name);

const proposedSteps = (
  state: ComputerUseState,
  args: ComputerUseArgs,
  window: Window | undefined,
) =>
  args.action === "steps"
    ? (args.steps ?? []).map((step) =>
        stepOf(step.action, stepTarget(step), step),
      )
    : [stepOf(args.action, targetOf(state, args, window), args)];

/** Where the call acts: the page of the latest read in the browser, else the window's app and title. */
function placeOf(
  state: ComputerUseState,
  args: ComputerUseArgs,
  window: Window | undefined,
) {
  if (args.ref === undefined && !isBrowser(window))
    return { page: window && `${window.app_name} "${window.title}"` };

  const page = state.lastRead?.read.page?.url ?? state.lastRead?.page.url;

  return { page, host: hostOf(page) };
}

/**
 * The action an acting call proposes, for the intent check; undefined for observing calls. `window` is the window the
 * call runs in, resolved once so the check and the action see the same one; a ref acts in the page of the latest read.
 */
export function proposedAction(
  state: ComputerUseState,
  args: ComputerUseArgs,
  window: Window | undefined,
): { action: ProposedAction; page: string | undefined } | undefined {
  if (!ACTING_ACTIONS.has(args.action)) return undefined;

  const steps = proposedSteps(state, args, window);
  const { page, host } = placeOf(state, args, window);

  return { action: host ? { steps, host } : { steps }, page };
}
