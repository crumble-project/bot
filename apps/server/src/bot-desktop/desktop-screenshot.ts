import { errorText } from "../shared/errors";
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  Type,
  type ImageContent,
  type TextContent,
} from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Layer } from "effect";
import { BotExtensions, ExtensionPosition } from "../bot-ports/bot-extensions";
import { chatOnly } from "../shared/chat-only";
import { BotWorkspaces, type Workspaces } from "../workspaces/workspace";
import type { DesktopShell } from "./computer-use";
import {
  passwordMayShow,
  restoreFilled,
  type DesktopFills,
} from "./computer-use-login";
import { computerUseState } from "./computer-use-state";
import { sh } from "./computer-use-driver";
import type { DesktopFillRepository } from "./desktop-fill-repository";
import { desktopFillsAccess } from "./desktop-fill-repository";
import { runnerOf } from "../shared/runner";
import { DESKTOP_SCREENSHOT_TOOL_NAME, usesDesktop } from "../contract/tools";

const MIME_TYPE = "image/jpeg";
const MAX_BYTES = 5 * 1024 * 1024;

export type DesktopScreenshotDetails = { mimeType: string; size: number };

export type ScreenshotWorkspaces = Pick<
  Workspaces,
  "desktop" | "desktopRunning" | "keepAwake"
> & { env(agentId: string): DesktopShell };

export type ScreenshotResult =
  | { image: string; size: number }
  | { error: string };

export const NO_DESKTOP_IMAGE =
  "This server has no bot desktop image, so there is no screen to capture.";

export const DESKTOP_NOT_RUNNING =
  "The bot desktop is not running, so there is no screen to capture. This tool never starts it; a desktop job does.";

export const PASSWORD_MAY_SHOW =
  "REFUSED: a password was typed into the Chromium running on the bot desktop, and a screenshot could show it. Screenshots return once Chromium restarts.";

const failed = (reason: string) => ({
  error: `The screenshot failed: ${reason.trim().slice(0, 300) || "unknown error"}`,
});

async function passwordCheck(
  shell: DesktopShell,
  fills: DesktopFills,
  context: Context,
) {
  const state = computerUseState(shell, { fills });

  await restoreFilled(state);

  try {
    return await passwordMayShow(state, context);
  } catch {
    return true;
  }
}

async function grab(shell: DesktopShell, context: Context) {
  // Unique per call: a file left by another capture can never stand in for this one.
  const jpg = `/tmp/desktop-screenshot-${randomUUID()}.jpg`;

  try {
    const output = await sh(
      shell,
      `import -window root -quality 75 ${jpg} 2>&1 && echo ok`,
      context,
    );

    if (!output.trim().endsWith("ok")) return failed(output);

    const read = await shell.readBinaryFile(jpg, context);

    if (!read.ok) return failed(read.error.message);

    if (read.value.byteLength > MAX_BYTES)
      return failed("the image is larger than 5 MB");

    return {
      image: Buffer.from(read.value).toString("base64"),
      size: read.value.byteLength,
    };
  } finally {
    await shell.exec(`rm -f ${jpg}`, undefined, context);
  }
}

export async function captureDesktop(
  workspaces: ScreenshotWorkspaces | undefined,
  agentId: string,
  fills: DesktopFills,
  context: Context,
): Promise<ScreenshotResult> {
  if (!workspaces?.desktop) return { error: NO_DESKTOP_IMAGE };

  // Held before the check, so the idle stop can't come between it and the capture.
  const release = workspaces.keepAwake(agentId);

  try {
    if (!workspaces.desktopRunning(agentId))
      return { error: DESKTOP_NOT_RUNNING };

    const shell = workspaces.env(agentId);

    if (await passwordCheck(shell, fills, context))
      return { error: PASSWORD_MAY_SHOW };

    return await grab(shell, context);
  } catch (error) {
    return failed(errorText(error));
  } finally {
    release();
  }
}

export function desktopScreenshotExtension(
  agentId: string,
  workspaces: ScreenshotWorkspaces | undefined,
  fills: DesktopFills,
) {
  const screenshot = defineTool({
    name: DESKTOP_SCREENSHOT_TOOL_NAME,
    description:
      "Show the owner a screenshot of your bot desktop's whole screen inline in the chat, and see it yourself. Use it when the owner asks to see the desktop or when a picture of it answers better than words. " +
      "It only captures a desktop that is already running and never starts one. Your turn ends once it is shown, so call it last and write any text before the call.",
    parameters: Type.Object({}),
    // Scripts cannot render to the owner, so code mode keeps this as a direct model tool.
    callers: ["model"],
    replay: "safe",
    execute: async (_args, _api, context) => {
      const result = await captureDesktop(workspaces, agentId, fills, context);

      if ("error" in result)
        return {
          output: [{ type: "text" as const, text: result.error }],
          isError: true,
        };

      const output: (TextContent | ImageContent)[] = [
        { type: "text", text: "Shown to the owner." },
        { type: "image", data: result.image, mimeType: MIME_TYPE },
      ];

      const details: DesktopScreenshotDetails = {
        mimeType: MIME_TYPE,
        size: result.size,
      };

      return { output, details, control: { terminate: true as const } };
    },
  });

  // A group's transcript can't show the image.
  return chatOnly(
    defineExtension({ name: "desktop-screenshot", tools: [screenshot] }),
  );
}

export const desktopScreenshotTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const workspaces = yield* BotWorkspaces;
    const run = runnerOf(yield* Effect.context<DesktopFillRepository>());

    yield* (yield* BotExtensions).register(
      ExtensionPosition.desktopScreenshot,
      (agent) =>
        usesDesktop(agent)
          ? [
              desktopScreenshotExtension(
                agent.id,
                workspaces,
                desktopFillsAccess(run, agent.id),
              ),
            ]
          : [],
    );
  }),
);
