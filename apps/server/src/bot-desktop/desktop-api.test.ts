import { expect, spyOn, test } from "bun:test";
import { Deferred, Effect, Layer } from "effect";
import type { WSEvents } from "hono/ws";
import { WSContext } from "hono/ws";
import type { BotsAccess } from "../bots/bots";
import { contractApp } from "../contract/api-contract";
import {
  BotWorkspaces,
  WorkspaceDesktopStartError,
  WorkspaceDesktopUnavailable,
  WorkspaceStreamError,
  type DesktopStream,
  type Workspaces,
} from "../workspaces/workspace";
import { BotDesktop, registerDesktopRoutes } from "./desktop-api";
import type { DesktopControlAccess } from "./desktop-control";
import { ViewerTickets } from "./desktop-viewer";

const control: DesktopControlAccess = {
  get: () => ({ holder: "bot", changes: 0, updatedAt: "" }),
  set: (_agentId, holder) => ({ holder, changes: 0, updatedAt: "" }),
  subscribe: () => () => {},
  subscribeAll: () => () => {},
  untilBot: async () => ({ holder: "bot", changes: 0, updatedAt: "" }),
};

function viewerService(openDesktop: Workspaces["openDesktop"]) {
  const workspaces: Workspaces = {
    desktop: true,
    env: () => Effect.die("No environment in this test"),
    restart: () => Effect.void,
    openDesktop,
    startDesktop: () => Effect.void,
    keepAwake: () => Effect.succeed(() => {}),
    sync: () => Effect.void,
    close: () => Effect.void,
  };

  return Effect.runSync(
    BotDesktop.pipe(
      Effect.provide(
        BotDesktop.layer.pipe(
          Layer.provide(Layer.succeed(BotWorkspaces, workspaces)),
        ),
      ),
    ),
  );
}

async function viewerConnection(desktopViewer: BotDesktop["Service"]) {
  const app = contractApp();
  const tickets = new ViewerTickets();
  const { ticket } = tickets.issue("bot-a");

  registerDesktopRoutes({
    app,
    register: () => {},
    // SAFETY: These tests redeem issued tickets without calling any bot API method.
    service: {} as BotsAccess,
    desktop: true,
    control,
    tickets,
    desktopViewer,
  });

  let events: WSEvents | undefined;

  await app.request(
    `/desktop-viewer/${ticket}/websockify`,
    {},
    {
      upgrade: (_request: Request, options: { data: { events: WSEvents } }) => {
        events = options.data.events;

        return true;
      },
    },
  );

  const closed = Promise.withResolvers<{
    code: number | undefined;
    reason: string | undefined;
  }>();

  const ws = new WSContext({
    send: () => {},
    close: (code, reason) => closed.resolve({ code, reason }),
    readyState: 1,
  });

  expect(events?.onOpen).toBeDefined();

  return { events, ws, closed: closed.promise };
}

test("a failed desktop open reports the failing operation instead of swallowing it", async () => {
  const failure = new WorkspaceDesktopStartError({
    agentId: "bot-a",
    backend: "fake",
    operation: "display",
    cause: new Error("guest desktop-start.sh failed: private-token"),
  });

  const logged = spyOn(console, "log").mockImplementation(() => {});

  try {
    const { events, ws, closed } = await viewerConnection(
      viewerService(() => Effect.fail(failure)),
    );

    events?.onOpen?.(new Event("open"), ws);

    const result = await closed;
    const logs = logged.mock.calls.flat().join(" ");

    expect(result.code).toBe(1011);
    expect(result.reason).toContain("desktop-start.sh");
    expect(result.reason).not.toContain("private-token");
    expect(logs).toContain("Bot desktop open failed");
    expect(logs).toContain("bot-a");
    expect(logs).toContain("WorkspaceDesktopStartError");
    expect(logs).toContain("guest desktop-start.sh failed");
  } finally {
    logged.mockRestore();
  }
});

test("missing desktop configuration gives a safe recovery instruction", async () => {
  const logged = spyOn(console, "log").mockImplementation(() => {});

  try {
    const { events, ws, closed } = await viewerConnection(
      viewerService((agentId) =>
        Effect.fail(new WorkspaceDesktopUnavailable({ agentId })),
      ),
    );

    events?.onOpen?.(new Event("open"), ws);

    expect((await closed).reason).toContain("CRUMBLE_WORKSPACE_DESKTOP_IMAGE");
  } finally {
    logged.mockRestore();
  }
});

test("unexpected desktop defects are logged without exposing their text to the viewer", async () => {
  const logged = spyOn(console, "log").mockImplementation(() => {});

  try {
    const { events, ws, closed } = await viewerConnection(
      viewerService(() => Effect.die(new Error("private-token"))),
    );

    events?.onOpen?.(new Event("open"), ws);

    const result = await closed;

    expect(result.code).toBe(1011);
    expect(result.reason).toContain("Check the server logs");
    expect(result.reason).not.toContain("private-token");
    expect(logged.mock.calls.flat().join(" ")).toContain("private-token");
  } finally {
    logged.mockRestore();
  }
});

test("closing a viewer during boot releases the stream when it arrives", async () => {
  const opening = Deferred.makeUnsafe<DesktopStream>();
  const released = Promise.withResolvers<void>();
  let closes = 0;
  let read = false;

  const { events, ws } = await viewerConnection(
    viewerService(() => Deferred.await(opening)),
  );

  events?.onOpen?.(new Event("open"), ws);
  events?.onClose?.(new CloseEvent("close"), ws);
  Deferred.doneUnsafe(
    opening,
    Effect.succeed({
      write: async () => {},
      output: (async function* () {
        read = true;
        yield new Uint8Array();
      })(),
      close: async () => {
        closes += 1;
        released.resolve();
      },
    }),
  );
  await released.promise;

  expect(closes).toBe(1);
  expect(read).toBe(false);
});

test("a late socat failure is logged and closes the viewer with a stream recovery instruction", async () => {
  const logged = spyOn(console, "log").mockImplementation(() => {});
  const released = Promise.withResolvers<void>();

  try {
    const { events, ws, closed } = await viewerConnection(
      viewerService(() =>
        Effect.succeed({
          write: async () => {},
          output: (async function* () {
            yield new TextEncoder().encode("RFB 003.008\n");
            throw new WorkspaceStreamError({
              agentId: "bot-a",
              backend: "fake",
              operation: "socat",
              cause: new Error("connection refused: private-token"),
            });
          })(),
          close: async () => released.resolve(),
        }),
      ),
    );

    events?.onOpen?.(new Event("open"), ws);

    const result = await closed;

    await released.promise;
    expect(result.code).toBe(1011);
    expect(result.reason).toContain("socat");
    expect(result.reason).not.toContain("private-token");
    expect(logged.mock.calls.flat().join(" ")).toContain(
      "WorkspaceStreamError",
    );
  } finally {
    logged.mockRestore();
  }
});
