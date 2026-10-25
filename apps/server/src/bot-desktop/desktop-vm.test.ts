import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Effect } from "effect";
import { createComputerUse } from "./computer-use";
import { desktopControlResponse } from "../contract/api-responses";
import { startServer } from "../app/server";
import { connectRfb } from "../../test/fixtures/rfb-client";
import {
  WORKSPACE_BACKENDS,
  eventually,
} from "../../test/fixtures/workspace-backends";

const namePrefix = `crumble-desktop-test-${process.pid}`;

const page = readFileSync(
  path.join(import.meta.dir, "../../test/fixtures/desktop-task.html"),
  "utf8",
);

for (const backend of WORKSPACE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`bot desktop on ${backend.name}`, () => {
    const desktopBots = new Set(["desk"]);

    const { workspaces } = backend.create({
      namePrefix,
      wantsDesktop: (agentId) => desktopBots.has(agentId),
    });

    beforeAll(async () => {
      await workspaces.env("desk").exec("true", undefined, BACKGROUND_CONTEXT);
    }, backend.firstBootTimeoutMs);

    afterAll(async () => {
      await Effect.runPromise(workspaces.close);
      await backend.cleanup(namePrefix);
    }, 120_000);

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

      // The capture can come before the page updates on a remote machine; capture again until it shows.
      expect(
        text(after).includes("Ada Lovelace|Berlin|yes") ||
          (await eventually(async () =>
            text(
              await tool.run({ action: "capture" }, BACKGROUND_CONTEXT),
            ).includes("Ada Lovelace|Berlin|yes"),
          )),
      ).toBe(true);
    }, 120_000);

    test("operates a native GTK dialog", async () => {
      await env().exec(
        ". /run/crumble-desktop.env; rm -f /tmp/z.out; (setsid zenity --entry --title Ask --text Name > /tmp/z.out &); for i in $(seq 60); do xdotool search --name '^Ask$' >/dev/null && break; sleep 0.25; done",
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

      let tree = "";

      // The window maps before its accessibility tree fills in on a remote machine.
      await eventually(async () => {
        tree = text(
          await tool.run(
            { action: "capture", window_id: id, full: true },
            BACKGROUND_CONTEXT,
          ),
        );

        return /text box/.test(tree) && /button "OK"/.test(tree);
      });

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
        {
          action: "click",
          window_id: id,
          element: indexOf(tree, /button "OK"/),
        },
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
      await Effect.runPromise(workspaces.restart("desk"));

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
      await Effect.runPromise(workspaces.restart("desk"));
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
      const { workspaces: idle, isRunning } = backend.create({
        namePrefix,
        idleTimeoutMs: 500,
        wantsDesktop: () => true,
      });

      try {
        const stream = await Effect.runPromise(idle.openDesktop("stream"));

        const first = await stream.output[Symbol.asyncIterator]().next();

        expect(new TextDecoder().decode(first.value)).toStartWith("RFB 003.");

        await Bun.sleep(3000);
        expect(await isRunning("stream")).toBe(true);

        await stream.close();
        expect(await eventually(async () => !(await isRunning("stream")))).toBe(
          true,
        );
      } finally {
        await Effect.runPromise(idle.close);
      }
    }, 120_000);

    test("a bot without its bot desktop gets no desktop stream", async () => {
      await expect(
        Effect.runPromise(workspaces.openDesktop("plain-stream")),
      ).rejects.toThrow("no bot desktop");
    }, 120_000);
  });

  describe.skipIf(!backend.enabled)(
    `watching and taking control on ${backend.name}`,
    () => {
      let token = "";
      const dataDir = mkdtempSync(path.join(tmpdir(), "crumble-viewer-"));
      const port = 7400 + (process.pid % 500);
      const base = `http://127.0.0.1:${port}`;

      const newWorkspaces = (idleTimeoutMs?: number) =>
        backend.create({
          namePrefix,
          wantsDesktop: () => true,
          ...(idleTimeoutMs && { idleTimeoutMs }),
        });

      let { workspaces, isRunning } = newWorkspaces();
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
        running = await startServer({
          dataDir,
          port,
          workspaces: () => workspaces,
        });

        const auth = await fetch(`${base}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Desktop owner",
            email: `desktop-${process.pid}@example.test`,
            password: "correct horse battery staple",
          }),
        });

        expect(auth.status).toBe(200);
        // SAFETY: Better Auth returns a token on successful bearer sign-up.
        token = ((await auth.json()) as { token: string }).token;

        const created = await api("/v1/agents", {
          method: "POST",
          body: JSON.stringify({ name: "Desk", tools: ["desktop"] }),
        });

        // SAFETY: The route returns the Agent schema.
        agentId = ((await created.json()) as { id: string }).id;
      }, 120_000);

      afterAll(async () => {
        await running?.close();
        await backend.cleanup(namePrefix);
        rmSync(dataDir, { recursive: true, force: true });
      }, 120_000);

      test("the owner watches through a single-use link, and watching lets no input through", async () => {
        const link = await viewer();

        expect((await fetch(`${base}${link}`)).status).toBe(200);

        const rfb = await connectRfb(
          `ws://127.0.0.1:${port}${link}/websockify`,
        );

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
          "rm -f /tmp/owner.out; (setsid zenity --entry --title Owner --text Key > /tmp/owner.out 2>/dev/null &); for i in $(seq 60); do xdotool search --name '^Owner$' >/dev/null && break; sleep 0.25; done; xdotool search --name '^Owner$' windowactivate --sync",
        );
        rfb.key(0x78, 0x2d);
        rfb.key(0xff0d, 0x1c);

        try {
          expect(
            await eventually(
              async () => (await guest("cat /tmp/owner.out")) === "x",
              10_000,
            ),
          ).toBe(true);
        } finally {
          await setControl("bot");
          rfb.close();
        }
      }, 120_000);

      test("a desktop job waits while the owner has control, and captures first after hand-back", async () => {
        const gate = {
          untilBot: async () => {
            for (;;) {
              const state = desktopControlResponse.parse(
                await (
                  await api(`/v1/agents/${agentId}/desktop/control`)
                ).json(),
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

        ({ workspaces, isRunning } = newWorkspaces());
        running = await startServer({
          dataDir,
          port,
          workspaces: () => workspaces,
        });

        const state = desktopControlResponse.parse(
          await (await api(`/v1/agents/${agentId}/desktop/control`)).json(),
        );

        expect(state.holder).toBe("owner");
        await setControl("bot");
      }, 180_000);

      test("a bot desktop the owner holds does not idle-stop", async () => {
        await running.close();
        ({ workspaces, isRunning } = newWorkspaces(1500));
        running = await startServer({
          dataDir,
          port,
          workspaces: () => workspaces,
        });

        await guest("true");
        await setControl("owner");
        await Bun.sleep(5000);
        expect(await isRunning(agentId)).toBe(true);

        await setControl("bot");
        expect(await eventually(async () => !(await isRunning(agentId)))).toBe(
          true,
        );
      }, 180_000);
    },
  );
}
