import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { z } from "zod";
import { newSession, type ComputerUseState } from "./computer-use-state";

const ENV_FILE = "/run/crumble-desktop.env";
// cua-driver ends idle sessions; a call on an ended one is rejected with this message.

const ENDED_SESSION = /session has ended/i;

const loose = <T extends z.ZodType>(schema: T) =>
  schema.optional().catch(undefined);

const windowSchema = z.object({
  pid: z.number(),
  window_id: z.number(),
  app_name: z.string(),
  title: z.string(),
});

export type Window = z.infer<typeof windowSchema>;

// cua-driver reports refusals in several shapes; an error is a message or an object with a code.
const driverError = z.union([
  z.string().transform((message) => ({ code: undefined, message })),
  z.object({ code: loose(z.string()), message: loose(z.string()) }),
]);

/** A cua-driver tool result: the fields this tool reads, each dropped when its shape is unexpected. */
const driverReply = z.object({
  status: loose(z.string()),
  effect: loose(z.string()),
  code: loose(z.string()),
  summary: loose(z.string()),
  message: loose(z.string()),
  detail: loose(z.string()),
  hint: loose(z.string()),
  error: loose(driverError),
  refusal: loose(
    z.object({ code: loose(z.string()), message: loose(z.string()) }),
  ),
  escalation: loose(z.object({ recommended: loose(z.string()) })),
  snapshot_id: loose(z.string()),
  tree_markdown: loose(z.string()),
  tree_diff: loose(z.string()),
  degraded: loose(z.boolean()),
  degraded_reason: loose(z.string()),
  truncated: loose(z.boolean()),
  screenshot_width: loose(z.number()),
  screenshot_height: loose(z.number()),
  windows: loose(z.array(windowSchema)),
});

export type DriverReply = z.infer<typeof driverReply>;

/** Arguments for a cua-driver tool. */
export type DriverArgs = Record<string, string | number | boolean | string[]>;

function parseReply(output: string): DriverReply {
  try {
    const parsed = driverReply.safeParse(JSON.parse(output));

    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON: cua-driver printed an error.
  }

  return {
    error: {
      code: undefined,
      message: output.trim().slice(0, 500) || "cua-driver returned nothing",
    },
  };
}

// Chromium names container panels with U+FFFC placeholders and gives every node showContextMenu: tokens, no meaning.
export const compactTree = (tree: string) =>
  tree.replace(/￼+/g, "").replace(/,showContextMenu|showContextMenu,?/g, "");

// cua-driver's hints sometimes name its own tools (run_steps, get_window_state); keep only advice that fits ours.
export const cleanHint = (hint = "") =>
  hint
    .replace(/\s*Three single actions in a row:.*$/s, "")
    .replace(/get_window_state/g, "capture")
    .trim();

export const codeOf = (reply: DriverReply) =>
  reply.code ?? reply.refusal?.code ?? reply.error?.code;

export const refusalOf = (reply: DriverReply) => {
  const code = codeOf(reply);

  const refused =
    reply.status === "refused" ||
    reply.effect === "refused" ||
    reply.effect === "none" ||
    reply.error !== undefined ||
    Boolean(code?.endsWith("_unavailable"));

  return refused ? (code ?? "refused") : undefined;
};

export const wantsForeground = (reply: DriverReply) =>
  Boolean(codeOf(reply)?.endsWith("_unavailable")) ||
  reply.escalation?.recommended === "foreground";

export const messageOf = (reply: DriverReply) =>
  [
    reply.summary,
    reply.refusal?.message,
    reply.message,
    reply.detail,
    reply.error?.message,
  ].find(Boolean);

export async function sh(
  state: ComputerUseState,
  command: string,
  context: Context,
) {
  let output = "";

  const result = await state.shell.exec(
    `. ${ENV_FILE}; ${command}`,
    { onOutput: (text) => (output += text) },
    context,
  );

  if (!result.ok) throw result.error;

  return output;
}

/**
 * One cua-driver call; an ended session is replaced, its snapshots dropped, and the call retried once.
 */
export async function driverCall(
  state: ComputerUseState,
  tool: string,
  args: DriverArgs,
  context: Context,
  screenshot = false,
) {
  const first = await callDriver(state, tool, args, context, screenshot);

  if (!ENDED_SESSION.test(messageOf(first.reply) ?? "")) return first;

  state.session = newSession();
  state.snapshots.clear();

  return callDriver(state, tool, args, context, screenshot);
}

async function callDriver(
  state: ComputerUseState,
  tool: string,
  args: DriverArgs,
  context: Context,
  screenshot: boolean,
) {
  // Unique per call: a file left by another job's call can never stand in for this one's.
  const id = randomUUID();
  const argsFile = `/tmp/computer-use-${id}.json`;
  const png = `/tmp/computer-use-${id}.png`;
  const jpg = `/tmp/computer-use-${id}.jpg`;

  const written = await state.shell.writeFile(
    argsFile,
    JSON.stringify({ session: state.session, ...args }),
    context,
  );

  if (!written.ok) throw written.error;

  const shot = screenshot ? ` --screenshot-out-file ${png}` : "";

  const reply = parseReply(
    await sh(
      state,
      `cua-driver call ${tool}${shot} "$(cat ${argsFile})"; rm -f ${argsFile}`,
      context,
    ),
  );

  if (!screenshot) return { reply };

  try {
    const converted = await state.shell.exec(
      `convert ${png} -quality 75 ${jpg}`,
      undefined,
      context,
    );

    if (!converted.ok || converted.value.exitCode !== 0) return { reply };

    const image = await state.shell.readBinaryFile(jpg, context);

    return {
      reply,
      image: image.ok ? Buffer.from(image.value).toString("base64") : undefined,
    };
  } finally {
    await state.shell.exec(`rm -f ${png} ${jpg}`, undefined, context);
  }
}

export async function listWindows(state: ComputerUseState, context: Context) {
  const { reply } = await driverCall(state, "list_windows", {}, context);

  // A refused listing is not an empty desktop.
  if (!reply.windows && refusalOf(reply))
    throw new Error(messageOf(reply) ?? codeOf(reply) ?? "list_windows failed");

  return (reply.windows ?? []).filter((each) => each.app_name !== "Tint2");
}

export async function targetWindow(
  state: ComputerUseState,
  windowId: number | undefined,
  context: Context,
) {
  const list = await listWindows(state, context);

  if (windowId !== undefined) {
    const found = list.find((each) => each.window_id === windowId);

    if (!found) throw new Error(`no window ${windowId}; call list_windows`);

    return found;
  }

  const active = Number(
    (await sh(state, "xdotool getactivewindow 2>/dev/null", context)).trim(),
  );

  const found = list.find((each) => each.window_id === active) ?? list[0];

  if (!found) throw new Error("no windows are open");

  return found;
}
