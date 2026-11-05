import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentRuntime } from "../bots/runtime";
import { defaultAvatarDefinition } from "../contract/avatar";
import { latestMessagePreview } from "../bots/transcript";
import { agentInput, type Agent } from "../shared/domain";
import { scriptedGuest } from "../../test/fixtures/scripted-guest";
import type { DesktopFill, DesktopFills } from "./computer-use-login";
import {
  captureDesktop,
  DESKTOP_NOT_RUNNING,
  desktopScreenshotExtension,
  NO_DESKTOP_IMAGE,
  PASSWORD_MAY_SHOW,
  type ScreenshotWorkspaces,
} from "./desktop-screenshot";
import { DESKTOP_SCREENSHOT_TOOL_NAME } from "../contract/tools";
import { runtimeCallbacks } from "../../test/support/runtime-callbacks";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

const chromium = {
  windows: [{ pid: 7, window_id: 101, app_name: "Chromium", title: "Home" }],
};

/** The desktop's recorded password fills; the scripted Chromium is `7 <processStart>`. */
const fillsOf = (record: DesktopFill[] = []): DesktopFills => ({
  list: async () => [...record],
  add: async (fill) => {
    record.push(fill);
  },
});

function fakeWorkspaces(running = true, desktop = true) {
  const guest = scriptedGuest({ list_windows: [chromium] });
  const holds = { taken: 0, released: 0 };

  const workspaces: ScreenshotWorkspaces = {
    desktop,
    desktopRunning: () => running,
    keepAwake: () => {
      holds.taken += 1;

      return () => {
        holds.released += 1;
      };
    },
    env: () => guest.shell,
  };

  return { workspaces, guest, holds };
}

const captures = (commands: string[]) =>
  commands.filter((command) => command.includes("import -window root"));

test("captures the whole running desktop and removes its file", async () => {
  const { workspaces, guest, holds } = fakeWorkspaces();

  const result = await captureDesktop(
    workspaces,
    "bot",
    fillsOf(),
    BACKGROUND_CONTEXT,
  );

  expect(result).toEqual({ image: JPEG, size: 4 });
  expect(captures(guest.commands)).toHaveLength(1);
  expect(captures(guest.commands)[0]).toStartWith(
    ". /run/crumble-desktop.env; ",
  );
  expect([...guest.files.keys()]).toEqual([]);
  // Without a password typed, the capture doesn't ask cua-driver anything.
  expect(guest.calls).toEqual([]);
  expect(holds).toEqual({ taken: 1, released: 1 });
});

test("never starts the desktop: without an image or a running desktop it only says so", async () => {
  const none = await captureDesktop(
    undefined,
    "bot",
    fillsOf(),
    BACKGROUND_CONTEXT,
  );

  expect(none).toEqual({ error: NO_DESKTOP_IMAGE });

  const noImage = fakeWorkspaces(true, false);

  expect(
    await captureDesktop(
      noImage.workspaces,
      "bot",
      fillsOf(),
      BACKGROUND_CONTEXT,
    ),
  ).toEqual({ error: NO_DESKTOP_IMAGE });
  expect(noImage.guest.commands).toEqual([]);

  const stopped = fakeWorkspaces(false);

  expect(
    await captureDesktop(
      stopped.workspaces,
      "bot",
      fillsOf(),
      BACKGROUND_CONTEXT,
    ),
  ).toEqual({ error: DESKTOP_NOT_RUNNING });
  expect(stopped.guest.commands).toEqual([]);
  expect(stopped.holds).toEqual({ taken: 1, released: 1 });
});

test("refuses while a password typed into the running Chromium may show", async () => {
  const { workspaces, guest, holds } = fakeWorkspaces();

  const fills = fillsOf([
    {
      value: "hunter2",
      label: "[login github password]",
      browser: `7 ${guest.state.processStart}`,
    },
  ]);

  expect(
    await captureDesktop(workspaces, "bot", fills, BACKGROUND_CONTEXT),
  ).toEqual({ error: PASSWORD_MAY_SHOW });
  expect(captures(guest.commands)).toEqual([]);
  expect(holds).toEqual({ taken: 1, released: 1 });

  // A restarted Chromium shows none of the old one's pages.
  guest.state.processStart = "Thu Oct 30 11:00:00 2026";

  expect(
    await captureDesktop(workspaces, "bot", fills, BACKGROUND_CONTEXT),
  ).toEqual({ image: JPEG, size: 4 });
});

test("refuses when it can't tell whether a password shows", async () => {
  const guest = scriptedGuest({
    list_windows: [{ error: { code: "x11_unavailable", message: "no X" } }],
  });

  const { workspaces } = fakeWorkspaces();
  workspaces.env = () => guest.shell;

  const fills = fillsOf([
    { value: "hunter2", label: "[login github password]", browser: "7 old" },
  ]);

  expect(
    await captureDesktop(workspaces, "bot", fills, BACKGROUND_CONTEXT),
  ).toEqual({ error: PASSWORD_MAY_SHOW });
  expect(captures(guest.commands)).toEqual([]);
});

test("a failed capture says why", async () => {
  const { workspaces, guest, holds } = fakeWorkspaces();
  guest.state.failCapture = true;

  const result = await captureDesktop(
    workspaces,
    "bot",
    fillsOf(),
    BACKGROUND_CONTEXT,
  );

  expect(result).toEqual({
    error: "The screenshot failed: import: unable to open X server `:1'",
  });
  expect([...guest.files.keys()]).toEqual([]);
  expect(holds).toEqual({ taken: 1, released: 1 });
});

const runtimes: AgentRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));

  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const makeAgent = (): Agent => ({
  ...agentInput
    .omit({ desktopModel: true, reviewModel: true })
    .parse({ name: "Test", tools: ["desktop"] }),
  avatar: defaultAvatarDefinition("test"),
  id: crypto.randomUUID(),
  // SAFETY: The faux provider is registered in the test model registry.
  provider: "faux" as never,
  model: "test",
  createdAt: "",
  updatedAt: "",
});

function chat(workspaces: ScreenshotWorkspaces) {
  const directory = mkdtempSync(join(tmpdir(), "crumble-screenshot-"));
  directories.push(directory);

  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "test", input: ["text", "image"] }],
  });

  const models = createModels();
  models.setProvider(faux.provider);

  const runtime = new AgentRuntime(
    directory,
    runtimeCallbacks({
      models,
      extensions: (agent) => [
        desktopScreenshotExtension(agent.id, workspaces, fillsOf()),
      ],
    }),
  );

  runtimes.push(runtime);

  return { runtime, faux };
}

test("the owner gets the screenshot in the chat, and the turn ends with it", async () => {
  const { workspaces } = fakeWorkspaces();
  const { runtime, faux } = chat(workspaces);
  const agent = makeAgent();
  const conversation = await runtime.openChat(agent);

  faux.setResponses([
    fauxAssistantMessage(
      [
        { type: "text", text: "Here is the desktop." },
        fauxToolCall(DESKTOP_SCREENSHOT_TOOL_NAME, {}),
      ],
      { stopReason: "toolUse" },
    ),
  ]);

  const submission = await runtime.submit(agent, conversation, "show me", "s");
  expect((await runtime.wait(submission, agent)).status).toBe("done");

  const { messages } = await runtime.snapshot(agent, conversation);
  const shown = messages.find((message) => message.role === "toolResult")!;

  expect(shown.toolName).toBe(DESKTOP_SCREENSHOT_TOOL_NAME);
  expect(shown.toolDetails).toEqual({ mimeType: "image/jpeg", size: 4 });
  expect(JSON.stringify(shown.blocks)).not.toContain(JPEG);
  // The tool ended the turn: nothing follows its result.
  expect(messages.at(-1)).toBe(shown);
  expect(latestMessagePreview(messages)).toBe("Desktop screenshot");

  const image = await runtime.attachment(agent, shown.entryId, 0);

  expect(image.mimeType).toBe("image/jpeg");
  expect(image.data.toString("base64")).toBe(JPEG);
  await expect(runtime.attachment(agent, shown.entryId, 1)).rejects.toThrow(
    "Attachment not found",
  );
});

test("a refused screenshot is an error the bot answers, with no image to read", async () => {
  const { workspaces } = fakeWorkspaces(false);
  const { runtime, faux } = chat(workspaces);
  const agent = makeAgent();
  const conversation = await runtime.openChat(agent);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(DESKTOP_SCREENSHOT_TOOL_NAME, {})], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("The desktop isn't running."),
  ]);

  const submission = await runtime.submit(agent, conversation, "show me", "s");
  expect((await runtime.wait(submission, agent)).status).toBe("done");

  const { messages } = await runtime.snapshot(agent, conversation);
  const refused = messages.find((message) => message.role === "toolResult")!;

  expect(refused.isError).toBe(true);
  expect(refused.content).toBe(DESKTOP_NOT_RUNNING);
  expect(messages.at(-1)?.content).toBe("The desktop isn't running.");
  await expect(runtime.attachment(agent, refused.entryId, 0)).rejects.toThrow(
    "Attachment not found",
  );
});
