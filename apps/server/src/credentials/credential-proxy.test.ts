import { commitSigning, SIGNING_HOST } from "./commit-signing";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { Redacted } from "effect";
import { Store } from "../../test/support/store";
import { PasswordManagerRepository } from "../password-managers/password-manager-repository";
import { credentialAuthoritiesAccess } from "./credential-authority";
import { credentialProxy } from "./credential-proxy";
import { credentialsAccess } from "./credentials";

const basic = (credentials: string) =>
  `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;

const headerLines = (message: string) =>
  message.slice(0, message.indexOf("\r\n\r\n")).split("\r\n").slice(1);

const bodyOf = (response: string) => {
  const split = response.indexOf("\r\n\r\n");
  const head = response.slice(0, split);
  let rest = response.slice(split + 4);

  if (!/^transfer-encoding: chunked$/im.test(head)) return rest;

  let body = "";

  for (;;) {
    const end = rest.indexOf("\r\n");
    const size = Number.parseInt(rest.slice(0, end), 16);

    if (!size) return body;
    body += rest.slice(end + 2, end + 2 + size);
    rest = rest.slice(end + 2 + size + 2);
  }
};

describe("credentialProxy", () => {
  const value = "proxy-test-value-0123456789";

  const setup = async () => {
    const dir = mkdtempSync(join(tmpdir(), "crumble-credential-proxy-"));
    const store = new Store(dir);

    const agentInput = {
      description: "",
      instructions: "",
      provider: "faux",
      model: "chat",
      enabled: true,
      tools: ["coding"],
      skills: [],
      mcpServers: [],
      delegates: [],
    };

    const bot = store.createAgent({ ...agentInput, name: "bot" });

    const upstreamAgent = store.createAgent({
      ...agentInput,
      name: "upstream",
    });

    const authorities = credentialAuthoritiesAccess(store.runtime);
    const credentials = credentialsAccess(store.runtime);
    const seen: string[] = [];
    const paths: string[] = [];
    const heads: string[] = [];
    let cannedReply: string | undefined;
    let reads = 0;

    await credentials.save(bot.id, "ECHO_TOKEN", {
      hosts: ["example.com"],
      secret: { value },
    });

    const upstream = tls.createServer(
      {
        SNICallback: (name, done) =>
          authorities
            .context(upstreamAgent.id, name)
            .then((context) => done(null, context), done),
      },
      (socket) => {
        let head = "";

        socket.on("data", (data: Buffer) => {
          head += data.toString("latin1");

          if (!head.includes("\r\n\r\n")) return;

          const authorization =
            /^authorization: (.*)$/im.exec(head)?.[1]?.trim() ?? "";

          seen.push(authorization);
          heads.push(head);
          paths.push(/^\S+ (\S+)/.exec(head)?.[1] ?? "");
          socket.end(
            cannedReply ??
              `HTTP/1.1 200 OK\r\ncontent-length: ${authorization.length}\r\nconnection: close\r\n\r\n${authorization}`,
          );
        });
      },
    );

    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    // SAFETY: listen completed on a TCP port, not a Unix socket.
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const proxy = credentialProxy({
      agentId: bot.id,
      authorities,
      grants: () => credentials.grants(bot.id),
      value: (name, target) => {
        reads++;

        return credentials.value(bot.id, name, target);
      },
      recordUse: (name, use) => credentials.recordUse(bot.id, name, use),
      lookup: async () => ["127.0.0.1"],
      isPublicAddress: () => true,
      upstreamCa: await authorities.certificate(upstreamAgent.id),
    });

    const entry = net.createServer(
      (socket) => void proxy.handle(socket, "example.com", upstreamPort),
    );

    await new Promise<void>((done) => entry.listen(0, "127.0.0.1", done));
    // SAFETY: listen completed on a TCP port, not a Unix socket.
    const entryPort = (entry.address() as AddressInfo).port;
    const ca = await authorities.certificate(bot.id);

    const send = (headers: string[], path = "/check") =>
      new Promise<string>((done, fail) => {
        const socket = tls.connect({
          host: "127.0.0.1",
          port: entryPort,
          servername: "example.com",
          ca,
        });

        let response = "";

        socket.on("secureConnect", () =>
          socket.write(
            `GET ${path} HTTP/1.1\r\nhost: example.com\r\n${headers.join("\r\n")}\r\nconnection: close\r\n\r\n`,
          ),
        );
        socket.on("data", (data: Buffer) => {
          response += data.toString("utf8");
        });
        socket.on("end", () => done(response));
        socket.on("error", fail);
      });

    const request = (authorization: string, path?: string) =>
      send([`authorization: ${authorization}`], path);

    const placeholder = store.agentCredentialPlaceholders(bot.id)[
      "ECHO_TOKEN"
    ]!;

    return {
      dir,
      store,
      bot,
      seen,
      paths,
      heads,
      reads: () => reads,
      replyWith: (reply: string) => {
        cannedReply = reply;
      },
      send,
      request,
      placeholder,
      close: () => {
        entry.close();
        upstream.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  test("reads a value only for a request that uses its placeholder, and scrubs it from the reply", async () => {
    const proxy = await setup();

    try {
      const plain = await proxy.request("Bearer none");

      expect(proxy.reads()).toBe(0);
      expect(bodyOf(plain)).toBe("Bearer none");

      const swapped = await proxy.request(`Bearer ${proxy.placeholder}`);

      expect(proxy.reads()).toBe(1);
      expect(proxy.seen).toEqual(["Bearer none", `Bearer ${value}`]);
      expect(bodyOf(swapped)).toBe(`Bearer ${proxy.placeholder}`);
      expect(swapped).not.toContain(value);
      expect(
        proxy.store.listCredentialUses(proxy.bot.id, "ECHO_TOKEN", {
          limit: 10,
        }),
      ).toMatchObject([{ status: 200, error: null }]);
    } finally {
      proxy.close();
    }
  });

  test("swaps placeholders in header values and drops hop-by-hop headers", async () => {
    const proxy = await setup();

    try {
      await proxy.send([
        `X-Acme-Token: ${proxy.placeholder}`,
        "Accept: */*",
        "Proxy-Authorization: Basic secret",
      ]);

      const lines = headerLines(proxy.heads[0]!);

      expect(lines).toContain(`x-acme-token: ${value}`);
      expect(lines).toContain("accept: */*");
      expect(proxy.heads[0]).not.toMatch(/proxy-authorization/i);
    } finally {
      proxy.close();
    }
  });

  test("keeps repeated request headers in order", async () => {
    const proxy = await setup();

    try {
      await proxy.send(["X-Tag: one", "X-Tag: two"]);

      expect(
        headerLines(proxy.heads[0]!).filter((line) => line.startsWith("x-tag")),
      ).toEqual(["x-tag: one", "x-tag: two"]);
    } finally {
      proxy.close();
    }
  });

  test("swaps the credentials inside a Basic authorization, and re-encodes them", async () => {
    const proxy = await setup();

    try {
      await proxy.request(basic(`bot:${proxy.placeholder}`));

      expect(proxy.seen).toEqual([basic(`bot:${value}`)]);
    } finally {
      proxy.close();
    }
  });

  test("swaps an authorization that isn't one Basic token as it is", async () => {
    const proxy = await setup();

    try {
      await proxy.request(`Basic ${proxy.placeholder} extra`);

      expect(proxy.seen).toEqual([`Basic ${value} extra`]);
    } finally {
      proxy.close();
    }
  });

  test("scrubs the value from response headers", async () => {
    const proxy = await setup();

    try {
      proxy.replyWith(
        `HTTP/1.1 200 OK\r\nContent-Length: 0\r\nX-Echo: ${value}\r\nConnection: close\r\n\r\n`,
      );

      const response = await proxy.request(`Bearer ${proxy.placeholder}`);

      expect(response).not.toContain(value);
      expect(headerLines(response)).toContain(`x-echo: ${proxy.placeholder}`);
    } finally {
      proxy.close();
    }
  });

  test("a reply without a scrubbed body keeps its content length", async () => {
    const proxy = await setup();

    try {
      proxy.replyWith(
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
      );

      expect(headerLines(await proxy.request("Bearer none"))).toContain(
        "content-length: 2",
      );
    } finally {
      proxy.close();
    }
  });

  test("frames a chunked reply anew and keeps repeated response headers in order", async () => {
    const proxy = await setup();

    try {
      proxy.replyWith(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nConnection: close\r\n\r\n2\r\nok\r\n0\r\n\r\n",
      );

      const response = await proxy.request("Bearer none");

      expect(bodyOf(response)).toBe("ok");
      expect(
        headerLines(response).filter((line) => line.startsWith("set-cookie")),
      ).toEqual(["set-cookie: a=1", "set-cookie: b=2"]);
    } finally {
      proxy.close();
    }
  });

  test("leaves a placeholder in the URL as it is", async () => {
    const proxy = await setup();

    try {
      const path = `/check?key=${proxy.placeholder}`;

      await proxy.request("Bearer none", path);
      expect(proxy.reads()).toBe(0);

      await proxy.request(`Bearer ${proxy.placeholder}`, path);
      expect(proxy.seen).toEqual(["Bearer none", `Bearer ${value}`]);
      expect(proxy.paths).toEqual([path, path]);
    } finally {
      proxy.close();
    }
  });

  test("answers 502 and logs the reason when the password manager can't supply the value", async () => {
    const proxy = await setup();

    try {
      proxy.store.run(
        PasswordManagerRepository.use((repository) =>
          repository.save("1password", Redacted.make("not-a-token"), "t"),
        ),
      );

      const db = new Database(join(proxy.dir, "store.sqlite"));
      db.run(
        "UPDATE credentials SET value = NULL, password_manager = '1password', reference = 'op://Vault/Item/token' WHERE key LIKE '%:credential:ECHO_TOKEN'",
      );
      db.close();

      const response = await proxy.request(`Bearer ${proxy.placeholder}`);

      expect(response).toStartWith("HTTP/1.1 502");
      expect(response).toContain(
        "Crumble credential proxy: ECHO_TOKEN could not be read: 1Password rejected the service account token",
      );
      expect(proxy.seen).toEqual([]);

      const [use] = proxy.store.listCredentialUses(proxy.bot.id, "ECHO_TOKEN", {
        limit: 10,
      });

      expect(use?.status).toBeNull();
      expect(use?.error).toStartWith(
        "ECHO_TOKEN could not be read: 1Password rejected the service account token",
      );
    } finally {
      proxy.close();
    }
  });
});

test("the signing host is answered by the proxy, for a bot with a machine account only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crumble-signing-"));
  const store = new Store(dir);
  const authorities = credentialAuthoritiesAccess(store.runtime);

  const bot = store.createAgent({
    name: "bot",
    description: "",
    instructions: "",
    provider: "faux",
    model: "chat",
    enabled: true,
    tools: ["coding"],
    skills: [],
    mcpServers: [],
    delegates: [],
  });

  const ca = await authorities.certificate(bot.id);
  const signed: string[] = [];

  const serve = async (sign: (data: Buffer) => Promise<string | undefined>) => {
    const proxy = commitSigning({ agentId: bot.id, authorities, sign });

    const entry = net.createServer(
      (socket) => void proxy.handle(socket, SIGNING_HOST, 443),
    );

    await new Promise<void>((done) => entry.listen(0, "127.0.0.1", done));

    return { proxy, entry };
  };

  const post = (entry: net.Server, body: string) =>
    new Promise<string>((done, fail) => {
      const socket = tls.connect({
        host: "127.0.0.1",
        // SAFETY: listen completed on a TCP port, not a Unix socket.
        port: (entry.address() as AddressInfo).port,
        servername: SIGNING_HOST,
        ca,
      });

      let response = "";

      socket.on("secureConnect", () =>
        socket.write(
          `POST /sign HTTP/1.1\r\nhost: ${SIGNING_HOST}\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
        ),
      );
      socket.on("data", (data: Buffer) => (response += data.toString("utf8")));
      socket.on("end", () => done(response));
      socket.on("error", fail);
    });

  const withAccount = await serve(async (data) => {
    signed.push(data.toString());

    return "SIGNATURE";
  });

  const without = await serve(async () => undefined);

  const none = credentialProxy({
    agentId: bot.id,
    authorities,
    grants: () => [],
    value: async () => "",
    recordUse: () => {},
  });

  try {
    expect(withAccount.proxy.answers?.(SIGNING_HOST)).toBe(true);
    expect(none.wants(SIGNING_HOST)).toBe(false);

    const answer = await post(withAccount.entry, "tree abc\n");

    expect(answer.startsWith("HTTP/1.1 200")).toBe(true);
    expect(bodyOf(answer)).toBe("SIGNATURE");
    expect(signed).toEqual(["tree abc\n"]);
    expect(
      (await post(without.entry, "tree abc\n")).startsWith("HTTP/1.1 403"),
    ).toBe(true);
  } finally {
    withAccount.entry.close();
    without.entry.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
