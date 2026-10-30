import type { Context } from "@earendil-works/chord";
import { z } from "zod";
import type { ComputerUseArgs, ComputerUseResult } from "./computer-use";
import type { Acted, Invalid } from "./computer-use-actions";
import { MAX_TREE_CHARS } from "./computer-use-capture";
import {
  codeOf,
  driverCall,
  listWindows,
  messageOf,
  refusalOf,
  targetWindow,
  type DriverArgs,
  type DriverReply,
  type Window,
} from "./computer-use-driver";
import { textResult, type ComputerUseState } from "./computer-use-state";

const loose = <T extends z.ZodType>(schema: T) =>
  schema.optional().catch(undefined);

const tabSchema = z.object({
  tab_id: z.string(),
  url: loose(z.string()),
  title: loose(z.string()),
  active: loose(z.boolean()),
});

const bindReply = z.object({
  target_id: loose(z.string()),
  tabs: loose(z.array(tabSchema)),
});

const refSchema = z.object({
  ref: z.string(),
  role: loose(z.string()),
  name: z.string().nullish().catch(undefined),
  value: z.string().nullish().catch(undefined),
  frame: loose(z.string()),
  states: loose(z.record(z.string(), z.unknown())),
});

export type PageRef = z.infer<typeof refSchema>;

/** A `get_browser_state` snapshot in `semantic_v2`: the fields this tool reads, each dropped when its shape is unexpected. */
const semanticSnapshot = z.object({
  page: loose(z.object({ title: loose(z.string()), url: loose(z.string()) })),
  outline: loose(z.string()),
  refs: z.array(refSchema).catch([]),
  snapshot: loose(
    z.object({ continuation: z.string().nullish().catch(undefined) }),
  ),
});

export type SemanticSnapshot = z.infer<typeof semanticSnapshot>;

/** The tab a page action acts on, bound for this call. */
export type PageBinding = {
  target_id: string;
  tab_id: string;
  url: string;
  title: string;
  /** This call attached the job's cua-driver session to Chromium, which moved focus and opened a setup page. */
  attachedNow: boolean;
};

const ATTACHED =
  "Chromium was attached for page actions; accessibility element numbers are stale.";

const isChromium = (window: Window) => window.app_name.startsWith("Chromium");

type Refused = { refused: string };

/** The window page actions act on: the named one, else the focused one when it is Chromium, else the first Chromium. */
export async function chromiumWindow(
  state: ComputerUseState,
  windowId: number | undefined,
  context: Context,
) {
  const focused = await targetWindow(state, windowId, context);

  if (windowId !== undefined || isChromium(focused)) return focused;

  const browser = (await listWindows(state, context)).find(isChromium);

  if (!browser) throw new Error("Chromium is not open");

  return browser;
}

const refusalText = (reply: Parameters<typeof refusalOf>[0]) =>
  messageOf(reply) ?? codeOf(reply) ?? "refused";

async function bind(state: ComputerUseState, target: Window, context: Context) {
  const { reply } = await driverCall(
    state,
    "get_browser_state",
    { pid: target.pid, window_id: target.window_id },
    context,
  );

  return reply;
}

/** Attaches the job's session to Chromium. It opens a setup page and moves focus, so earlier reads are stale. */
async function attach(
  state: ComputerUseState,
  target: Window,
  context: Context,
): Promise<Refused | undefined> {
  const { reply } = await driverCall(
    state,
    "browser_prepare",
    {
      pid: target.pid,
      window_id: target.window_id,
      strategy: { kind: "existing_profile" },
    },
    context,
  );

  if (refusalOf(reply)) return { refused: refusalText(reply) };

  state.snapshots.clear();
  state.lastRead = undefined;

  return undefined;
}

/** The active tab of a bind reply, or why there is none. */
function boundTab(
  reply: DriverReply,
  attachedNow: boolean,
): PageBinding | Refused {
  const bound = bindReply.parse(reply);
  const tab = bound.tabs?.find((each) => each.active) ?? bound.tabs?.[0];

  if (refusalOf(reply) || !bound.target_id || !tab)
    return { refused: refusalText(reply) };

  return {
    target_id: bound.target_id,
    tab_id: tab.tab_id,
    url: tab.url ?? "",
    title: tab.title ?? "",
    attachedNow,
  };
}

/**
 * Binds the job's cua-driver session to the window's active tab, for `open` and `read`. Binding supersedes the refs of
 * earlier reads. A session is attached to Chromium once, on its first page action.
 */
export async function bindPage(
  state: ComputerUseState,
  target: Window,
  context: Context,
): Promise<PageBinding | Refused> {
  if (!isChromium(target))
    return { refused: "page actions work in Chromium only" };

  const reply = await bind(state, target, context);

  if (codeOf(reply) !== "browser_consent_required")
    return boundTab(reply, false);

  const refused = await attach(state, target, context);

  if (refused) return refused;

  return boundTab(await bind(state, target, context), true);
}

async function snapshot(
  state: ComputerUseState,
  page: PageBinding,
  extra: DriverArgs,
  context: Context,
) {
  const { reply } = await driverCall(
    state,
    "get_browser_state",
    {
      target_id: page.target_id,
      tab_id: page.tab_id,
      snapshot_format: "semantic_v2",
      ...extra,
    },
    context,
  );

  return { reply, read: semanticSnapshot.parse(reply) };
}

const stateWords = (ref: PageRef) =>
  Object.entries(ref.states ?? {}).flatMap(([key, value]) =>
    value === true && key !== "focusable" ? [key] : [],
  );

const refLine = (ref: PageRef) => {
  const value = ref.value ? ` = ${JSON.stringify(ref.value)}` : "";

  const words = stateWords(ref);

  return `[${ref.ref}] ${ref.role ?? "element"} ${JSON.stringify(ref.name ?? "")}${value}${words.length ? ` (${words.join(", ")})` : ""}`;
};

/** A snapshot as the job reads it: the page, its outline, then one line per element it can act on. */
export function pageText(read: SemanticSnapshot) {
  const text = [
    `page ${JSON.stringify(read.page?.title ?? "")} ${read.page?.url ?? ""}`,
    read.outline?.trim(),
    read.refs.length
      ? ["elements (act with ref):", ...read.refs.map(refLine)].join("\n")
      : undefined,
    read.snapshot?.continuation
      ? "more of the page is not shown: narrow the read with query or ref"
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  return text.length > MAX_TREE_CHARS
    ? `${text.slice(0, MAX_TREE_CHARS)}\n[page cut at ${MAX_TREE_CHARS} characters; read with query or ref]`
    : text;
}

const withAttachNote = (page: PageBinding, text: string) =>
  page.attachedNow ? `${ATTACHED}\n${text}` : text;

async function readBound(
  state: ComputerUseState,
  page: PageBinding,
  args: Pick<ComputerUseArgs, "query" | "ref">,
  context: Context,
): Promise<ComputerUseResult> {
  const { reply, read } = await snapshot(
    state,
    page,
    {
      ...(args.query && { query: args.query }),
      ...(args.ref && { scope_ref: args.ref }),
    },
    context,
  );

  if (refusalOf(reply))
    return textResult(`read failed: ${refusalText(reply)}`, true);

  state.lastRead = { page, read };

  return textResult(withAttachNote(page, pageText(read)));
}

export async function readPage(
  state: ComputerUseState,
  args: Pick<ComputerUseArgs, "query" | "ref">,
  target: Window,
  context: Context,
): Promise<ComputerUseResult> {
  const page = await bindPage(state, target, context);

  if ("refused" in page) return textResult(`REFUSED: ${page.refused}`, true);

  return readBound(state, page, args, context);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A tab shows the new URL as soon as navigation starts; a URL that holds this long without a new title has loaded.
// Reloading the open URL changes neither, so reaching the requested URL counts as moving too.
const SETTLE_MS = 1000;

/** Polls the tab until it shows the new page; false when it is still loading at the limit. */
async function waitForLoad(
  state: ComputerUseState,
  target: Window,
  before: PageBinding,
  url: string,
  context: Context,
) {
  const deadline = Date.now() + state.pageLoad.timeoutMs;
  let movedAt: number | undefined;

  while (Date.now() < deadline) {
    await pause(state.pageLoad.pollMs);

    const now = await bindPage(state, target, context);

    if ("refused" in now) continue;

    if (now.title !== before.title) return true;

    if (now.url === before.url && now.url !== url) continue;

    movedAt ??= Date.now();

    if (Date.now() - movedAt >= SETTLE_MS) return true;
  }

  return false;
}

export async function openPage(
  state: ComputerUseState,
  args: ComputerUseArgs,
  target: Window,
  context: Context,
): Promise<ComputerUseResult> {
  if (!args.url || !/^(https?:|about:)/i.test(args.url))
    return textResult(
      "open needs a url starting with http, https, or about:",
      true,
    );

  const page = await bindPage(state, target, context);

  if ("refused" in page) return textResult(`REFUSED: ${page.refused}`, true);

  const { reply } = await driverCall(
    state,
    "browser_navigate",
    { target_id: page.target_id, tab_id: page.tab_id, url: args.url },
    context,
  );

  if (refusalOf(reply))
    return textResult(`REFUSED: ${refusalText(reply)}`, true);

  const loaded = await waitForLoad(state, target, page, args.url, context);
  const read = await readBound(state, page, args, context);

  if (loaded || read.isError) return read;

  return {
    ...read,
    content: [
      { type: "text", text: "The page may still be loading." },
      ...read.content,
    ],
  };
}

const SELECTS = new Set(["combobox", "listbox"]);

const scrollDelta = (args: ComputerUseArgs) => {
  const pixels = (args.amount ?? 3) * 100;

  switch (args.direction) {
    case "up":
      return { delta_y: -pixels };
    case "left":
      return { delta_x: -pixels };
    case "right":
      return { delta_x: pixels };
    default:
      return { delta_y: pixels };
  }
};

type RefCall = { tool: string; args: DriverArgs } | Invalid;

type RefCallBuilder = (
  state: ComputerUseState,
  ids: DriverArgs,
  args: ComputerUseArgs,
) => RefCall;

// Linux Chromium refuses background pointer input from cua-driver, so pointer actions go foreground.
const FOREGROUND = { delivery_mode: "foreground" };

const pointerCall =
  (action: "double_click" | "right_click"): RefCallBuilder =>
  (_state, ids) => ({
    tool: "browser_pointer",
    args: { ...ids, ...FOREGROUND, action },
  });

/** A select takes the option's label; other fields take the value as replacement text. */
const valueCall: RefCallBuilder = (state, ids, args) => {
  if (args.value === undefined) return { invalid: "set_value needs value" };

  const role = state.lastRead?.read.refs.find(
    (each) => each.ref === args.ref,
  )?.role;

  return role && SELECTS.has(role)
    ? { tool: "browser_select", args: { ...ids, label: args.value } }
    : {
        tool: "browser_type",
        args: { ...ids, text: args.value, replace: true },
      };
};

const REF_CALLS = new Map<string, RefCallBuilder>([
  [
    "click",
    (_state, ids) => ({
      tool: "browser_click",
      args: { ...ids, ...FOREGROUND },
    }),
  ],
  ["double_click", pointerCall("double_click")],
  ["right_click", pointerCall("right_click")],
  [
    "scroll",
    (_state, ids, args) => ({
      tool: "browser_pointer",
      args: { ...ids, ...FOREGROUND, action: "scroll", ...scrollDelta(args) },
    }),
  ],
  [
    "type",
    (_state, ids, args) =>
      args.text === undefined
        ? { invalid: "type needs text" }
        : { tool: "browser_type", args: { ...ids, text: args.text } },
  ],
  ["set_value", valueCall],
]);

/** The actions that take a page ref instead of an element. */
export const REF_ACTIONS = new Set(REF_CALLS.keys());

function refCall(
  state: ComputerUseState,
  page: PageBinding,
  args: ComputerUseArgs & { ref: string },
): RefCall {
  const build = REF_CALLS.get(args.action);

  if (!build) return { invalid: `${args.action} takes no ref` };

  return build(
    state,
    { target_id: page.target_id, tab_id: page.tab_id, ref: args.ref },
    args,
  );
}

/** Acts on a page ref in the tab of the latest read, the tab the ref came from. */
export async function actOnRef(
  state: ComputerUseState,
  args: ComputerUseArgs & { ref: string },
  context: Context,
): Promise<Acted | Invalid> {
  const page = state.lastRead?.page;

  if (!page)
    return { invalid: "read the page first, then act on a ref from it" };

  const call = refCall(state, page, args);

  if ("invalid" in call) return call;

  const { reply } = await driverCall(state, call.tool, call.args, context);

  return { reply, route: "page" };
}
