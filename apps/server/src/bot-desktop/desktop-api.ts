import { types } from "node:util";
import { Effect, Predicate } from "effect";
import { upgradeWebSocket } from "@hono/bun";
import type { WSContext, WSEvents, WSMessageReceive } from "hono/ws";
import { routes } from "../contract/api-contract";
import type { contractApp } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { ControlState, DesktopControlAccess } from "./desktop-control";
import { bridgeDesktop, VIEWER_PREFIX, viewerPage } from "./desktop-viewer";
import type { Viewer, ViewerTickets } from "./desktop-viewer";
import type { BotLookup } from "../bot-ports/bot-lookup";
import type { DesktopStream, Workspaces } from "../workspaces/workspace";
import type { DesktopOpenError } from "../workspaces/workspace-errors";
import { Conflict } from "../shared/errors";
import { streamEvents } from "../shared/event-stream";
import type { Runner } from "../shared/runner";
import type { Agent } from "../contract/agents";
import { usesDesktop } from "../contract/tools";

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

const isBlobLike = (value: WSMessageReceive): value is Blob =>
  Predicate.isObject(value) && Predicate.isFunction(value["arrayBuffer"]);

const bytesOf = async (data: WSMessageReceive) => {
  if (Predicate.isUint8Array(data)) {
    return data;
  }

  if (types.isAnyArrayBuffer(data)) {
    return new Uint8Array(data);
  }

  if (isBlobLike(data)) {
    return new Uint8Array(await data.arrayBuffer());
  }

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

    if (!hasBotDesktop(agent)) {
      throw new Conflict({ message: "This bot has no bot desktop" });
    }

    return agent;
  };

  return { hasBotDesktop, desktopAgent };
}

type DesktopAccess = ReturnType<typeof desktopAccess>;

function registerControlRoutes(
  { register, service, workspaces, control }: DesktopRouteOptions,
  { hasBotDesktop, desktopAgent }: DesktopAccess,
) {
  register.plain(routes.desktopControl, (c) =>
    c.json(control.get(service.agent(c.req.param("id")).id), 200),
  );

  register.plain(routes.putDesktopControl, (c) => {
    const agent = desktopAgent(c.req.param("id"));

    return c.json(control.set(agent.id, c.req.valid("json").holder), 200);
  });

  register.plain(routes.desktopEvents, (c) => {
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

  register.plain(routes.desktopStatus, (c) => {
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
  register.plain(routes.createDesktopViewer, (c) => {
    const agent = desktopAgent(c.req.param("id"));
    const { passive = false } = c.req.valid("query");
    const { ticket, expiresAt } = tickets.issue(agent.id, passive);

    if (!passive && workspaces) {
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
    }

    return c.json({ path: `${VIEWER_PREFIX}/${ticket}`, expiresAt }, 201);
  });
}

function viewerSocket(
  { run, workspaces, control }: DesktopRouteOptions,
  { agentId, passive }: Pick<Viewer, "agentId" | "passive">,
): WSEvents {
  const pending: Array<Uint8Array> = [];
  let bridge: ReturnType<typeof bridgeDesktop> | undefined;
  let closed = false;

  return {
    onOpen: (_event, ws: WSContext) => {
      if (!workspaces) {
        ws.close(1011, UNAVAILABLE);

        return;
      }
      const attach = (stream: DesktopStream) => {
        if (closed) {
          return void stream.close();
        }

        bridge = bridgeDesktop({
          stream,
          allowInput: () => control.get(agentId).holder === "owner",
          send: (data) => ws.send(new Uint8Array(data)),
          close: () => ws.close(),
        });

        for (const data of pending.splice(0)) {
          bridge.receive(data);
        }
      };

      const fail = (reason: string) =>
        Effect.sync(() => ws.close(1011, reason));

      run.runFork(
        workspaces.openDesktop(agentId, { passive }).pipe(
          Effect.flatMap((stream) => Effect.sync(() => attach(stream))),
          Effect.tapCause((cause) =>
            Effect.logError("Opening a bot desktop failed", agentId, cause),
          ),
          Effect.catch((error) => fail(closeReason(error))),
          Effect.catchDefect(() => fail(UNAVAILABLE)),
        ),
      );
    },
    onMessage: (event) => {
      void bytesOf(event.data).then((data) => {
        if (!data) {
          return;
        }

        if (bridge) {
          bridge.receive(data);
        } else {
          pending.push(data);
        }
      });
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

    if (!tickets.peek(ticket)) {
      return c.notFound();
    }

    return c.html(viewerPage(ticket), 200, { "Cache-Control": "no-store" });
  });

  app.get(
    `${VIEWER_PREFIX}/:ticket/websockify`,
    async (c, next) => {
      const viewer = tickets.redeem(c.req.param("ticket"));

      if (!viewer || !workspaces) {
        return c.notFound();
      }

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

export function registerDesktopRoutes(options: DesktopRouteOptions) {
  const access = desktopAccess(options);

  registerControlRoutes(options, access);
  registerViewerLinkRoute(options, access);
  registerViewerRoutes(options);
}
