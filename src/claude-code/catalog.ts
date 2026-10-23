// Ported from Hermes' claude-subscription-directsdk model_catalog.py (MIT, see THIRD_PARTY_NOTICES.md).

/** Pinned native routes with their context windows; a loopback gateway needs explicit long-context selection. */
export const CONTEXT_WINDOWS = new Map([
  ["claude-sonnet-5-5", 1_000_000],
  ["claude-sonnet-5", 1_000_000],
  ["claude-haiku-5-5", 1_000_000],
  ["claude-haiku-4-5-20251001", 200_000],
  ["claude-opus-5-5", 1_000_000],
  ["claude-opus-5", 1_000_000],
  ["claude-opus-4-8", 1_000_000],
  ["claude-fable-5-1", 1_000_000],
]);

/** The window Claude Code applies to an id it cannot verify behind the relay. */
export const UNPINNED_WINDOW = 200_000;

// Families that 400 on `thinking: {type: "disabled"}`; a disable becomes the lowest effort instead.
const MANDATORY_THINKING = [
  "claude-fable",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];

export const ALIASES = new Map([
  ["sonnet", "claude-sonnet-5-5"],
  ["haiku", "claude-haiku-5-5"],
  ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
  ["opus", "claude-opus-5-5"],
  ["fable", "claude-fable-5-1"],
]);

// Haiku 4.5 rejects adaptive thinking; unknown routes keep it so future models are not downgraded.
const NO_ADAPTIVE_THINKING = new Set(["claude-haiku-4-5-20251001"]);

/** The catalogued id a short name points at, or the name unchanged when it points at none. */
function routeBase(base: string): string {
  if (ALIASES.has(base) || CONTEXT_WINDOWS.has(base)) return base;
  const dotted = base.replaceAll(".", "-");

  if (dotted !== base) return routeBase(dotted);
  const withVendor = `claude-${base.replace(/^claude-/, "")}`;

  if (CONTEXT_WINDOWS.has(withVendor) || ALIASES.has(withVendor))
    return withVendor;

  return base;
}

const canonicalOf = (model: string) => {
  const base = routeBase(model.replace(/\[1m\]$/, ""));

  return ALIASES.get(base) ?? base;
};

/** The id Claude Code is started with: pinned 1M routes get `[1m]`, unknown ids pass through as typed. */
export function nativeModel(model: string) {
  const canonical = canonicalOf(model);
  const window = CONTEXT_WINDOWS.get(canonical);

  if (window === 1_000_000) return `${canonical}[1m]`;

  if (window === 200_000) {
    if (model.endsWith("[1m]"))
      throw new Error(`${canonical} does not support a 1M context window`);

    return canonical;
  }

  return model;
}

export const acceptsThinkingDisable = (model: string) =>
  !MANDATORY_THINKING.some((family) => canonicalOf(model).startsWith(family));

export const supportsAdaptiveThinking = (model: string) =>
  !NO_ADAPTIVE_THINKING.has(canonicalOf(model));

/**
 * The window to promise for a route: the pinned one, else the 200K native applies to a plain unknown id. An unknown
 * `[1m]` id gets 1M, the most native will serve, since nothing smaller is known either.
 */
export function contextWindow(route: string) {
  const pinned = CONTEXT_WINDOWS.get(canonicalOf(route));

  if (pinned !== undefined) return pinned;

  return route.endsWith("[1m]") ? 1_000_000 : UNPINNED_WINDOW;
}

/** `claude-opus-4-8` reads `Opus 4.8`; a trailing snapshot date is dropped. */
export function catalogLabel(model: string) {
  const parts = model.replace(/^claude-/, "").split("-");

  if (/^\d{8}$/.test(parts.at(-1) ?? "")) parts.pop();
  const [family = "", ...rest] = parts;
  const version = rest.filter((part) => /^\d+$/.test(part)).join(".");

  return [family.charAt(0).toUpperCase() + family.slice(1), version]
    .filter(Boolean)
    .join(" ");
}

/** Every pinned route, as Claude Code is started with it. */
export const pinnedRoutes = () =>
  [...CONTEXT_WINDOWS.keys()].map((model) => ({
    route: nativeModel(model),
    canonical: model,
  }));
