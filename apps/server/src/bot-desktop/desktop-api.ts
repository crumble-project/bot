import type { Register } from "../contract/route";
import { upgradeWebSocket } from "@hono/bun";
import { Cause, Context, Deferred, Effect, Layer, Match, Result } from "effect";
import { streamSSE } from "hono/streaming";
import type { WSContext, WSMessageReceive } from "hono/ws";
import {
  desktopControlInput,
  routes,
  type contractApp,
} from "../contract/api-contract";
import type { ControlState, DesktopControlAccess } from "./desktop-control";
import {
  bridgeDesktop,
  novncResponse,
  VIEWER_PREFIX,
  viewerPage,
  type ViewerTickets,
} from "./desktop-viewer";
import type { BotsAccess } from "../bots/bots";
import {
  BotWorkspaces,
  WorkspaceDesktopUnavailable,
  type DesktopStream,
  type WorkspaceError,
} from "../workspaces/workspace";
import { Conflict } from "../shared/errors";

const HEARTBEAT_MS = 15_000;

/** Opens viewer streams without waiting for the bot desktop's browser. */
export class BotDesktop extends Context.Service<
  BotDesktop,
  {
    readonly open: (
      agentId: string,
    ) => Effect.Effect<DesktopStream, WorkspaceError>;
    readonly start: (agentId: string) => Effect.Effect<void, WorkspaceError>;
  }
>()("crumble/bot-desktop/BotDesktop") {
  static readonly layer = Layer.effect(
    BotDesktop,
    Effect.gen(function* () {
      const workspaces = yield* BotWorkspaces;

      return BotDesktop.of({
        open: Effect.fn("BotDesktop.open")(function* (agentId) {
          if (!workspaces)
            return yield* new WorkspaceDesktopUnavailable({ agentId });

          const stream = yield* workspaces.openDesktop(agentId);
          let closing: Promise<void> | undefined;

          return {
            ...stream,
            close: () => (closing ??= stream.close()),
          };
        }),
        start: Effect.fn("BotDesktop.start")(function* (agentId) {
          if (!workspaces)
            return yield* new WorkspaceDesktopUnavailable({ agentId });

          yield* workspaces.startDesktop(agentId);
        }),
      });
    }),
  );
}

const desktopCloseReason = (error: WorkspaceError): string =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      WorkspaceDesktopUnavailable: () =>
        "Set CRUMBLE_WORKSPACE_DESKTOP_IMAGE on the server, then reopen the desktop.",
      WorkspaceDesktopDisabled: () =>
        "Enable this bot's desktop tool, then reopen the desktop.",
      WorkspaceDesktopStartError: () =>
        "Desktop startup failed. Check desktop-start.sh and the server logs.",
      WorkspaceBootError: () =>
        "Workspace boot failed. Check the workspace backend and server logs.",
      WorkspaceStreamError: () =>
        "Desktop stream failed. Check socat, Xvnc, and the server logs.",
      WorkspaceSetupError: () =>
        "Workspace setup failed. Check the guest image and server logs.",
      WorkspaceRelayError: () =>
        "Workspace relay failed. Check server resources and logs.",
      WorkspaceClosed: () =>
        "The server is shutting down. Reconnect after it restarts.",
      WorkspaceInvalidAgentId: () =>
        "Invalid bot ID. Request a new viewer link.",
      WorkspaceLivenessError: () =>
        "Workspace health check failed. Check the backend and server logs.",
      WorkspaceSyncError: () =>
        "Workspace checkpoint failed. Check storage and server logs before retrying.",
      WorkspaceStopError: () =>
        "Workspace stop failed. Check the backend and server logs before retrying.",
    }),
  );

const closeReason = (cause: Cause.Cause<WorkspaceError>) => {
  const error = Cause.findError(cause);

  return Result.isSuccess(error)
    ? desktopCloseReason(error.success)
    : "Unexpected desktop failure. Check the server logs, then reopen the desktop.";
};

const bytesOf = async (data: WSMessageReceive) => {
  if (data instanceof Uint8Array) return data;

  if (data instanceof ArrayBuffer) return new Uint8Array(data);

  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());

  return undefined;
};

/**
 * Routes for watching and taking control of a bot desktop. Control and viewer links are owner API; the viewer page,
 * its noVNC files, and its WebSocket live outside `/v1`, because a web view cannot send the bearer token there: the
 * single-use link is the credential.
 */
export function registerDesktopRoutes(options: {
  app: ReturnType<typeof contractApp>;
  register: Register;
  service: BotsAccess;
  /** Whether the server has a desktop workspace image. */
  desktop: boolean;
  control: DesktopControlAccess;
  tickets: ViewerTickets;
  desktopViewer?: BotDesktop["Service"];
}) {
  const { app, register, service, control, tickets } = options;
  // The bot of each viewer connection, from its redeemed ticket to its WebSocket.
  const viewers = new WeakMap<Request, string>();

  const desktopAgent = (id: string) => {
    const agent = service.agent(id);

    if (!options.desktop || !agent.tools.includes("desktop"))
      throw new Conflict({ message: "This bot has no bot desktop" });

    return agent;
  };

  register(routes.desktopControl, (c) =>
    c.json(control.get(service.agent(c.req.param("id")).id), 200),
  );

  register(routes.putDesktopControl, async (c) => {
    const agent = desktopAgent(c.req.param("id"));
    const input = desktopControlInput.parse(await c.req.json());

    return c.json(control.set(agent.id, input.holder), 200);
  });

  register(routes.desktopEvents, (c) => {
    const agent = service.agent(c.req.param("id"));

    return streamSSE(c, async (stream) => {
      let finish!: () => void;

      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });

      stream.onAbort(finish);

      const send = (state: ControlState) =>
        stream
          .writeSSE({ event: "control", data: JSON.stringify(state) })
          .catch(finish);

      const unsubscribe = control.subscribe(agent.id, (state) => {
        void send(state);
      });

      const timer = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(finish);
      }, HEARTBEAT_MS);

      try {
        await send(control.get(agent.id));
        await finished;
      } finally {
        clearInterval(timer);
        unsubscribe();
      }
    });
  });

  register(routes.createDesktopViewer, (c) => {
    const agent = desktopAgent(c.req.param("id"));
    const { ticket, expiresAt } = tickets.issue(agent.id);

    // The machine boots while the page loads; a failure is logged even if the viewer never connects.
    if (options.desktopViewer)
      Effect.runFork(
        options.desktopViewer
          .start(agent.id)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Bot desktop prewarm failed", agent.id, cause),
            ),
          ),
      );

    return c.json({ path: `${VIEWER_PREFIX}/${ticket}`, expiresAt }, 201);
  });

  app.get(
    `${VIEWER_PREFIX}/novnc/*`,
    async (c) => (await novncResponse(c.req.path)) ?? c.notFound(),
  );

  app.get(`${VIEWER_PREFIX}/:ticket`, (c) => {
    const ticket = c.req.param("ticket");

    if (!tickets.peek(ticket)) return c.notFound();

    return c.html(viewerPage(ticket), 200, { "Cache-Control": "no-store" });
  });

  app.get(
    `${VIEWER_PREFIX}/:ticket/websockify`,
    async (c, next) => {
      // Spent here, before the upgrade: a link opens one connection.
      const agentId = tickets.redeem(c.req.param("ticket"));

      if (!agentId || !options.desktopViewer) return c.notFound();

      viewers.set(c.req.raw, agentId);

      return next();
    },
    upgradeWebSocket((c) => {
      const agentId = viewers.get(c.req.raw) ?? "";
      const pending: Uint8Array[] = [];
      let bridge: ReturnType<typeof bridgeDesktop> | undefined;
      const finished = Deferred.makeUnsafe<void>();
      let closed = false;
      let failed = false;

      return {
        onOpen: (_event, ws: WSContext) => {
          const viewer = options.desktopViewer;

          if (!viewer) return;

          Effect.runFork(
            Effect.scoped(
              Effect.gen(function* () {
                const stream = yield* Effect.acquireRelease(
                  viewer.open(agentId),
                  (stream) =>
                    Effect.promise(() => stream.close()).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logError(
                          "Bot desktop stream close failed",
                          agentId,
                          cause,
                        ),
                      ),
                    ),
                );

                if (closed) return;

                bridge = bridgeDesktop({
                  stream,
                  agentId,
                  onError: (error) => {
                    failed = true;
                    Effect.runFork(
                      Effect.logError(
                        "Bot desktop stream failed",
                        agentId,
                        error,
                      ),
                    );
                    ws.close(1011, desktopCloseReason(error));
                  },
                  // Watching never lets input through; only the owner holding control does.
                  allowInput: () => control.get(agentId).holder === "owner",
                  // A copy: the WebSocket takes only bytes backed by a plain ArrayBuffer.
                  send: (data) => ws.send(new Uint8Array(data)),
                  close: () => {
                    Deferred.doneUnsafe(finished, Effect.void);

                    if (!failed) ws.close();
                  },
                });

                for (const data of pending.splice(0)) bridge.receive(data);

                yield* Deferred.await(finished);
              }),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  yield* Effect.logError(
                    "Bot desktop open failed",
                    agentId,
                    cause,
                  );
                  ws.close(1011, closeReason(cause));
                }),
              ),
            ),
          );
        },
        onMessage: async (event) => {
          const data = await bytesOf(event.data);

          if (!data) return;

          if (bridge) bridge.receive(data);
          else pending.push(data);
        },
        onClose: () => {
          closed = true;
          pending.length = 0;
          Deferred.doneUnsafe(finished, Effect.void);
        },
      };
    }),
  );
}
