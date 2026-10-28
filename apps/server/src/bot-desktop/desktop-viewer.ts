import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RfbProtocolError, rfbFilter } from "./rfb-filter";
import type { DesktopStream } from "../workspaces/workspace";

/** How long an issued viewer link stays valid before its WebSocket connects. */
export const VIEWER_TICKET_MS = 60_000;

/** The URL prefix of viewer pages, their WebSockets, and the noVNC files; outside `/v1` and its bearer auth. */
export const VIEWER_PREFIX = "/desktop-viewer";

const NOVNC = path.dirname(
  fileURLToPath(import.meta.resolve("@novnc/novnc/package.json")),
);

// The viewer page imports only noVNC's core library and the zlib port it bundles.
const SERVED = ["core/", "vendor/"];

/** A noVNC file under the package's core or vendor directory, or undefined for any other path. */
function novncFile(requested: string) {
  const relative = path.posix.normalize(decodeURIComponent(requested));

  if (
    !relative.endsWith(".js") ||
    !SERVED.some((prefix) => relative.startsWith(prefix))
  )
    return undefined;

  const file = path.resolve(NOVNC, relative);

  return file.startsWith(`${NOVNC}${path.sep}`) ? file : undefined;
}

/** The noVNC file a viewer page asks for at `requestPath`; public library code, so no sign-in is needed. */
export async function novncResponse(requestPath: string) {
  const prefix = `${VIEWER_PREFIX}/novnc/`;

  if (!requestPath.startsWith(prefix)) return undefined;
  const file = novncFile(requestPath.slice(prefix.length));
  const content = file && (await readFile(file).catch(() => undefined));

  return content
    ? new Response(new Uint8Array(content), {
        headers: { "Content-Type": "text/javascript; charset=utf-8" },
      })
    : undefined;
}

/** The account a ticket was issued in, from its `<account>.<secret>` form; the server routes the link there. */
export const ticketOwner = (ticket: string) =>
  /^([A-Za-z0-9_-]{1,128})\.[A-Za-z0-9_-]+$/.exec(ticket)?.[1];

/** Whom a viewer link shows, and whether it only watches: no boot, no keeping the machine awake. */
export type Viewer = { agentId: string; passive: boolean };

/**
 * Single-use viewer links. A web view cannot add the owner's bearer token to a WebSocket, so the ticket in the URL is
 * the credential: issued to the authenticated owner, valid for a minute, and spent when its WebSocket connects.
 */
export class ViewerTickets {
  private readonly tickets = new Map<
    string,
    { viewer: Viewer; expires: number }
  >();

  /** `owner` names the account in each ticket, so a link opens without the account's session. */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly owner?: string,
  ) {}

  issue(agentId: string, passive = false) {
    this.prune();

    const secret = randomBytes(32).toString("base64url");
    const ticket = this.owner ? `${this.owner}.${secret}` : secret;
    const expires = this.now() + VIEWER_TICKET_MS;

    this.tickets.set(ticket, { viewer: { agentId, passive }, expires });

    return { ticket, expiresAt: new Date(expires).toISOString() };
  }

  /** The viewer the ticket was issued for, if it is valid; the page may load it before the WebSocket redeems it. */
  peek(ticket: string) {
    const entry = this.tickets.get(ticket);

    return entry && entry.expires > this.now() ? entry.viewer : undefined;
  }

  /** The viewer the ticket was issued for, once: the ticket is spent whether or not it was still valid. */
  redeem(ticket: string) {
    const viewer = this.peek(ticket);

    this.tickets.delete(ticket);

    return viewer;
  }

  private prune() {
    const now = this.now();

    for (const [ticket, entry] of this.tickets)
      if (entry.expires <= now) this.tickets.delete(ticket);
  }
}

/**
 * The viewer page: noVNC filling the window, connected to the ticket's stream, under a loading screen until the first
 * frame. The app draws its own controls.
 */
export function viewerPage(ticket: string) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Bot desktop</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; } #screen { width: 100vw; height: 100vh; }
  #status { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; color: rgb(255 255 255 / 0.6); font: 13px/1.4 system-ui, sans-serif; -webkit-font-smoothing: antialiased;
    pointer-events: none; animation: appear 300ms ease-out 300ms both; transition: opacity 250ms ease-out; }
  #status.done { opacity: 0; }
  #spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid rgb(255 255 255 / 0.15);
    border-top-color: rgb(255 255 255 / 0.7); animation: spin 0.9s linear infinite; }
  #status.failed #spinner { display: none; }
  @keyframes spin { to { transform: rotate(1turn); } }
  @keyframes appear { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { #spinner { animation: none; } }
</style>
</head><body><div id="screen"></div>
<div id="status" role="status"><div id="spinner"></div><div id="message">Starting the bot desktop</div></div>
<script type="module">
  import RFB from "${VIEWER_PREFIX}/novnc/core/rfb.js";
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const rfb = new RFB(document.getElementById("screen"), \`\${scheme}://\${location.host}${VIEWER_PREFIX}/${ticket}/websockify\`);
  const status = document.getElementById("status");
  let connected = false;
  rfb.scaleViewport = true;
  rfb.background = "#000";
  rfb.addEventListener("connect", () => {
    connected = true;
    status.classList.add("done");
  });
  rfb.addEventListener("disconnect", () => {
    document.title = "Bot desktop (disconnected)";
    if (connected) return;
    status.classList.add("failed");
    document.getElementById("message").textContent = "The bot desktop is unavailable";
  });
</script></body></html>
`;
}

/**
 * Bridges a viewer's WebSocket to the bot desktop's VNC server. The viewer's input passes only while `allowInput()`
 * holds; anything the filter cannot parse closes the connection.
 */
export function bridgeDesktop(options: {
  stream: DesktopStream;
  allowInput: () => boolean;
  send: (data: Uint8Array) => void;
  close: () => void;
}) {
  const { stream } = options;
  const filter = rfbFilter(options.allowInput);
  let closed = false;

  const close = async () => {
    if (closed) return;

    closed = true;
    options.close();
    await stream.close();
  };

  void (async () => {
    for await (const chunk of stream.output) options.send(chunk);
  })()
    .catch(() => undefined)
    .finally(() => void close());

  return {
    receive(data: Uint8Array) {
      if (closed) return;

      try {
        const passed = filter.push(data);

        if (passed.length) void stream.write(passed).catch(() => void close());
      } catch (error) {
        if (error instanceof RfbProtocolError) void close();
        else throw error;
      }
    },
    close,
  };
}
