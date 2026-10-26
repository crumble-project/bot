import { randomUUID } from "node:crypto";
import type {
  ComputerUseResult,
  ControlGate,
  DesktopShell,
} from "./computer-use";

/** Everything one desktop conversation's tool keeps between calls. */
export type ComputerUseState = {
  shell: DesktopShell;
  gate: ControlGate | undefined;
  // The lease's change count at this job's last call: a different one means the owner had control in between.
  lastChanges: number | undefined;
  // Latest snapshot per window: element tokens are `${snapshot}:${N}`, and the next capture diffs against it.
  snapshots: Map<number, string>;
  session: string;
};

export const newSession = () => `crumble-desktop-${randomUUID()}`;

export function computerUseState(
  shell: DesktopShell,
  gate?: ControlGate,
): ComputerUseState {
  return {
    shell,
    gate,
    lastChanges: undefined,
    snapshots: new Map(),
    session: newSession(),
  };
}

export const textResult = (
  value: string,
  isError = false,
): ComputerUseResult => ({
  content: [{ type: "text", text: value }],
  isError,
});
