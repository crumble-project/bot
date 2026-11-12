import type { Context } from "@earendil-works/chord";
import { isTerminal } from "./computer-use-terminal";
import type { Usage } from "@earendil-works/pi-ai";
import type { ComputerUseArgs, StepArgs } from "./computer-use-args";
import { ACTIONS, effectOf } from "./computer-use-actions";
import { windowName, type Window } from "./computer-use-driver";
import {
  currentPage,
  pageHost,
  refOf,
  scrubText,
  type ComputerUseState,
} from "./computer-use-state";
import {
  STEP_DETAILS,
  type IntentStep,
  type IntentTarget,
  type Place,
  type ProposedAction,
  type StepDetail,
} from "./intent-check";

/** Whether an acting call may run: a refusal stops it. Waits while the owner decides. `usage` is the judge's spend. */
export type IntentGate = (
  proposal: { action: ProposedAction; page: string | undefined },
  context: Context,
) => Promise<{ refusal?: string; usage?: Usage }>;

const isTargeted = (action: string) => ACTIONS.get(action)?.targeted === true;

function refTarget(state: ComputerUseState, ref: string) {
  const found = refOf(state, ref);

  if (!found) return;

  const target: IntentTarget = {};

  if (found.role) target.role = scrubText(state, found.role);

  if (found.name) target.name = scrubText(state, found.name);

  return target;
}

function targetOf(
  state: ComputerUseState,
  args: Pick<ComputerUseArgs, "action" | "ref" | "element">,
  window: Window | undefined,
): IntentTarget | undefined {
  if (!isTargeted(args.action)) return undefined;

  if (args.ref !== undefined) return refTarget(state, args.ref);

  const snapshot = window && state.snapshots.get(window.window_id);

  return args.element === undefined || !snapshot
    ? undefined
    : state.elements.get(snapshot)?.get(args.element);
}

function stepTarget(step: StepArgs): IntentTarget | undefined {
  if (!isTargeted(step.action)) return undefined;

  if (step.role === undefined && step.name === undefined) return undefined;

  return {
    ...(step.role !== undefined && { role: step.role }),
    ...(step.name !== undefined && { name: step.name }),
  };
}

function stepOf(
  action: string,
  target: IntentTarget | undefined,
  args: Partial<Pick<ComputerUseArgs, StepDetail>>,
): IntentStep {
  const step: IntentStep = { action };

  if (target) step.target = target;

  for (const key of STEP_DETAILS) {
    const value = args[key];

    if (value !== undefined) step[key] = value;
  }

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

function placeOf(
  state: ComputerUseState,
  args: ComputerUseArgs,
  window: Window | undefined,
): Place {
  const own = ACTIONS.get(args.action)?.place?.(args);

  if (own) return own;

  if (args.ref === undefined && !isBrowser(window))
    return { page: window && windowName(window) };

  const page = currentPage(state);

  return { page, host: pageHost(page) };
}

export function proposedAction(
  state: ComputerUseState,
  args: ComputerUseArgs,
  window: Window | undefined,
): { action: ProposedAction; page: string | undefined } | undefined {
  if (effectOf(args.action) !== "act") return undefined;

  const steps = proposedSteps(state, args, window);
  const { page, host } = placeOf(state, args, window);

  const terminal = args.ref === undefined && isTerminal(window);

  return {
    action: {
      steps,
      ...(host && { host }),
      ...(terminal && { terminal }),
    },
    page,
  };
}
