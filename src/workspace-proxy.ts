import dns from "node:dns/promises";
import net from "node:net";

export type ProxyRequest = { host: string; port: number };

export type WorkspaceProxyOptions = {
  decide: (request: ProxyRequest) => boolean | Promise<boolean>;
  lookup?: (host: string) => Promise<string[]>;
  isPublicAddress?: (address: string) => boolean;
  firstByteTimeoutMs?: number;
  /** Listen on this port, so a restarted machine finds its proxy at the address it was created with. */
  port?: number;
};

export type WorkspaceProxy = { address: string; close(): Promise<void> };

const PRIVATE = new net.BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv4");

const GLOBAL_V6 = new net.BlockList();

GLOBAL_V6.addSubnet("2000::", 3, "ipv6");

for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv6");

/** Only globally routable addresses; transition and mapped IPv6 addresses are refused. */
export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) return !PRIVATE.check(address, "ipv4");

  return (
    net.isIPv6(address) &&
    !address.includes("%") &&
    GLOBAL_V6.check(address, "ipv6") &&
    !PRIVATE.check(address, "ipv6")
  );
}

function hostname(value: string): string | null {
  const host = value.toLowerCase().replace(/\.$/, "");

  if (
    host.length > 253 ||
    !host
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;

  return host;
}

/** The server name of a complete TLS ClientHello, or null. */
export function readSni(data: Buffer): string | null {
  try {
    if (data[0] !== 22 || data[1] !== 3 || data[5] !== 1) return null;
    const end = 5 + data.readUInt16BE(3);

    if (end > data.length || data.readUIntBE(6, 3) + 9 !== end) return null;
    let at = 43;
    at += 1 + data.readUInt8(at);
    const ciphers = data.readUInt16BE(at);

    if (!ciphers || ciphers % 2) return null;
    at += 2 + ciphers;
    at += 1 + data.readUInt8(at);
    const extensionsEnd = at + 2 + data.readUInt16BE(at);

    if (extensionsEnd !== end) return null;
    at += 2;
    let host: string | null = null;

    while (at < end) {
      const type = data.readUInt16BE(at);
      const length = data.readUInt16BE(at + 2);
      at += 4;
      const next = at + length;

      if (next > end) return null;

      if (type === 0) {
        if (
          host ||
          length < 5 ||
          data.readUInt16BE(at) !== length - 2 ||
          data[at + 2] !== 0 ||
          data.readUInt16BE(at + 3) !== length - 5
        )
          return null;
        host = hostname(data.toString("latin1", at + 5, next));

        if (!host) return null;
      }

      at = next;
    }

    return host;
  } catch {
    return null;
  }
}

/** The host of a complete HTTP/1 request header, without its port. */
export function readHttpHost(data: Buffer): string | null {
  const end = data.indexOf("\r\n\r\n");

  if (end < 0) return null;
  const [request, ...headers] = data.toString("latin1", 0, end).split("\r\n");

  if (!request || !/^[A-Z]+ \S+ HTTP\/1\.[01]$/.test(request)) return null;
  let host: string | null = null;

  for (const header of headers) {
    const match = /^([!#$%&'*+.^_`|~\w-]+):[ \t]*([^\r\n]*)$/.exec(header);

    if (!match) return null;

    if (match[1]?.toLowerCase() !== "host") continue;

    if (host) return null;
    const authority = /^([^:]+)(?::([0-9]+))?$/.exec(match[2]?.trim() ?? "");

    if (!authority || (authority[2] && !validPort(Number(authority[2]))))
      return null;
    host = hostname(authority[1] ?? "");

    if (!host) return null;
  }

  return host;
}

const validPort = (port: number) =>
  Number.isInteger(port) && port > 0 && port <= 65535;

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
  const sockets = new Set<net.Socket>();

  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());

    return socket;
  };

  async function tunnel(client: net.Socket) {
    const head = await readUntil(
      client,
      (data) => data.includes("\r\n\r\n"),
      timeout,
    );

    const match =
      head &&
      /^CONNECT \S+:(\d+) HTTP\/1\.[01]\r\n/.exec(head.toString("latin1"));

    const port = Number(match?.[1]);

    if (!head || !validPort(port))
      return void client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    const rest = head.subarray(head.indexOf("\r\n\r\n") + 4);

    if (rest.length) client.unshift(rest);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    const first = await readUntil(
      client,
      (data) => {
        if (data[0] === 22)
          return data.length >= 5 && data.length >= 5 + data.readUInt16BE(3);

        return data.includes("\r\n\r\n");
      },
      timeout,
    );

    const host = first && (readSni(first) ?? readHttpHost(first));

    if (!first || !host) return void client.destroy();
    const address = (await lookup(host)).find(isPublic);

    if (!address || !(await options.decide({ host, port })) || client.destroyed)
      return void client.destroy();
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

  const server = net.createServer((client) => {
    track(client);
    tunnel(client).catch(() => client.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  // SAFETY: listen completed on a TCP port, not a Unix socket.
  const address = server.address() as net.AddressInfo;

  return {
    address: `127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
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
