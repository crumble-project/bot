import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Sandbox } from "microsandbox";
import { createComputerUse } from "../src/computer-use";
import { desktopControlResponse } from "../src/api-responses";
import { MicrosandboxWorkspaces } from "../src/microsandbox-workspaces";
import { startServer } from "../src/server";
import { connectRfb } from "./fixtures/rfb-client";

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

  test("Chromium offers no session restore after a restart", async () => {
    await cu().run({ action: "capture" }, BACKGROUND_CONTEXT);
    // Chromium writes its profile some seconds after start; until then a stop leaves nothing to restore.
    await env().exec(
      "for i in $(seq 120); do test -f /workspace/.desktop/chromium/Default/Preferences && break; sleep 0.5; done",
      undefined,
      BACKGROUND_CONTEXT,
    );
    await workspaces.restart("desk", BACKGROUND_CONTEXT);
    const tool = cu();
    await Bun.sleep(3000);

    const tree = text(
      await tool.run({ action: "capture", full: true }, BACKGROUND_CONTEXT),
    );

    expect(tree).toContain("Chromium");
    expect(tree).not.toContain("Restore pages");
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

describe.skipIf(!vmTests)("watching and taking control", () => {
  const token = "w".repeat(40);
  const dataDir = mkdtempSync(path.join(tmpdir(), "crumble-viewer-"));
  const port = 7400 + (process.pid % 500);
  const base = `http://127.0.0.1:${port}`;

  const newWorkspaces = (idleTimeoutMs?: number) =>
    new MicrosandboxWorkspaces(IMAGE, {
      namePrefix,
      desktopImage: DESKTOP_IMAGE,
      wantsDesktop: () => true,
      ...(idleTimeoutMs && { idleTimeoutMs }),
    });

  let workspaces = newWorkspaces();
  let running: Awaited<ReturnType<typeof startServer>>;
  let agentId = "";

  const api = (route: string, init: RequestInit = {}) =>
    fetch(`${base}${route}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });

  const setControl = async (holder: "bot" | "owner") =>
    desktopControlResponse.parse(
      await (
        await api(`/v1/agents/${agentId}/desktop/control`, {
          method: "PUT",
          body: JSON.stringify({ holder }),
        })
      ).json(),
    );

  const viewer = async () => {
    const created = await api(`/v1/agents/${agentId}/desktop/viewer`, {
      method: "POST",
    });

    // SAFETY: The route returns the DesktopViewer schema.
    return ((await created.json()) as { path: string }).path;
  };

  const guest = async (command: string) => {
    let output = "";

    await workspaces
      .env(agentId)
      .exec(
        `. /run/crumble-desktop.env; ${command}`,
        { onOutput: (text) => (output += text) },
        BACKGROUND_CONTEXT,
      );

    return output.trim();
  };

  const pointerAt = async () =>
    (await guest("xdotool getmouselocation --shell"))
      .split("\n")
      .slice(0, 2)
      .map((line) => Number(line.split("=")[1]));

  beforeAll(async () => {
    running = await startServer({ dataDir, port, token, workspaces });

    const created = await api("/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Desk", tools: ["desktop"] }),
    });

    // SAFETY: The route returns the Agent schema.
    agentId = ((await created.json()) as { id: string }).id;
  }, 120_000);

  afterAll(async () => {
    await running?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("the owner watches through a single-use link, and watching lets no input through", async () => {
    const link = await viewer();

    expect((await fetch(`${base}${link}`)).status).toBe(200);

    const rfb = await connectRfb(`ws://127.0.0.1:${port}${link}/websockify`);

    expect(rfb.version).toStartWith("RFB 003.");
    rfb.clipboardCaps();
    expect(await rfb.smallUpdate()).toBe(true);

    await guest("xdotool mousemove 10 10");
    rfb.pointer(300, 300);
    await Bun.sleep(500);
    expect(await pointerAt()).toEqual([10, 10]);

    // The link is spent: a second connection is refused.
    await expect(
      connectRfb(`ws://127.0.0.1:${port}${link}/websockify`),
    ).rejects.toThrow();
    rfb.close();
  }, 120_000);

  test("taking control lets the owner's pointer and keyboard through", async () => {
    const rfb = await connectRfb(
      `ws://127.0.0.1:${port}${await viewer()}/websockify`,
    );

    expect(await setControl("owner")).toMatchObject({ holder: "owner" });

    rfb.pointer(300, 300);
    await Bun.sleep(500);
    expect(await pointerAt()).toEqual([300, 300]);

    // A focused GTK entry receives the owner's keys: "x", then Return closes the dialog with it.
    await guest(
      "rm -f /tmp/owner.out; (setsid zenity --entry --title Owner --text Key > /tmp/owner.out 2>/dev/null &); sleep 2; xdotool search --name '^Owner$' windowactivate --sync",
    );
    rfb.key(0x78, 0x2d);
    rfb.key(0xff0d, 0x1c);
    await Bun.sleep(1000);
    expect(await guest("cat /tmp/owner.out")).toBe("x");

    await setControl("bot");
    rfb.close();
  }, 120_000);

  test("a desktop job waits while the owner has control, and captures first after hand-back", async () => {
    const gate = {
      untilBot: async () => {
        for (;;) {
          const state = desktopControlResponse.parse(
            await (await api(`/v1/agents/${agentId}/desktop/control`)).json(),
          );

          if (state.holder === "bot") return state;

          await Bun.sleep(200);
        }
      },
    };

    const tool = createComputerUse(workspaces.env(agentId), gate);

    expect(
      (await tool.run({ action: "capture" }, BACKGROUND_CONTEXT)).isError,
    ).toBe(false);

    await setControl("owner");

    let done = false;

    const pending = tool
      .run({ action: "key", keys: "ctrl+l" }, BACKGROUND_CONTEXT)
      .then((result) => {
        done = true;

        return result;
      });

    await Bun.sleep(1500);
    expect(done).toBe(false);

    await setControl("bot");

    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("Capture before acting"),
    });
  }, 120_000);

  test("the owner keeps control across a server restart", async () => {
    await setControl("owner");
    await running.close();

    workspaces = newWorkspaces();
    running = await startServer({ dataDir, port, token, workspaces });

    const state = desktopControlResponse.parse(
      await (await api(`/v1/agents/${agentId}/desktop/control`)).json(),
    );

    expect(state.holder).toBe("owner");
    await setControl("bot");
  }, 180_000);

  test("a bot desktop the owner holds does not idle-stop", async () => {
    await running.close();
    workspaces = newWorkspaces(1500);
    running = await startServer({ dataDir, port, token, workspaces });

    await guest("true");
    await setControl("owner");
    await Bun.sleep(5000);
    expect((await Sandbox.get(workspaces.name(agentId))).status).toBe(
      "running",
    );

    await setControl("bot");
    await Bun.sleep(6000);
    expect((await Sandbox.get(workspaces.name(agentId))).status).toBe(
      "stopped",
    );
  }, 180_000);
});
