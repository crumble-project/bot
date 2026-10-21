import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, test } from "bun:test";
import {
  isPublicAddress,
  readHttpHost,
  readSni,
  startWorkspaceProxy,
  type ProxyRequest,
  type WorkspaceProxyOptions,
} from "../src/workspace-proxy";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function upstream() {
  const requests: string[] = [];

  const server = net.createServer((socket) => {
    socket.once("data", (data) => {
      requests.push(data.toString("latin1"));
      socket.end("HTTP/1.1 204 No Content\r\n\r\n");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));

  // SAFETY: listen completed on a TCP port, not a Unix socket.
  const address = server.address() as net.AddressInfo;

  return { port: address.port, requests };
}

async function proxy(
  decide: WorkspaceProxyOptions["decide"],
  overrides: Partial<WorkspaceProxyOptions> = {},
) {
  const asked: ProxyRequest[] = [];

  const started = await startWorkspaceProxy({
    decide: (request) => {
      asked.push(request);

      return decide(request);
    },
    lookup: async () => ["127.0.0.1"],
    isPublicAddress: () => true,
    firstByteTimeoutMs: 200,
    ...overrides,
  });

  cleanups.push(() => started.close());

  return { address: started.address, asked };
}

// Microsandbox sends the IP it resolved; 203.0.113.7 is unroutable, so reaching upstream proves the proxy used the name.
async function tunnel(address: string, port: number) {
  const [host, proxyPort] = address.split(":");
  const socket = net.connect(Number(proxyPort), host);

  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(`CONNECT 203.0.113.7:${port} HTTP/1.1\r\n\r\n`);

  const reply = await new Promise<Buffer>((resolve) =>
    socket.once("data", resolve),
  );

  expect(reply.toString()).toStartWith("HTTP/1.1 200");

  return socket;
}

function received(socket: net.Socket) {
  return new Promise<string>((resolve) => {
    let text = "";
    socket.on("data", (data) => (text += data.toString()));
    socket.on("close", () => resolve(text));
  });
}

describe("workspace proxy", () => {
  test("an approved request reaches its host by name after the policy decides", async () => {
    const target = await upstream();

    const { address, asked } = await proxy(async () => {
      await Bun.sleep(100);

      return true;
    });

    const socket = await tunnel(address, target.port);
    const reply = received(socket);

    socket.write("GET / HTTP/1.1\r\nHost: example.test\r\n\r\n");

    expect(await reply).toStartWith("HTTP/1.1 204");
    expect(asked).toEqual([{ host: "example.test", port: target.port }]);
    expect(target.requests[0]).toStartWith("GET / HTTP/1.1");
  });

  test("fragmented CONNECT and coalesced fragmented HTTP reach the named host", async () => {
    const target = await upstream();
    const { address, asked } = await proxy(() => true);
    const [host, port] = address.split(":");
    const socket = net.connect(Number(port), host);
    const reply = received(socket);

    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("CON");
    await Bun.sleep(10);
    socket.write(
      `NECT 203.0.113.7:${target.port} HTTP/1.1\r\n\r\nGET / HTTP/1.1\r\nHo`,
    );
    await Bun.sleep(10);
    socket.write("st: example.test\r\n\r\n");

    expect(await reply).toContain("HTTP/1.1 204");
    expect(asked).toEqual([{ host: "example.test", port: target.port }]);
  });

  test("a denied request never leaves", async () => {
    const target = await upstream();
    const { address, asked } = await proxy(() => false);
    const socket = await tunnel(address, target.port);
    const reply = received(socket);

    socket.write("GET / HTTP/1.1\r\nHost: example.test\r\n\r\n");

    expect(await reply).toBe("");
    expect(asked).toHaveLength(1);
    expect(target.requests).toEqual([]);
  });

  test("the host comes from the TLS ClientHello", async () => {
    const { address, asked } = await proxy(() => false);
    const socket = await tunnel(address, 443);

    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );

    tls.connect({ socket, servername: "example.test" }).on("error", () => {});
    await closed;

    expect(asked).toEqual([{ host: "example.test", port: 443 }]);
  });

  test("a protocol where the server speaks first is refused without asking", async () => {
    const target = await upstream();
    const { address, asked } = await proxy(() => true);
    const socket = await tunnel(address, target.port);

    expect(await received(socket)).toBe("");
    expect(asked).toEqual([]);
  });

  test("a host that resolves only to private addresses is refused without asking", async () => {
    const target = await upstream();

    const { address, asked } = await proxy(() => true, {
      isPublicAddress: () => false,
    });

    const socket = await tunnel(address, target.port);
    const reply = received(socket);

    socket.write("GET / HTTP/1.1\r\nHost: example.test\r\n\r\n");

    expect(await reply).toBe("");
    expect(asked).toEqual([]);
    expect(target.requests).toEqual([]);
  });
});

describe("request parsing", () => {
  test("public and private addresses", () => {
    for (const address of ["93.184.215.14", "2606:4700::6810:84e5"])
      expect(isPublicAddress(address)).toBe(true);

    for (const address of [
      "10.0.0.1",
      "172.16.5.4",
      "192.168.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "not an address",
      "::ffff:a00:1",
      "::ffff:127.0.0.1",
      "2002:0a00:0001::",
      "64:ff9b::a00:1",
      "192.0.2.1",
      "198.18.0.1",
      "2001:db8::1",
    ])
      expect(isPublicAddress(address)).toBe(false);
  });

  test("the Host header without its port", () => {
    expect(
      readHttpHost(
        Buffer.from("GET / HTTP/1.1\r\nHost: example.test:8080\r\n\r\n"),
      ),
    ).toBe("example.test");
    expect(readHttpHost(Buffer.from("SSH-2.0-OpenSSH\r\n"))).toBeNull();
  });

  test("incomplete, duplicate, and malformed Host headers are refused", () => {
    for (const request of [
      "GET / HTTP/1.1\r\nHost: example.test",
      "GET / HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\n\r\n",
      "GET / HTTP/1.1\r\nHost: a.test:99999\r\n\r\n",
      "GET / HTTP/1.1\r\nHost: a.test b.test\r\n\r\n",
    ])
      expect(readHttpHost(Buffer.from(request))).toBeNull();
  });

  test("malformed or truncated ClientHellos have no host", () => {
    expect(readSni(Buffer.from("not tls"))).toBeNull();
    expect(
      readSni(
        Buffer.concat([Buffer.from([0x16, 3, 1, 0, 200, 1]), Buffer.alloc(43)]),
      ),
    ).toBeNull();
  });
});

test("the proxy listens on a requested port, and refuses a taken one", async () => {
  const first = await startWorkspaceProxy({ decide: () => true });
  const port = Number(first.address.split(":")[1]);
  await first.close();

  const again = await startWorkspaceProxy({ decide: () => true, port });
  expect(again.address).toBe(`127.0.0.1:${port}`);

  await expect(
    startWorkspaceProxy({ decide: () => true, port }),
  ).rejects.toThrow("EADDRINUSE");
  await again.close();
});
