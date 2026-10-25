import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Effect, Predicate } from "effect";
import { startServer } from "../app/server";
import {
  DesktopNotConfigured,
  DesktopStartError,
  DesktopStreamError,
  MachineBootError,
  PlainWorkspaceImage,
  WorkspacesClosed,
  type DesktopOpenError,
  type Workspaces,
} from "../workspaces/workspace";
import { desktopCloseReason } from "./desktop-api";
import { bridgeDesktop, ViewerTickets, viewerPage } from "./desktop-viewer";

test("a ticket is redeemed once, and not after it expires", () => {
  let now = 0;
  const tickets = new ViewerTickets(() => now);
  const { ticket } = tickets.issue("bot-a");

  expect(tickets.redeem(ticket)).toBe("bot-a");
  expect(tickets.redeem(ticket)).toBeUndefined();

  const late = tickets.issue("bot-a").ticket;
  now = 61_000;
  expect(tickets.redeem(late)).toBeUndefined();
});

test("the viewer page connects to its ticket's stream and loads noVNC from the server", () => {
  const page = viewerPage("abc");

  expect(page).toContain("/desktop-viewer/novnc/core/rfb.js");
  expect(page).toContain("/desktop-viewer/abc/websockify");
});

test("the bridge filters the viewer's input and forwards the desktop's output", async () => {
  const toViewer: Uint8Array[] = [];
  const toDesktop: Uint8Array[] = [];
  let allowed = false;

  async function* output() {
    yield new TextEncoder().encode("RFB 003.008\n");
  }

  const bridge = bridgeDesktop({
    stream: {
      write: async (d) => void toDesktop.push(d),
      output: output(),
      close: async () => {},
    },
    allowInput: () => allowed,
    send: (d) => toViewer.push(d),
    close: () => {},
  });

  bridge.receive(
    new Uint8Array([...new TextEncoder().encode("RFB 003.008\n"), 1, 1]),
  );
  bridge.receive(new Uint8Array([5, 0, 0, 1, 0, 1]));
  allowed = true;
  bridge.receive(new Uint8Array([5, 0, 0, 2, 0, 2]));
  await Bun.sleep(10);

  expect(new TextDecoder().decode(toViewer[0])).toBe("RFB 003.008\n");
  expect(toDesktop.map((d) => d[0])).toEqual([82, 5]); // handshake ("R..."), then only the allowed pointer event
  await bridge.close();
});

test("a failed desktop open logs the cause and closes the viewer WebSocket with a specific reason", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "crumble-viewer-fail-"));
  const logged: string[] = [];
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  console.log = (...args: unknown[]) => {
    logged.push(
      args
        .map((arg) => (Predicate.isString(arg) ? arg : JSON.stringify(arg)))
        .join(" "),
    );
  };

  console.error = (...args: unknown[]) => {
    logged.push(
      args
        .map((arg) => (Predicate.isString(arg) ? arg : JSON.stringify(arg)))
        .join(" "),
    );
  };

  let currentFailure: DesktopOpenError = new DesktopStartError({
    agentId: "bot-a",
    message:
      "/opt/crumble/desktop-start.sh --display failed: Xvnc died (token=secret-token-123)",
  });

  const workspaces: Workspaces = {
    desktop: true,
    env: () => {
      throw new Error("unused");
    },
    restart: () => Effect.void,
    openDesktop: () => Effect.fail(currentFailure),
    startDesktop: () => Effect.fail(currentFailure),
    keepAwake: () => Effect.succeed(() => {}),
    sync: () => Effect.void,
    close: Effect.void,
  };

  let running: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    running = await startServer({
      dataDir,
      port: 0,
      workspaces: () => workspaces,
    });

    const signUp = await fetch(
      new URL("/api/auth/sign-up/email", running.server.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Viewer owner",
          email: `viewer-${crypto.randomUUID()}@example.test`,
          password: "correct horse battery staple",
        }),
      },
    );

    // SAFETY: Better Auth returns a token on successful bearer sign-up.
    const { token } = (await signUp.json()) as { token: string };

    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const created = await fetch(new URL("/v1/agents", running.server.url), {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Desk", tools: ["desktop"] }),
    });

    // SAFETY: The agent route returns the Agent schema.
    const { id: agentId } = (await created.json()) as { id: string };

    const cases: Array<{
      error: DesktopOpenError;
      expectedReason: string;
    }> = [
      {
        error: new DesktopNotConfigured({
          message: "No desktop image configured",
        }),
        expectedReason:
          "Set CRUMBLE_WORKSPACE_DESKTOP_IMAGE to enable bot desktops",
      },
      {
        error: new PlainWorkspaceImage({
          agentId,
          image: "crumble-workspace:dev",
          message: "This bot has no bot desktop",
        }),
        expectedReason: "Enable the desktop tool on this bot first",
      },
      {
        error: new MachineBootError({
          backend: "microsandbox",
          agentId,
          message: "Sandbox start failed with token=secret-token-123",
        }),
        expectedReason: "Failed to start the microsandbox workspace machine",
      },
      {
        error: new DesktopStartError({
          agentId,
          message:
            "/opt/crumble/desktop-start.sh --display failed: Xvnc died (token=secret-token-123)",
        }),
        expectedReason: "The bot desktop failed to start in the workspace",
      },
      {
        error: new DesktopStreamError({
          command: "socat",
          message: "socat has no stdin (token=secret-token-123)",
        }),
        expectedReason: "Failed to connect to the bot desktop VNC server",
      },
      {
        error: new WorkspacesClosed({
          message: "Workspaces are closed",
        }),
        expectedReason: "The workspace server is shutting down",
      },
    ];

    for (const { error, expectedReason } of cases) {
      currentFailure = error;
      logged.length = 0;

      const viewer = await fetch(
        new URL(`/v1/agents/${agentId}/desktop/viewer`, running.server.url),
        { method: "POST", headers },
      );

      // SAFETY: The viewer route returns the DesktopViewer schema.
      const { path } = (await viewer.json()) as { path: string };

      const closed = await new Promise<{ code: number; reason: string }>(
        (resolve, reject) => {
          const socket = new WebSocket(
            new URL(
              `${path}/websockify`,
              running!.server.url.href.replace("http", "ws"),
            ),
          );

          socket.addEventListener("close", (event) => {
            resolve({ code: event.code, reason: event.reason });
          });
          socket.addEventListener("error", () =>
            reject(new Error("WebSocket error")),
          );
        },
      );

      expect(closed.code).toBe(1011);
      expect(closed.reason).toBe(expectedReason);
      expect(closed.reason).toBe(desktopCloseReason(error));
      expect(closed.reason).not.toContain("secret-token-123");
      expect(Buffer.byteLength(closed.reason, "utf8")).toBeLessThanOrEqual(123);

      const serializedLogs = logged.join("\n");
      expect(serializedLogs).toContain(error._tag);
      expect(serializedLogs).toContain(error.message);
    }
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    await running?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
