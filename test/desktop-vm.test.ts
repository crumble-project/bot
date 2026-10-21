import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Sandbox } from "microsandbox";
import { createComputerUse } from "../src/computer-use";
import { MicrosandboxWorkspaces } from "../src/microsandbox-workspaces";

const IMAGE = process.env.CRUMBLE_WORKSPACE_IMAGE ?? "";
const DESKTOP_IMAGE = process.env.CRUMBLE_WORKSPACE_DESKTOP_IMAGE ?? "";

const vmTests =
  process.env.CRUMBLE_VM_TESTS === "1" && IMAGE !== "" && DESKTOP_IMAGE !== "";

const namePrefix = `crumble-desktop-test-${process.pid}`;

const page = readFileSync(
  path.join(import.meta.dir, "fixtures", "desktop-task.html"),
  "utf8",
);

describe.skipIf(!vmTests)("bot desktop in a VM", () => {
  const desktopBots = new Set(["desk"]);

  const workspaces = new MicrosandboxWorkspaces(IMAGE, {
    namePrefix,
    desktopImage: DESKTOP_IMAGE,
    wantsDesktop: (agentId) => desktopBots.has(agentId),
  });

  afterAll(() => workspaces.close(BACKGROUND_CONTEXT));

  const env = () => workspaces.env("desk");
  const cu = () => createComputerUse(env());

  const text = (r: { content: { type: string; text?: string }[] }) =>
    r.content.flatMap((c) => (c.type === "text" ? [c.text!] : [])).join("\n");

  const indexOf = (tree: string, pattern: RegExp) =>
    Number(
      tree
        .split("\n")
        .find((l) => pattern.test(l))!
        .match(/\[(\d+)\]/)![1],
    );

  test("opens a page, fills the form, and reads the result back", async () => {
    await env().writeFile("/workspace/task.html", page, BACKGROUND_CONTEXT);
    const tool = cu();

    await tool.run({ action: "key", keys: "ctrl+l" }, BACKGROUND_CONTEXT);
    await tool.run(
      { action: "type", text: "file:///workspace/task.html" },
      BACKGROUND_CONTEXT,
    );
    await tool.run({ action: "key", keys: "return" }, BACKGROUND_CONTEXT);
    await Bun.sleep(1500);

    const tree = text(
      await tool.run({ action: "capture", full: true }, BACKGROUND_CONTEXT),
    );

    await tool.run(
      {
        action: "set_value",
        element: indexOf(tree, /entry "Name"/),
        value: "Ada Lovelace",
      },
      BACKGROUND_CONTEXT,
    );
    await tool.run(
      { action: "click", element: indexOf(tree, /combo box "City"/) },
      BACKGROUND_CONTEXT,
    );
    await tool.run({ action: "type", text: "Berlin" }, BACKGROUND_CONTEXT);
    await tool.run({ action: "key", keys: "return" }, BACKGROUND_CONTEXT);
    await tool.run(
      { action: "click", element: indexOf(tree, /check box "Agree"/) },
      BACKGROUND_CONTEXT,
    );

    const after = await tool.run(
      {
        action: "click",
        element: indexOf(tree, /button "Submit"/),
        capture_after: true,
      },
      BACKGROUND_CONTEXT,
    );

    expect(text(after)).toContain("Ada Lovelace|Berlin|yes");
  }, 120_000);

  test("operates a native GTK dialog", async () => {
    await env().exec(
      ". /run/crumble-desktop.env; rm -f /tmp/z.out; (setsid zenity --entry --title Ask --text Name > /tmp/z.out &); sleep 2",
      undefined,
      BACKGROUND_CONTEXT,
    );
    const tool = cu();

    const windows = text(
      await tool.run({ action: "list_windows" }, BACKGROUND_CONTEXT),
    );

    const id = Number(
      windows
        .split("\n")
        .find((l) => l.includes('"Ask"'))!
        .split(" ")[0],
    );

    const tree = text(
      await tool.run(
        { action: "capture", window_id: id, full: true },
        BACKGROUND_CONTEXT,
      ),
    );

    await tool.run(
      {
        action: "set_value",
        window_id: id,
        element: indexOf(tree, /text box/),
        value: "Ada",
      },
      BACKGROUND_CONTEXT,
    );
    await tool.run(
      { action: "click", window_id: id, element: indexOf(tree, /button "OK"/) },
      BACKGROUND_CONTEXT,
    );
    await Bun.sleep(500);

    let out = "";
    await env().exec(
      "cat /tmp/z.out",
      { onOutput: (t) => (out += t) },
      BACKGROUND_CONTEXT,
    );
    expect(out.trim()).toBe("Ada");
  }, 60_000);

  test("browser state and files survive a restart", async () => {
    await env().writeFile("/workspace/keep.txt", "kept", BACKGROUND_CONTEXT);
    await workspaces.restart("desk", BACKGROUND_CONTEXT);

    let out = "";
    await env().exec(
      "cat /workspace/keep.txt; echo; test -d /workspace/.desktop/chromium/Default && echo profile",
      { onOutput: (t) => (out += t) },
      BACKGROUND_CONTEXT,
    );
    expect(out).toContain("kept");
    // Chromium's profile, with its cookies and logins, lives in the workspace.
    expect(out).toContain("profile");
  }, 120_000);

  test("a bot without the desktop tool boots the base image", async () => {
    let out = "";
    await workspaces
      .env("plain")
      .exec(
        "command -v cua-driver || echo none",
        { onOutput: (t) => (out += t) },
        BACKGROUND_CONTEXT,
      );
    expect(out.trim()).toBe("none");
  }, 120_000);

  test("a desktop stream speaks RFB and keeps the machine awake until closed", async () => {
    const idle = new MicrosandboxWorkspaces(IMAGE, {
      namePrefix,
      idleTimeoutMs: 500,
      desktopImage: DESKTOP_IMAGE,
      wantsDesktop: () => true,
    });

    try {
      const stream = await idle.openDesktop("stream", BACKGROUND_CONTEXT);
      const first = await stream.output[Symbol.asyncIterator]().next();

      expect(new TextDecoder().decode(first.value)).toStartWith("RFB 003.");

      await Bun.sleep(3000);
      expect((await Sandbox.get(idle.name("stream"))).status).toBe("running");

      await stream.close();
      await Bun.sleep(5000);
      expect((await Sandbox.get(idle.name("stream"))).status).toBe("stopped");
    } finally {
      await idle.close(BACKGROUND_CONTEXT);
    }
  }, 120_000);

  test("a bot without its bot desktop gets no desktop stream", async () => {
    await expect(
      workspaces.openDesktop("plain-stream", BACKGROUND_CONTEXT),
    ).rejects.toThrow("no bot desktop");
  }, 120_000);
});
