import type { Context } from "@earendil-works/chord";
import type { ComputerUseArgs, ComputerUseResult } from "./computer-use";
import { perform, verdict } from "./computer-use-actions";
import { captureWindow } from "./computer-use-capture";
import { listWindows, targetWindow, type Window } from "./computer-use-driver";
import { textResult, type ComputerUseState } from "./computer-use-state";

// Actions that only look; they stay allowed right after control changed hands.
const OBSERVE = new Set(["capture", "list_windows", "wait"]);

const STALE =
  "Control changed hands: the owner used the bot desktop and handed it back. The screen may have changed and element numbers are stale. Capture before acting.";

/** Normalizes placeholder arguments: some models (gpt-6-luna) fill every optional field with 0, "", or [0, 0]. */
export function normalize(raw: ComputerUseArgs): ComputerUseArgs {
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

/** Runs one action, then reports its verdict and, on request, a fresh capture. */
async function actAndReport(
  state: ComputerUseState,
  args: ComputerUseArgs,
  window: Window,
  context: Context,
): Promise<ComputerUseResult> {
  const acted = await perform(state, args, window, context);

  if ("invalid" in acted) return textResult(acted.invalid, true);

  const { text: summary, error } = verdict(acted);

  const after =
    args.capture_after && !error
      ? await captureWindow(
          state,
          await targetWindow(state, args.window_id, context),
          "ax",
          false,
          context,
        )
      : [];

  return {
    content: [{ type: "text", text: summary }, ...after],
    isError: error,
  };
}

export async function runAction(
  state: ComputerUseState,
  raw: ComputerUseArgs,
  context: Context,
): Promise<ComputerUseResult> {
  const stale = await controlTurn(state, raw.action, context);

  if (stale) return textResult(stale, true);

  const args = normalize(raw);

  try {
    if (args.action === "list_windows")
      return textResult(await listing(state, context));

    if (args.action === "wait")
      return textResult(`waited ${await pause(args.seconds)}s`);

    const window = await targetWindow(state, args.window_id, context);

    if (args.action === "capture")
      return {
        content: await captureWindow(
          state,
          window,
          args.mode ?? "ax",
          args.full === true,
          context,
        ),
        isError: false,
      };

    return await actAndReport(state, args, window, context);
  } catch (error) {
    return textResult(
      `error: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}
