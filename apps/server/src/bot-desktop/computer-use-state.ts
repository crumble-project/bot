import type {
  ComputerUseResult,
  ControlGate,
  DesktopShell,
} from "./computer-use";
import type { LoginFill } from "../logins/login-fill";
import type { DesktopFills } from "./computer-use-login";
import type { PageBinding, SemanticSnapshot } from "./computer-use-page";
import type { IntentTarget } from "./intent-check";

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
  // Role and name of each element [N] by snapshot, as captures showed them, for the intent check's target.
  elements: Map<string, Map<number, IntentTarget>>;
  // Windows whose latest snapshot came from a query: a diff against it would hide everything outside the query.
  queried: Set<number>;
  // The latest page read and the tab binding it came from. Binding again supersedes its refs, so ref actions reuse it.
  lastRead: { page: PageBinding; read: SemanticSnapshot } | undefined;
  pageLoad: PageLoad;
  session: string;
  logins: LoginFill | undefined;
  // Every password typed on this desktop, by this job or an earlier one, with the label that replaces it in results.
  filled: Map<string, string>;
  // The Chromium instances a password was typed into.
  browsers: Set<string>;
  fills: DesktopFills | undefined;
  restored: Promise<void> | undefined;
};

/** What a job's tool is built with besides its shell. */
export type ComputerUseOptions = {
  gate?: ControlGate | undefined;
  pageLoad?: PageLoad | undefined;
  logins?: LoginFill | undefined;
  fills?: DesktopFills | undefined;
};

// One label for every job on a bot desktop, which runs one job at a time: cua-driver lets only the session that attached
// Chromium use its page tools, and another session can't attach while that one lives.
const DESKTOP_SESSION = "crumble-desktop";

export function computerUseState(
  shell: DesktopShell,
  { gate, pageLoad = PAGE_LOAD, logins, fills }: ComputerUseOptions = {},
): ComputerUseState {
  return {
    shell,
    gate,
    logins,
    filled: new Map(),
    browsers: new Set(),
    fills,
    restored: undefined,
    lastChanges: undefined,
    snapshots: new Map(),
    elements: new Map(),
    queried: new Set(),
    lastRead: undefined,
    pageLoad,
    session: DESKTOP_SESSION,
  };
}

/** The screen changed under the job: what it read no longer holds, and the next capture starts over. */
export function forgetScreen(state: ComputerUseState) {
  state.snapshots.clear();
  state.elements.clear();
  state.queried.clear();
  state.lastRead = undefined;
}

/** The element of the latest page read with this ref. */
export const refOf = (state: ComputerUseState, ref: string | undefined) =>
  state.lastRead?.read.refs.find((each) => each.ref === ref);

/** The URL of the latest page read: what the page reported, else the tab it was bound to. */
export const currentPage = (state: ComputerUseState) =>
  state.lastRead?.read.page?.url ?? state.lastRead?.page.url;

export const textResult = (
  value: string,
  isError = false,
): ComputerUseResult => ({
  content: [{ type: "text", text: value }],
  isError,
});

/**
 * Replaces every password typed on this desktop with its label, so no result shows it. Also its JSON-escaped form, for
 * text that quotes it.
 */
export function scrubText(state: ComputerUseState, text: string) {
  const labels = new Map<string, string>();

  for (const [value, label] of state.filled)
    for (const form of [value, JSON.stringify(value).slice(1, -1)])
      if (form) labels.set(form, label);

  if (!labels.size) return text;

  // One pass, longest first: a label is never scrubbed again, and a value inside a longer one can't split it.
  const pattern = new RegExp(
    [...labels.keys()]
      .sort((a, b) => b.length - a.length)
      .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "g",
  );

  return text.replace(pattern, (form) => labels.get(form) ?? form);
}
