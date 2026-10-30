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
import {
  credentialProxy,
  requestHeaders,
  responseHeaders,
} from "./credential-proxy";
import { credentialsAccess } from "./credentials";

const placeholder = "$ACME_TOKEN";
const value = "s3cret-value";

const swap = (text: string) => text.replaceAll(placeholder, value);
const scrub = (text: string) => text.replaceAll(value, placeholder);

const basic = (credentials: string) =>
  `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;

describe("credential proxy request headers", () => {
  test("swaps placeholders in values and drops hop-by-hop headers", () => {
    expect(
      requestHeaders(
        [
          "Connection",
          "keep-alive",
          "Accept-Encoding",
          "gzip",
          "X-Acme-Token",
          placeholder,
          "Accept",
          "*/*",
        ],
        swap,
      ),
    ).toEqual({ "x-acme-token": [value], accept: ["*/*"] });
  });

  test("lowercases names and keeps repeated headers in order", () => {
    expect(requestHeaders(["X-Tag", "one", "X-Tag", "two"], swap)).toEqual({
      "x-tag": ["one", "two"],
    });
  });

  test("swaps the credentials inside a Basic authorization, and re-encodes them", () => {
    expect(
      requestHeaders(["Authorization", basic(`bot:${placeholder}`)], swap),
    ).toEqual({ authorization: [basic(`bot:${value}`)] });
  });

  test("swaps other authorization headers as they are", () => {
    expect(
      requestHeaders(["Authorization", `Bearer ${placeholder}`], swap),
    ).toEqual({ authorization: [`Bearer ${value}`] });

    // A Basic header holding more than one token is not a credential to decode, so it is swapped as text.
    expect(
      requestHeaders(["Authorization", `Basic ${placeholder} extra`], swap),
    ).toEqual({ authorization: [`Basic ${value} extra`] });
  });
});

describe("credential proxy response headers", () => {
  test("scrubs values and lowercases names", () => {
    expect(
      responseHeaders(
        ["Content-Type", "text/plain", "X-Echo", value],
        false,
        scrub,
      ),
    ).toEqual({ "content-type": ["text/plain"], "x-echo": [placeholder] });
  });

  test("drops content-length only when the body is scrubbed", () => {
    expect(responseHeaders(["Content-Length", "9"], false, scrub)).toEqual({
      "content-length": ["9"],
    });
    expect(responseHeaders(["Content-Length", "9"], true, scrub)).toEqual({});
  });

  test("drops hop-by-hop headers and keeps repeated ones in order", () => {
    expect(
      responseHeaders(
        [
          "Transfer-Encoding",
          "chunked",
          "Set-Cookie",
          "a=1",
          "Set-Cookie",
          "b=2",
        ],
        false,
        scrub,
      ),
    ).toEqual({ "set-cookie": ["a=1", "b=2"] });
  });
});

/** The body of a raw HTTP/1.1 response, joining chunks when it is chunked. */
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

  /** A bot with ECHO_TOKEN for example.com, an upstream that echoes the Authorization header, and the proxy between. */
  const setup = async () => {
    const dir = mkdtempSync(join(tmpdir(), "crumble-credential-proxy-"));
    const store = new Store(dir);

    const agentInput = {
      avatar: "bot",
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
    let reads = 0;

    await credentials.save(bot.id, "ECHO_TOKEN", {
      hosts: ["example.com"],
      value,
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
          paths.push(/^\S+ (\S+)/.exec(head)?.[1] ?? "");
          socket.end(
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
      value: (name) => {
        reads++;

        return credentials.value(bot.id, name);
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

    /** Sends a request with `authorization` from the bot's workspace and returns the raw response. */
    const request = (authorization: string, path = "/check") =>
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
            `GET ${path} HTTP/1.1\r\nhost: example.com\r\nauthorization: ${authorization}\r\nconnection: close\r\n\r\n`,
          ),
        );
        socket.on("data", (data: Buffer) => {
          response += data.toString("utf8");
        });
        socket.on("end", () => done(response));
        socket.on("error", fail);
      });

    const placeholder = store.agentCredentialPlaceholders(bot.id)[
      "ECHO_TOKEN"
    ]!;

    return {
      dir,
      store,
      bot,
      seen,
      paths,
      reads: () => reads,
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
        "UPDATE agent_credentials SET value = NULL, password_manager = '1password', reference = 'op://Vault/Item/token' WHERE name = 'ECHO_TOKEN'",
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
