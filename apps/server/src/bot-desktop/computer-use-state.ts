import type {
  ComputerUseResult,
  ControlGate,
  DesktopShell,
} from "./computer-use";
import type { PageBinding, SemanticSnapshot } from "./computer-use-page";

/** How `open` waits for a page: every `pollMs`, for at most `timeoutMs`. */
export type PageLoad = { pollMs: number; timeoutMs: number };

const PAGE_LOAD: PageLoad = { pollMs: 250, timeoutMs: 10_000 };

/** Everything one desktop conversation's tool keeps between calls. */
export type ComputerUseState = {
  shell: DesktopShell;
  gate: ControlGate | undefined;
  // The lease's change count at this job's last call: a different one means the owner had control in between.
  lastChanges: number | undefined;
  // Latest snapshot per window: element tokens are `${snapshot}:${N}`, and the next capture diffs against it.
  snapshots: Map<number, string>;
  // Windows whose latest snapshot came from a query: a diff against it would hide everything outside the query.
  queried: Set<number>;
  // The latest page read and the tab binding it came from. Binding again supersedes its refs, so ref actions reuse it.
  lastRead: { page: PageBinding; read: SemanticSnapshot } | undefined;
  pageLoad: PageLoad;
  session: string;
};

// One label for every job on a bot desktop, which runs one job at a time: cua-driver lets only the session that attached
// Chromium use its page tools, and another session can't attach while that one lives.
export const DESKTOP_SESSION = "crumble-desktop";

export function computerUseState(
  shell: DesktopShell,
  gate?: ControlGate,
  pageLoad: PageLoad = PAGE_LOAD,
): ComputerUseState {
  return {
    shell,
    gate,
    lastChanges: undefined,
    snapshots: new Map(),
    queried: new Set(),
    lastRead: undefined,
    pageLoad,
    session: DESKTOP_SESSION,
  };
}

export const textResult = (
  value: string,
  isError = false,
): ComputerUseResult => ({
  content: [{ type: "text", text: value }],
  isError,
});
