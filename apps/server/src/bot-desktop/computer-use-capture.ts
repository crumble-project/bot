import type { Context } from "@earendil-works/chord";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  codeOf,
  compactTree,
  driverCall,
  listWindows,
  messageOf,
  refusalOf,
  type DriverReply,
  type Window,
} from "./computer-use-driver";
import type { ComputerUseState } from "./computer-use-state";

export const MAX_TREE_CHARS = 12_000;

const otherWindows = (target: Window, list: Window[]) =>
  list.flatMap((each) =>
    each.window_id === target.window_id
      ? []
      : [`${each.window_id} ${each.app_name} "${each.title}"`],
  );

function headerOf(
  target: Window,
  reply: DriverReply,
  since: string | undefined,
  query: string | undefined,
  others: string[],
) {
  return [
    `window ${target.window_id} ${target.app_name} "${target.title}" (snapshot ${reply.snapshot_id ?? "none"}${since ? `, changes since ${since}` : ""}${query ? `, elements matching "${query}"` : ""})`,
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

/** The window's tree, compacted and cut to fit this tool's result. */
function treeOf(reply: DriverReply) {
  const tree = compactTree(reply.tree_diff ?? reply.tree_markdown ?? "");

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
    state.snapshots.set(target.window_id, reply.snapshot_id);

    if (query) state.queried.add(target.window_id);
    else state.queried.delete(target.window_id);
  }

  return `${headerOf(target, reply, since, query, others)}\n${treeOf(reply)}`;
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

export async function captureWindow(
  state: ComputerUseState,
  target: Window,
  mode: string,
  full: boolean,
  query: string | undefined,
  context: Context,
): Promise<(TextContent | ImageContent)[]> {
  const since = diffBase(state, target, mode, full, query);

  const vision = mode === "vision";

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

  return content;
}
