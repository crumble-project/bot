import dns from "node:dns/promises";
import net from "node:net";
import { isPublicAddress } from "../shared/public-address";
import { readHttpHost, readSni, validPort } from "./workspace-proxy-protocol";

export type WorkspaceInterceptor = {
  wants(host: string): boolean;
  answers?(host: string): boolean;
  /** The client socket is positioned at the start of its TLS ClientHello. */
  handle(client: net.Socket, host: string, port: number): Promise<void>;
};

export type WorkspaceProxyOptions = {
  lookup?: (host: string) => Promise<string[]>;
  isPublicAddress?: (address: string) => boolean;
  firstByteTimeoutMs?: number;
  /** Listen on this port, so a restarted machine finds its proxy at the address it was created with. */
  port?: number;
  intercept?: WorkspaceInterceptor | undefined;
};

export type WorkspaceProxy = { address: string; close(): Promise<void> };

const lookupAll = async (host: string) =>
  (await dns.lookup(host, { all: true })).map((entry) => entry.address);

const MAX_HEADER_BYTES = 65_536;

/** The CONNECT address is untrusted; dial only the public address resolved from the inspected host. */
export async function startWorkspaceProxy(
  options: WorkspaceProxyOptions,
): Promise<WorkspaceProxy> {
  const lookup = options.lookup ?? lookupAll;
  const isPublic = options.isPublicAddress ?? isPublicAddress;
  const timeout = options.firstByteTimeoutMs ?? 2_000;
  const { sockets, track } = socketTracker();

  async function tunnel(client: net.Socket) {
    const port = await acceptConnect(client, timeout);

    if (port === undefined) return;

    const request = await readFirstRequest(client, timeout);

    if (!request) return void client.destroy();

    return route(client, request.first, request.host, port);
  }

  async function route(
    client: net.Socket,
    first: Buffer,
    host: string,
    port: number,
  ) {
    const tls = first[0] === 22;

    const handOff = () => {
      client.unshift(first);

      return options.intercept?.handle(client, host, port);
    };

    if (tls && options.intercept?.answers?.(host)) return handOff();

    const address = (await lookup(host)).find(isPublic);

    if (!address || client.destroyed) return void client.destroy();

    if (tls && options.intercept?.wants(host)) return handOff();

    forward(client, first, port, address, track);
  }

  const server = net.createServer((client) => {
    track(client);
    tunnel(client).catch(() => client.destroy());
  });

  const port = await listenOnLoopback(server, options.port ?? 0);

  return {
    address: `127.0.0.1:${port}`,
    close: () => closeProxy(server, sockets),
  };
}

async function closeProxy(server: net.Server, sockets: Set<net.Socket>) {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function socketTracker() {
  const sockets = new Set<net.Socket>();

  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());

    return socket;
  };

  return { sockets, track };
}

async function listenOnLoopback(server: net.Server, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  // SAFETY: listen completed on a TCP port, not a Unix socket.
  const address = server.address() as net.AddressInfo;

  return address.port;
}

function forward(
  client: net.Socket,
  first: Buffer,
  port: number,
  address: string,
  track: (socket: net.Socket) => net.Socket,
) {
  const upstream = track(net.connect(port, address));
  upstream.setTimeout(10_000, () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.once("connect", () => {
    upstream.setTimeout(0);
    upstream.write(first);
    client.pipe(upstream).pipe(client);
  });
}

async function acceptConnect(client: net.Socket, timeout: number) {
  const head = await readUntil(
    client,
    (data) => data.includes("\r\n\r\n"),
    timeout,
  );

  const match =
    head &&
    /^CONNECT \S+:(\d+) HTTP\/1\.[01]\r\n/.exec(head.toString("latin1"));

  const port = Number(match?.[1]);

  if (!head || !validPort(port)) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");

    return;
  }

  const rest = head.subarray(head.indexOf("\r\n\r\n") + 4);

  if (rest.length) client.unshift(rest);
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");

  return port;
}

async function readFirstRequest(client: net.Socket, timeout: number) {
  const first = await readUntil(client, completeFirstRequest, timeout);
  const host = first && (readSni(first) ?? readHttpHost(first));

  return first && host ? { first, host } : undefined;
}

function completeFirstRequest(data: Buffer) {
  if (data[0] === 22)
    return data.length >= 5 && data.length >= 5 + data.readUInt16BE(3);

  return data.includes("\r\n\r\n");
}

function readUntil(
  socket: net.Socket,
  complete: (data: Buffer) => boolean,
  timeout: number,
) {
  return new Promise<Buffer | undefined>((resolve) => {
    let pending = Buffer.alloc(0);

    const finish = (data?: Buffer) => {
      clearTimeout(timer);
      socket.pause();
      socket.off("data", receive);
      socket.off("end", ended);
      socket.off("close", ended);
      socket.off("error", ended);
      resolve(data);
    };

    const ended = () => finish();

    const receive = (data: Buffer) => {
      pending = Buffer.concat([pending, data]);

      if (pending.length > MAX_HEADER_BYTES) finish();
      else if (complete(pending)) finish(pending);
    };

    const timer = setTimeout(ended, timeout);
    socket.on("data", receive);
    socket.once("end", ended);
    socket.once("close", ended);
    socket.once("error", ended);

    if (socket.destroyed || socket.readableEnded) ended();
    else socket.resume();
  });
}
