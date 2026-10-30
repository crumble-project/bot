import type { Context } from "@earendil-works/chord";
import { z } from "zod";
import type {
  ComputerUseArgs,
  ComputerUseResult,
  StepArgs,
} from "./computer-use";
import type { Invalid } from "./computer-use-actions";
import { windowText } from "./computer-use-capture";
import {
  driverCall,
  driverReply,
  messageOf,
  ourNames,
  refusalOf,
  type DriverArgs,
  type Window,
} from "./computer-use-driver";
import { textResult, type ComputerUseState } from "./computer-use-state";

const loose = <T extends z.ZodType>(schema: T) =>
  schema.optional().catch(undefined);

/** A `run_steps` result: the fields this tool reads, each dropped when its shape is unexpected. */
const stepsReply = z.object({
  steps: z
    .array(
      z.object({
        index: z.number(),
        tool: loose(z.string()),
        ok: loose(z.boolean()),
        code: loose(z.string()),
        phase: loose(z.string()),
        message: loose(z.string()),
        target: loose(z.object({ element: loose(z.string()) })),
      }),
    )
    .catch([]),
  failed_step: z.number().nullish().catch(undefined),
  total: loose(z.number()),
  observation: loose(z.object({ state: loose(driverReply) })),
});

const targetOf = ({ role, name, nth }: StepArgs) => ({
  ...(role !== undefined && { role }),
  ...(name !== undefined && { name }),
  ...(nth !== undefined && { nth }),
});

type Built = { step: DriverArgs } | Invalid;

type StepBuilder = (step: StepArgs, target: DriverArgs) => Built;

const named = (step: StepArgs) =>
  step.role !== undefined || step.name !== undefined;

const pointer =
  (tool: "click" | "double_click" | "right_click"): StepBuilder =>
  (step, target) =>
    named(step)
      ? { step: { [tool]: target } }
      : { invalid: `${tool} needs role or name` };

const keyStep = (keys: string): DriverArgs => {
  const pressed = keys.split("+").map((key) => key.trim().toLowerCase());

  return pressed.length > 1
    ? { hotkey: { keys: pressed } }
    : { press_key: { key: pressed[0] ?? "" } };
};

const BUILDERS = new Map<string, StepBuilder>([
  ["click", pointer("click")],
  ["double_click", pointer("double_click")],
  ["right_click", pointer("right_click")],
  [
    "set_value",
    (step, target) =>
      named(step) && step.value !== undefined
        ? { step: { set_value: { ...target, value: step.value } } }
        : { invalid: "set_value needs role or name, and value" },
  ],
  [
    "type",
    (step, target) =>
      step.text === undefined
        ? { invalid: "type needs text" }
        : { step: { type_text: { ...target, text: step.text } } },
  ],
  [
    "key",
    (step) =>
      step.keys ? { step: keyStep(step.keys) } : { invalid: "key needs keys" },
  ],
  [
    "scroll",
    (step, target) => ({
      step: {
        scroll: {
          ...target,
          direction: step.direction ?? "down",
          amount: step.amount ?? 3,
        },
      },
    }),
  ],
]);

/** One step in `run_steps` form, with its checks, or why it can't run. */
function stepCall(step: StepArgs): Built {
  const build = BUILDERS.get(step.action);

  if (!build) return { invalid: `unknown step action ${step.action}` };

  const built = build(step, targetOf(step));

  if ("invalid" in built) return built;

  return {
    step: {
      ...built.step,
      ...(step.wait_for && { wait_for: step.wait_for }),
      ...(step.expect && { expect: step.expect }),
    },
  };
}

/** Every step in `run_steps` form, or the first one that can't run. */
function stepCalls(steps: StepArgs[]): { steps: DriverArgs[] } | Invalid {
  const calls: DriverArgs[] = [];

  for (const [index, step] of steps.entries()) {
    const call = stepCall(step);

    if ("invalid" in call)
      return { invalid: `step ${index + 1}: ${call.invalid}` };

    calls.push(call.step);
  }

  return { steps: calls };
}

type StepsReply = z.infer<typeof stepsReply>;

const stepLine = (step: StepsReply["steps"][number]) => {
  const what = [step.tool, step.target?.element].filter(Boolean).join(" ");

  if (step.ok) return `${step.index + 1} ${what}: ok`;

  const why = [step.code, step.phase].filter(Boolean).join(", ");

  return `${step.index + 1} ${what}: failed (${why}) ${ourNames(step.message ?? "")}`.trim();
};

const stoppedLine = (failed: number, total: number) =>
  `stopped at step ${failed + 1} of ${total}; ${failed ? `steps 1-${failed} ran` : "no step ran"}`;

/** What changed in the window after the batch; the observed read becomes the window's latest. */
function observedText(
  state: ComputerUseState,
  result: StepsReply,
  query: string | undefined,
  target: Window,
) {
  const observed = result.observation?.state;

  if (!observed?.snapshot_id) return [];

  const since = observed.since_status === "diff" ? observed.since : undefined;

  return [windowText(state, target, observed, since, query, [])];
}

/** What the batch did, step by step, then what changed in the window. */
function report(
  state: ComputerUseState,
  result: StepsReply,
  args: ComputerUseArgs,
  target: Window,
): ComputerUseResult {
  const failed = result.failed_step ?? undefined;

  const stopped =
    failed === undefined
      ? []
      : [stoppedLine(failed, result.total ?? result.steps.length)];

  const lines = [
    ...result.steps.map(stepLine),
    ...stopped,
    ...observedText(state, result, args.query, target),
  ];

  return textResult(lines.join("\n"), failed !== undefined);
}

/** Runs known steps in one `run_steps` call, then reports each step and what changed in the window. */
export async function runSteps(
  state: ComputerUseState,
  args: ComputerUseArgs,
  target: Window,
  context: Context,
): Promise<ComputerUseResult> {
  const calls = stepCalls(args.steps ?? []);

  if ("invalid" in calls) return textResult(calls.invalid, true);

  if (!calls.steps.length) return textResult("steps needs steps", true);

  const { reply } = await driverCall(
    state,
    "run_steps",
    {
      pid: target.pid,
      window_id: target.window_id,
      foreground_fallback: true,
      steps: calls.steps,
      observe: args.query ? { query: args.query } : {},
    },
    context,
  );

  const result = stepsReply.parse(reply);

  if (!result.steps.length && refusalOf(reply))
    return textResult(
      `REFUSED: ${ourNames(messageOf(reply) ?? "steps failed")}`,
      true,
    );

  return report(state, result, args, target);
}
