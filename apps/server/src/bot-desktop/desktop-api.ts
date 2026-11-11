import type { Register } from "../contract/route";
import { Effect } from "effect";
import { upgradeWebSocket } from "@hono/bun";
import type { WSContext, WSEvents, WSMessageReceive } from "hono/ws";
import { routes, type contractApp } from "../contract/api-contract";
import type { ControlState, DesktopControlAccess } from "./desktop-control";
import {
  bridgeDesktop,
  VIEWER_PREFIX,
  viewerPage,
  type Viewer,
  type ViewerTickets,
} from "./desktop-viewer";
import type { BotLookup } from "../bot-ports/bot-lookup";
import type { DesktopStream, Workspaces } from "../workspaces/workspace";
import type { DesktopOpenError } from "../workspaces/workspace-errors";
import { Conflict } from "../shared/errors";
import { streamEvents } from "../shared/event-stream";
import type { Runner } from "../shared/runner";
import type { Agent } from "../contract/agents";
import { usesDesktop } from "../contract/tools";

/**
 * WebSocket close reasons the viewer shows, at most 123 bytes each: they name what the owner can fix and carry no guest
 * output, which may hold secrets. The log has the cause.
 */
const closeReasons = {
  DesktopNotConfigured: "This server has no bot desktop image",
  DesktopNotEnabled: "This bot needs the desktop tool for its bot desktop",
  DesktopNotRunning: "The bot desktop is not running",
  WorkspaceBootFailed: "The bot's workspace did not start",
  DesktopStartFailed: "The bot desktop did not start",
  WorkspaceStreamFailed: "The bot desktop's socat relay did not start",
  WorkspaceUnreachable: "The bot's workspace is unreachable",
  WorkspacesClosed: "The server is shutting down",
  WorkspaceStopFailed: "The bot's previous machine did not stop",
} satisfies Record<DesktopOpenError["_tag"], string>;

const UNAVAILABLE = "The bot desktop is unavailable";

const closeReason = (error: DesktopOpenError) => closeReasons[error._tag];

const bytesOf = async (data: WSMessageReceive) => {
  if (data instanceof Uint8Array) return data;

  if (data instanceof ArrayBuffer) return new Uint8Array(data);

  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());

  return;
};

type DesktopRouteOptions = {
  app: ReturnType<typeof contractApp>;
  register: Register;
  service: BotLookup;
  run: Runner<never>;
  workspaces: Workspaces | undefined;
  control: DesktopControlAccess;
  tickets: ViewerTickets;
};

function desktopAccess({ service, workspaces }: DesktopRouteOptions) {
  const hasBotDesktop = (agent: Pick<Agent, "tools">) =>
    workspaces?.desktop === true && usesDesktop(agent);

  const desktopAgent = (id: string) => {
    const agent = service.agent(id);

    if (!hasBotDesktop(agent))
      throw new Conflict({ message: "This bot has no bot desktop" });

    return agent;
  };

  return { hasBotDesktop, desktopAgent };
}

type DesktopAccess = ReturnType<typeof desktopAccess>;

function registerControlRoutes(
  { register, service, workspaces, control }: DesktopRouteOptions,
  { hasBotDesktop, desktopAgent }: DesktopAccess,
) {
  register(routes.desktopControl, (c) =>
    c.json(control.get(service.agent(c.req.param("id")).id), 200),
  );

  register(routes.putDesktopControl, async (c) => {
    const agent = desktopAgent(c.req.param("id"));

    return c.json(control.set(agent.id, c.req.valid("json").holder), 200);
  });

  register(routes.desktopEvents, (c) => {
    const agent = service.agent(c.req.param("id"));

    return streamEvents(c, async ({ stream, close, onClose }) => {
      const send = (state: ControlState) =>
        stream
          .writeSSE({ event: "control", data: JSON.stringify(state) })
          .catch(close);

      onClose(
        control.subscribe(agent.id, (state) => {
          void send(state);
        }),
      );
      await send(control.get(agent.id));
    });
  });

  register(routes.desktopStatus, (c) => {
    const agent = service.agent(c.req.param("id"));

    return c.json(
      {
        running:
          hasBotDesktop(agent) && workspaces?.desktopRunning(agent.id) === true,
      },
      200,
    );
  });
}

function registerViewerLinkRoute(
  { register, run, workspaces, tickets }: DesktopRouteOptions,
  { desktopAgent }: DesktopAccess,
) {
  register(routes.createDesktopViewer, (c) => {
    const agent = desktopAgent(c.req.param("id"));
    const { passive = false } = c.req.valid("query");
    const { ticket, expiresAt } = tickets.issue(agent.id, passive);

    if (!passive && workspaces)
      run.runFork(
        workspaces
          .startDesktop(agent.id)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "Booting a bot desktop failed",
                agent.id,
                cause,
              ),
            ),
          ),
      );

    return c.json({ path: `${VIEWER_PREFIX}/${ticket}`, expiresAt }, 201);
  });
}

function viewerSocket(
  { run, workspaces, control }: DesktopRouteOptions,
  { agentId, passive }: Pick<Viewer, "agentId" | "passive">,
): WSEvents {
  const pending: Uint8Array[] = [];
  let bridge: ReturnType<typeof bridgeDesktop> | undefined;
  let closed = false;

  return {
    onOpen: (_event, ws: WSContext) => {
      const attach = (stream: DesktopStream) => {
        if (closed) return void stream.close();

        bridge = bridgeDesktop({
          stream,
          // Watching never lets input through; only the owner holding control does.
          allowInput: () => control.get(agentId).holder === "owner",
          // A copy: the WebSocket takes only bytes backed by a plain ArrayBuffer.
          send: (data) => ws.send(new Uint8Array(data)),
          close: () => ws.close(),
        });

        for (const data of pending.splice(0)) bridge.receive(data);
      };

      const fail = (reason: string) =>
        Effect.sync(() => ws.close(1011, reason));

      run.runFork(
        workspaces!.openDesktop(agentId, { passive }).pipe(
          Effect.flatMap((stream) => Effect.sync(() => attach(stream))),
          Effect.tapCause((cause) =>
            Effect.logError("Opening a bot desktop failed", agentId, cause),
          ),
          Effect.catch((error) => fail(closeReason(error))),
          Effect.catchDefect(() => fail(UNAVAILABLE)),
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
      void bridge?.close();
    },
  };
}

function registerViewerRoutes(options: DesktopRouteOptions) {
  const { app, workspaces, tickets } = options;
  const viewers = new WeakMap<Request, Viewer>();

  app.get(`${VIEWER_PREFIX}/:ticket`, (c) => {
    const ticket = c.req.param("ticket");

    if (!tickets.peek(ticket)) return c.notFound();

    return c.html(viewerPage(ticket), 200, { "Cache-Control": "no-store" });
  });

  app.get(
    `${VIEWER_PREFIX}/:ticket/websockify`,
    async (c, next) => {
      // Spent here, before the upgrade: a link opens one connection.
      const viewer = tickets.redeem(c.req.param("ticket"));

      if (!viewer || !workspaces) return c.notFound();

      viewers.set(c.req.raw, viewer);

      return next();
    },
    upgradeWebSocket((c) =>
      viewerSocket(
        options,
        viewers.get(c.req.raw) ?? { agentId: "", passive: true },
      ),
    ),
  );
}

/**
 * Routes for watching and taking control of a bot desktop. Control and viewer links are owner API; the viewer page,
 * its noVNC files, and its WebSocket live outside `/v1`, because a web view cannot send the bearer token there: the
 * single-use link is the credential.
 */
export function registerDesktopRoutes(options: DesktopRouteOptions) {
  const access = desktopAccess(options);

  registerControlRoutes(options, access);
  registerViewerLinkRoute(options, access);
  registerViewerRoutes(options);
}
