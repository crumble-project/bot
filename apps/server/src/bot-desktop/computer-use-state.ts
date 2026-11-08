import type {
  ComputerUseResult,
  ControlGate,
  DesktopShell,
} from "./computer-use";
import type { LoginFill } from "../logins/login-fill";
import type { DesktopFills } from "./computer-use-login";
import type { PageBinding, SemanticSnapshot } from "./computer-use-page";
import type { IntentTarget } from "./intent-check";

export type PageLoad = { pollMs: number; timeoutMs: number };

const PAGE_LOAD: PageLoad = { pollMs: 250, timeoutMs: 10_000 };

export type ComputerUseState = {
  shell: DesktopShell;
  gate: ControlGate | undefined;
  lastChanges: number | undefined;
  snapshots: Map<number, string>;
  elements: Map<string, Map<number, IntentTarget>>;
  queried: Set<number>;
  lastRead: { page: PageBinding; read: SemanticSnapshot } | undefined;
  pageLoad: PageLoad;
  session: string;
  logins: LoginFill | undefined;
  filled: Map<string, string>;
  browsers: Set<string>;
  fills: DesktopFills | undefined;
};

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
    lastChanges: undefined,
    snapshots: new Map(),
    elements: new Map(),
    queried: new Set(),
    lastRead: undefined,
    pageLoad,
    session: DESKTOP_SESSION,
  };
}

export function forgetScreen(state: ComputerUseState) {
  state.snapshots.clear();
  state.elements.clear();
  state.queried.clear();
  state.lastRead = undefined;
}

export const refOf = (state: ComputerUseState, ref: string | undefined) =>
  state.lastRead?.read.refs.find((each) => each.ref === ref);

export const currentPage = (state: ComputerUseState) =>
  state.lastRead?.read.page?.url ?? state.lastRead?.page.url;

/** A page's host without its port, as logins name hosts. Undefined for a URL without one. */
export function pageHost(url: string | undefined) {
  if (!url || !URL.canParse(url)) return undefined;

  return new URL(url).hostname || undefined;
}

export const textResult = (
  value: string,
  isError = false,
): ComputerUseResult => ({
  content: [{ type: "text", text: value }],
  isError,
});

export function scrubText(state: ComputerUseState, text: string) {
  const labels = new Map<string, string>();

  for (const [value, label] of state.filled)
    for (const form of [value, JSON.stringify(value).slice(1, -1)])
      if (form) labels.set(form, label);

  if (!labels.size) return text;

  const pattern = new RegExp(
    [...labels.keys()]
      .sort((a, b) => b.length - a.length)
      .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "g",
  );

  return text.replace(pattern, (form) => labels.get(form) ?? form);
}
