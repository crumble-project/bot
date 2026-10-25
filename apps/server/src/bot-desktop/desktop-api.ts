import type { Register } from "../contract/route";
import { upgradeWebSocket } from "@hono/bun";
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
import { AppError } from "../shared/domain";
import type { BotsAccess } from "../bots/bots";
import type { DesktopStream } from "../workspaces/workspace";

const HEARTBEAT_MS = 15_000;

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
  openDesktop?: (agentId: string) => Promise<DesktopStream>;
  startDesktop?: (agentId: string) => Promise<void>;
}) {
  const { app, register, service, control, tickets } = options;
  // The bot of each viewer connection, from its redeemed ticket to its WebSocket.
  const viewers = new WeakMap<Request, string>();

  const desktopAgent = (id: string) => {
    const agent = service.agent(id);

    if (!options.desktop || !agent.tools.includes("desktop"))
      throw new AppError(409, "This bot has no bot desktop");

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

    // The machine boots while the client loads the page; the viewer's WebSocket reports any failure.
    void options.startDesktop?.(agent.id).catch(() => undefined);

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

      if (!agentId || !options.openDesktop) return c.notFound();

      viewers.set(c.req.raw, agentId);

      return next();
    },
    upgradeWebSocket((c) => {
      const agentId = viewers.get(c.req.raw) ?? "";
      const pending: Uint8Array[] = [];
      let bridge: ReturnType<typeof bridgeDesktop> | undefined;
      let closed = false;

      return {
        onOpen: (_event, ws: WSContext) => {
          void options.openDesktop!(agentId)
            .then((stream) => {
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
            })
            .catch(() => ws.close(1011, "The bot desktop is unavailable"));
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
    }),
  );
}
