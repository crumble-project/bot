import type { Context } from "@earendil-works/chord";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  codeOf,
  compactTree,
  driverCall,
  listWindows,
  messageOf,
  refusalOf,
  replyTree,
  windowLine,
  type DriverReply,
  type Window,
} from "./computer-use-driver";
import type { IntentTarget } from "./intent-check";
import { passwordMayShow } from "./computer-use-login";
import { scrubText, type ComputerUseState } from "./computer-use-state";

export const MAX_TREE_CHARS = 12_000;

const otherWindows = (target: Window, list: Window[]) =>
  list.flatMap((each) =>
    each.window_id === target.window_id ? [] : [windowLine(each)],
  );

function headerOf(
  target: Window,
  reply: DriverReply,
  since: string | undefined,
  query: string | undefined,
  others: string[],
) {
  return [
    `window ${windowLine(target)} (snapshot ${reply.snapshot_id ?? "none"}${since ? `, changes since ${since}` : ""}${query ? `, elements matching "${query}"` : ""})`,
    others.length ? `other windows: ${others.join("; ")}` : undefined,
    reply.degraded ? `degraded: ${reply.degraded_reason ?? ""}` : undefined,
    reply.truncated
      ? "tree truncated: capture with full=true or narrow the window"
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

const screenshotOf = (
  reply: DriverReply,
  image: string,
): (TextContent | ImageContent)[] => [
  {
    type: "text",
    text: `screenshot ${reply.screenshot_width ?? "?"}x${reply.screenshot_height ?? "?"}, coordinates are pixels of this image`,
  },
  { type: "image", data: image, mimeType: "image/jpeg" },
];

const NO_SCREENSHOT: TextContent = {
  type: "text",
  text: "no screenshot: a password was typed into this Chromium, and a screenshot could show it; screenshots return once Chromium restarts",
};

/** The window's tree, compacted, scrubbed, and cut to fit this tool's result; scrubbed first, so no cut splits a value. */
function treeOf(state: ComputerUseState, reply: DriverReply) {
  const tree = scrubText(state, compactTree(replyTree(reply)));

  return tree.length > MAX_TREE_CHARS
    ? `${tree.slice(0, MAX_TREE_CHARS)}\n[tree cut at ${MAX_TREE_CHARS} characters; scroll or capture a smaller window]`
    : tree;
}

export const elementToken = (
  state: ComputerUseState,
  target: Window,
  element: number,
) => {
  const snapshot = state.snapshots.get(target.window_id);

  if (!snapshot)
    throw new Error("no capture of this window yet; capture first");

  return `${snapshot}:${element}`;
};

// `- [3] push button "Pay now" [actions=...]` in a full tree; a diff marks lines `+`, `~`, or `-` (removed). The role
// runs up to the name's quote or the first `[`, so it keeps every word.
const ELEMENT_LINE =
  /^\s*([-+~])?\s*\[(\d+)\]\s+([^"[\n]*)(?:"((?:[^"\\]|\\.)*)")?/;

const unquote = (name: string) => {
  try {
    return z
      .string()
      .catch(name)
      .parse(JSON.parse(`"${name}"`));
  } catch {
    return name;
  }
};

type ElementLine = { index: number; removed: boolean; target: IntentTarget };

function elementLine(
  state: ComputerUseState,
  line: string,
  diff: boolean,
): ElementLine | undefined {
  const match = ELEMENT_LINE.exec(line);

  if (!match) return undefined;

  const [, mark, index, role = "", name] = match;
  const target: IntentTarget = {};

  if (role.trim()) target.role = scrubText(state, role.trim());

  if (name !== undefined) target.name = scrubText(state, unquote(name));

  // Only a diff marks removals; a full tree's `-` is a list bullet.
  return { index: Number(index), removed: diff && mark === "-", target };
}

/** Keeps the role and name of each element under its snapshot, so an action by index can name its target to the judge. */
function recordElements(
  state: ComputerUseState,
  windowId: number,
  snapshot: string,
  reply: DriverReply,
) {
  const diff = reply.tree_diff !== undefined;
  const previous = state.snapshots.get(windowId);
  const known = new Map(diff ? state.elements.get(previous ?? "") : undefined);

  for (const line of replyTree(reply).split("\n")) {
    const element = elementLine(state, line, diff);

    if (element?.removed) known.delete(element.index);
    else if (element) known.set(element.index, element.target);
  }

  if (previous) state.elements.delete(previous);
  state.elements.set(snapshot, known);
}

/** A window read as the job sees it; its snapshot becomes the window's latest, for element tokens and the next diff. */
export function windowText(
  state: ComputerUseState,
  target: Window,
  reply: DriverReply,
  since: string | undefined,
  query: string | undefined,
  others: string[],
) {
  if (reply.snapshot_id) {
    recordElements(state, target.window_id, reply.snapshot_id, reply);
    state.snapshots.set(target.window_id, reply.snapshot_id);

    if (query) state.queried.add(target.window_id);
    else state.queried.delete(target.window_id);
  }

  return `${headerOf(target, reply, since, query, others)}\n${treeOf(state, reply)}`;
}

/** The snapshot a capture diffs against: none for vision, full, or query reads, or after a query read. */
const diffBase = (
  state: ComputerUseState,
  target: Window,
  mode: string,
  full: boolean,
  query: string | undefined,
) =>
  mode === "ax" && !full && !query && !state.queried.has(target.window_id)
    ? state.snapshots.get(target.window_id)
    : undefined;

// A screenshot can't be scrubbed, so a vision capture goes without one while a password may show.
const screenshotMode = async (
  state: ComputerUseState,
  mode: string,
  context: Context,
) =>
  mode !== "vision"
    ? "none"
    : (await passwordMayShow(state, context))
      ? "withheld"
      : "taken";

export async function captureWindow(
  state: ComputerUseState,
  target: Window,
  mode: string,
  full: boolean,
  query: string | undefined,
  context: Context,
): Promise<(TextContent | ImageContent)[]> {
  const since = diffBase(state, target, mode, full, query);
  const screenshot = await screenshotMode(state, mode, context);
  const vision = screenshot === "taken";

  const { reply, image } = await driverCall(
    state,
    "get_window_state",
    {
      pid: target.pid,
      window_id: target.window_id,
      include_screenshot: vision,
      ...(since && { since }),
      ...(query && { query }),
    },
    context,
    vision,
  );

  if (refusalOf(reply))
    return [
      {
        type: "text",
        text: `capture failed: ${messageOf(reply) ?? codeOf(reply) ?? "unknown error"}`,
      },
    ];

  const others = otherWindows(target, await listWindows(state, context));

  const content: (TextContent | ImageContent)[] = [
    {
      type: "text",
      text: windowText(state, target, reply, since, query, others),
    },
  ];

  if (image) content.push(...screenshotOf(reply, image));
  else if (screenshot === "withheld") content.push(NO_SCREENSHOT);

  return content;
}
