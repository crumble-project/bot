import { errorText } from "../shared/errors";
import type { Context } from "@earendil-works/chord";
import type { ComputerUseResult } from "./computer-use";
import { ACTIONS, dispatch, effectOf } from "./computer-use-actions";
import { normalize, type ComputerUseArgs } from "./computer-use-args";
import { targetWindow, type Window } from "./computer-use-driver";
import {
  forgetScreen,
  textResult,
  type ComputerUseState,
} from "./computer-use-state";
import { restoreFilled, scrubFilled } from "./computer-use-login";
import { terminalText } from "./computer-use-terminal";
import { proposedAction, type IntentGate } from "./computer-use-intent";
import { isEnter, type ProposedAction } from "./intent-check";

const STALE =
  "Control changed hands: the owner used the bot desktop and handed it back. The screen may have changed and element numbers are stale. Capture before acting.";

async function controlTurn(
  state: ComputerUseState,
  action: string,
  context: Context,
): Promise<string | undefined> {
  if (!state.gate) return undefined;

  const lease = await state.gate.untilBot(context);

  const changed =
    state.lastChanges !== undefined && lease.changes !== state.lastChanges;

  state.lastChanges = lease.changes;

  if (!changed) return undefined;

  forgetScreen(state);

  return effectOf(action) === "observe" ? undefined : STALE;
}

/**
 * The call with its window pinned, so the intent check and the action see the same one; a ref acts in the page of the
 * latest read instead, an action with a place acts outside any window, and observing calls aren't checked.
 */
async function pinned(
  state: ComputerUseState,
  args: ComputerUseArgs,
  context: Context,
): Promise<{ args: ComputerUseArgs; window: Window | undefined }> {
  if (
    effectOf(args.action) !== "act" ||
    args.ref !== undefined ||
    ACTIONS.get(args.action)?.place
  )
    return { args, window: undefined };

  const window = await targetWindow(state, args.window_id, context);

  return { args: { ...args, window_id: window.window_id }, window };
}

async function withCommand<T extends { action: ProposedAction }>(
  state: ComputerUseState,
  proposal: T,
  window: Window | undefined,
  context: Context,
): Promise<T> {
  const { steps, terminal } = proposal.action;
  const enter = steps.findIndex(isEnter);

  if (!terminal || !window || enter < 0) return proposal;

  const line = await terminalText(state, window, context).then(
    (text) => text.split("\n").at(-1) ?? "",
    () => {},
  );

  if (line === undefined) return proposal;

  const typed = steps
    .slice(0, enter)
    .flatMap((step) => (step.action === "type" && step.text ? [step.text] : []))
    .join("");

  return { ...proposal, action: { ...proposal.action, command: line + typed } };
}

/**
 * Asks the intent check about an acting call; a refusal is the call's result. The owner may take control while an
 * action is held, so an approved one runs only if the bot still holds the desktop it was checked on.
 */
async function intentVerdict(
  state: ComputerUseState,
  args: ComputerUseArgs,
  window: Window | undefined,
  intent: IntentGate,
  context: Context,
) {
  const proposal = proposedAction(state, args, window);

  if (!proposal) return {};

  const { refusal, usage } = await intent(
    await withCommand(state, proposal, window, context),
    context,
  );

  return {
    refusal: refusal ?? (await controlTurn(state, args.action, context)),
    usage,
  };
}

async function checkedDispatch(
  state: ComputerUseState,
  normalized: ComputerUseArgs,
  intent: IntentGate | undefined,
  context: Context,
): Promise<ComputerUseResult> {
  if (!intent) return dispatch(state, normalized, context);

  const { args, window } = await pinned(state, normalized, context);

  const { refusal, usage } = await intentVerdict(
    state,
    args,
    window,
    intent,
    context,
  );

  const result = refusal
    ? textResult(refusal, true)
    : await dispatch(state, args, context);

  return usage ? { ...result, usage } : result;
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
    return textResult(`error: ${errorText(error)}`, true);
  }
}
