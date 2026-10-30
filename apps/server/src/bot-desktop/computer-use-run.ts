import type { Context } from "@earendil-works/chord";
import type { ComputerUseArgs, ComputerUseResult } from "./computer-use";
import { perform, verdict } from "./computer-use-actions";
import { captureWindow } from "./computer-use-capture";
import { listWindows, targetWindow, type Window } from "./computer-use-driver";
import {
  actOnRef,
  chromiumWindow,
  openPage,
  readPage,
  REF_ACTIONS,
} from "./computer-use-page";
import { textResult, type ComputerUseState } from "./computer-use-state";
import { runSteps } from "./computer-use-steps";
import { fillLogin, restoreFilled, scrubFilled } from "./computer-use-login";
import { proposedAction, type IntentGate } from "./computer-use-intent";
import { ACTING_ACTIONS } from "./intent-check";

// Actions that only look; they stay allowed right after control changed hands.
const OBSERVE = new Set(["capture", "list_windows", "wait", "read"]);

const STALE =
  "Control changed hands: the owner used the bot desktop and handed it back. The screen may have changed and element numbers are stale. Capture before acting.";

/** Normalizes placeholder arguments: some models (gpt-6-luna) fill every optional field with 0, "", or [0, 0]. */
const unsetPoint = (p?: number[]) => !p || (p[0] === 0 && p[1] === 0);

// Element [0] is the window frame itself, never a useful target.
const ZERO_UNSET = ["window_id", "element", "amount", "seconds"] as const;

const POINTS = ["coordinate", "from_coordinate", "to_coordinate"] as const;

const EMPTY_UNSET = [
  "keys",
  "name",
  "mode",
  "query",
  "url",
  "ref",
  "login",
  "field",
] as const;

/** Empty text means unset, except for the action that takes it: an empty set_value clears a field. */
function dropEmptyText(args: ComputerUseArgs) {
  if (args.value === "" && args.action !== "set_value") delete args.value;

  if (args.text === "" && args.action !== "type") delete args.text;
}

export function normalize(raw: ComputerUseArgs): ComputerUseArgs {
  const args = { ...raw };

  for (const key of ZERO_UNSET) if (!args[key]) delete args[key];

  for (const key of POINTS) if (unsetPoint(args[key])) delete args[key];

  for (const key of EMPTY_UNSET) if (args[key] === "") delete args[key];

  dropEmptyText(args);

  return args;
}

/** Waits for the bot's turn; returns the refusal for a plan made before a handover. */
async function controlTurn(
  state: ComputerUseState,
  action: string,
  context: Context,
): Promise<string | undefined> {
  if (!state.gate) return undefined;

  // A paused job waits here, without a time limit, while the owner has control.
  const lease = await state.gate.untilBot(context);

  const changed =
    state.lastChanges !== undefined && lease.changes !== state.lastChanges;

  state.lastChanges = lease.changes;

  if (!changed) return undefined;

  state.snapshots.clear();
  state.lastRead = undefined;

  return OBSERVE.has(action) ? undefined : STALE;
}

async function listing(state: ComputerUseState, context: Context) {
  const lines = (await listWindows(state, context)).map(
    (each) => `${each.window_id} ${each.app_name} "${each.title}"`,
  );

  return lines.join("\n") || "no windows";
}

async function pause(seconds?: number) {
  const bounded = Math.min(Math.max(seconds ?? 1, 0), 30);

  await new Promise((resolve) => setTimeout(resolve, bounded * 1000));

  return bounded;
}

/** Runs one action, then reports its verdict and, on request, a fresh capture, or a read for a page ref. */
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
      : await actOnRef(state, { ...args, ref }, context);

  if ("invalid" in acted) return textResult(acted.invalid, true);

  const { text: summary, error } = verdict(acted);

  const after =
    !args.capture_after || error
      ? []
      : ref === undefined
        ? await captureWindow(
            state,
            await targetWindow(state, args.window_id, context),
            "ax",
            false,
            undefined,
            context,
          )
        : (await readPage(state, {}, window, context)).content;

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

// Page actions act on Chromium even when another window has focus.
const PAGE_ACTIONS = new Map<string, WindowAction>([
  ["open", openPage],
  ["read", readPage],
]);

const WINDOW_ACTIONS = new Map<string, WindowAction>([
  ["steps", runSteps],
  ["capture", capture],
]);

async function refAction(
  state: ComputerUseState,
  args: ComputerUseArgs,
  context: Context,
) {
  if (args.element !== undefined)
    return textResult("use element or ref, not both", true);

  return actAndReport(
    state,
    args,
    await chromiumWindow(state, args.window_id, context),
    context,
  );
}

async function dispatch(
  state: ComputerUseState,
  args: ComputerUseArgs,
  context: Context,
): Promise<ComputerUseResult> {
  if (args.action === "list_windows")
    return textResult(await listing(state, context));

  if (args.action === "wait")
    return textResult(`waited ${await pause(args.seconds)}s`);

  if (args.action === "fill_login") return fillLogin(state, args, context);

  if (args.ref !== undefined && REF_ACTIONS.has(args.action))
    return refAction(state, args, context);

  const page = PAGE_ACTIONS.get(args.action);

  if (page)
    return page(
      state,
      args,
      await chromiumWindow(state, args.window_id, context),
      context,
    );

  const window = await targetWindow(state, args.window_id, context);

  return (WINDOW_ACTIONS.get(args.action) ?? actAndReport)(
    state,
    args,
    window,
    context,
  );
}

/**
 * The call with its window pinned, so the intent check and the action see the same one; a ref acts in the page of the
 * latest read instead, and observing calls aren't checked.
 */
async function pinned(
  state: ComputerUseState,
  args: ComputerUseArgs,
  context: Context,
): Promise<{ args: ComputerUseArgs; window: Window | undefined }> {
  if (!ACTING_ACTIONS.has(args.action) || args.ref !== undefined)
    return { args, window: undefined };

  const window = await targetWindow(state, args.window_id, context);

  return { args: { ...args, window_id: window.window_id }, window };
}

/**
 * Asks the intent check about an acting call; its refusal is the call's result. The owner may take control while an
 * action is held, so an approved one runs only if the bot still holds the desktop it was checked on.
 */
async function intentRefusal(
  state: ComputerUseState,
  args: ComputerUseArgs,
  window: Window | undefined,
  intent: IntentGate,
  context: Context,
) {
  const proposal = proposedAction(state, args, window);

  if (!proposal) return undefined;

  return (
    (await intent(proposal, context)) ??
    (await controlTurn(state, args.action, context))
  );
}

/** Runs the call, after the intent check when there is one. */
async function checkedDispatch(
  state: ComputerUseState,
  normalized: ComputerUseArgs,
  intent: IntentGate | undefined,
  context: Context,
) {
  if (!intent) return dispatch(state, normalized, context);

  const { args, window } = await pinned(state, normalized, context);
  const refused = await intentRefusal(state, args, window, intent, context);

  return refused ? textResult(refused, true) : dispatch(state, args, context);
}

export async function runAction(
  state: ComputerUseState,
  raw: ComputerUseArgs,
  context: Context,
  intent?: IntentGate,
): Promise<ComputerUseResult> {
  const stale = await controlTurn(state, raw.action, context);

  if (stale) return textResult(stale, true);

  try {
    await restoreFilled(state);

    return scrubFilled(
      state,
      await checkedDispatch(state, normalize(raw), intent, context),
    );
  } catch (error) {
    return textResult(
      `error: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}
