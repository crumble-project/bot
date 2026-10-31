import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  DiscordAPIError,
  HTTPError,
  RateLimitError,
  REST,
  type ClientOptions,
} from "discord.js";
import {
  GatewayTransportError,
  type GatewayMessage,
  type GatewayStatus,
} from "../adapter";
import {
  discordAdapter,
  normalizeDiscordMessage,
  type DiscordClient,
  type DiscordMessage,
} from "./adapter";
import { discordPlugin } from "./plugin";
import { pluginSettingKey } from "../../plugins/plugins";

const message = (overrides: Partial<DiscordMessage> = {}): DiscordMessage => ({
  id: "inbound",
  channelId: "channel",
  author: { id: "sender", bot: false },
  webhookId: null,
  content: "  @researcher original\ntext <@application>  ",
  attachments: { size: 0 },
  reference: null,
  inGuild: () => true,
  ...overrides,
});

class FakeClient extends EventEmitter implements DiscordClient {
  user = { id: "application" };
  post = mock(
    async (
      _route: Parameters<REST["post"]>[0],
      _options?: Parameters<REST["post"]>[1],
    ) => ({ id: "answer" }),
  );
  rest: Pick<REST, "post"> = { post: this.post };
  login = mock(async (token: string) => {
    this.emit("clientReady");

    return token;
  });
  destroy = mock(async () => undefined);
}

function fixture(deadline?: (milliseconds: number) => AbortSignal) {
  const client = new FakeClient();
  const states: { status: GatewayStatus; error?: string }[] = [];
  const onMessage = mock(async (_message: GatewayMessage) => undefined);
  const onInvalidated = mock((_error?: string) => undefined);
  const clientFactory = mock((_options: ClientOptions) => client);
  const adapter = discordAdapter(clientFactory, deadline);

  const host = {
    token: "test-token",
    onMessage,
    onInvalidated,
    onStatus(status: GatewayStatus, error?: string) {
      const state: (typeof states)[number] = { status };

      if (error) state.error = error;
      states.push(state);
    },
  };

  return {
    client,
    clientFactory,
    states,
    onMessage,
    onInvalidated,
    adapter,
    host,
  };
}

describe("Discord message normalization", () => {
  test("preserves original text, references, and attachment presence", () => {
    const input = message({
      attachments: { size: 1 },
      reference: { messageId: "previous-answer" },
    });

    expect(normalizeDiscordMessage(input)).toEqual({
      id: "inbound",
      channelId: "channel",
      senderId: "sender",
      text: input.content,
      isDirectMessage: false,
      hasAttachments: true,
      replyTo: "previous-answer",
    });
  });

  test("accepts direct messages and attachment-only messages", () => {
    expect(
      normalizeDiscordMessage(
        message({
          content: "",
          attachments: { size: 1 },
          inGuild: () => false,
        }),
      ),
    ).toMatchObject({
      text: "",
      isDirectMessage: true,
      hasAttachments: true,
    });
  });

  test("ignores bot and webhook messages", () => {
    expect(
      normalizeDiscordMessage(message({ author: { id: "bot", bot: true } })),
    ).toBeUndefined();
    expect(
      normalizeDiscordMessage(message({ webhookId: "webhook" })),
    ).toBeUndefined();
  });
});

describe("Discord connection", () => {
  test("forwards human messages and reports reconnect lifecycle", async () => {
    const { adapter, host, client, states, onMessage } = fixture();
    const connection = await adapter.connect(host);
    client.emit("messageCreate", message());
    client.emit("messageCreate", message({ webhookId: "webhook" }));
    client.emit("shardDisconnect");
    client.emit("shardReconnecting");
    client.emit("shardResume");

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(normalizeDiscordMessage(message()));
    expect(states.map((state) => state.status)).toEqual([
      "connecting",
      "connected",
      "disconnected",
      "connecting",
      "connected",
    ]);
    await connection.close();
  });

  test("sends reply references with mentions disabled and stable bounded nonces", async () => {
    const { adapter, host, client } = fixture();
    const connection = await adapter.connect(host);

    const input = {
      channelId: "channel",
      text: "@everyone <@sender> answer",
      replyTo: "inbound",
      nonce: "request:original-message:chunk:0",
    };

    expect(await connection.send(input)).toBe("answer");
    await connection.send(input);
    const first = client.post.mock.calls[0]?.[1]?.body;
    const second = client.post.mock.calls[1]?.[1]?.body;

    expect(client.post.mock.calls[0]?.[0]).toBe("/channels/channel/messages");
    expect(structuredClone(first)).toMatchObject({
      content: input.text,
      allowed_mentions: { parse: [], replied_user: false },
      enforce_nonce: true,
      nonce: expect.stringMatching(/^[a-f0-9]{24}$/),
      message_reference: { message_id: "inbound", fail_if_not_exists: false },
    });
    expect(first).toEqual(second);
    await connection.send({ ...input, nonce: "next-chunk" });
    expect(client.post.mock.calls[2]?.[1]?.body).not.toEqual(first);
    await connection.close();
  });

  test("supports sends without a reply and rejects unavailable destinations", async () => {
    const { adapter, host, client, states } = fixture();
    const connection = await adapter.connect(host);
    const input = { channelId: "channel", text: "answer", nonce: "request" };
    await connection.send(input);

    expect(client.post.mock.calls[0]?.[1]?.body).not.toHaveProperty(
      "message_reference",
    );
    client.post.mockRejectedValueOnce(
      new Error("Missing access for test-token"),
    );
    await expect(connection.send(input)).rejects.toThrow(
      "Missing access for [redacted]",
    );
    expect(states.at(-1)?.status).toBe("connected");
    await connection.close();
  });

  test("close removes listeners, rejects sends, and is idempotent", async () => {
    const { adapter, host, client, onMessage } = fixture();
    const connection = await adapter.connect(host);
    await connection.close();
    await connection.close();
    client.emit("messageCreate", message());

    expect(client.eventNames()).toEqual([]);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
    await expect(
      connection.send({
        channelId: "channel",
        text: "answer",
        nonce: "request",
      }),
    ).rejects.toThrow("Discord connection is closed.");
  });

  test("close aborts in-flight REST delivery before destroying the client", async () => {
    const { adapter, host, client } = fixture();
    const connection = await adapter.connect(host);

    client.post.mockImplementationOnce(
      async (_route, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            expect(client.destroy).not.toHaveBeenCalled();
            reject(new Error("aborted test-token"));
          });
        }),
    );

    const sending = connection.send({
      channelId: "channel",
      text: "answer",
      nonce: "request",
    });

    await connection.close();

    await expect(sending).rejects.toThrow("Discord connection is closed.");
    expect(client.post.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  test("the bounded deadline aborts REST delivery without exposing credentials", async () => {
    const timeout = new AbortController();
    const deadline = mock((_milliseconds: number) => timeout.signal);
    const { adapter, host, client, states } = fixture(deadline);
    const connection = await adapter.connect(host);
    client.post.mockImplementationOnce(
      async (_route, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted test-token")),
          );
        }),
    );

    const sending = connection.send({
      channelId: "channel",
      text: "answer",
      nonce: "request",
    });

    timeout.abort();

    await expect(sending).rejects.toThrow(
      "Discord message delivery timed out.",
    );
    expect(deadline).toHaveBeenCalledWith(10_000);
    expect(client.post.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(states.at(-1)?.status).toBe("connected");
    await connection.close();
  });

  test("close cancels the SDK queue before another authorized request can run", async () => {
    const { adapter, host, client, clientFactory } = fixture();
    const connection = await adapter.connect(host);
    const started = Promise.withResolvers<void>();
    let networkCalls = 0;

    const rest = new REST({
      ...clientFactory.mock.calls[0]?.[0].rest,
      makeRequest: async (_url, options) => {
        options.signal?.throwIfAborted();
        networkCalls++;
        started.resolve();

        return new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new Error("aborted test-token")),
          );
        });
      },
    }).setToken(host.token);

    client.rest = rest;

    const first = connection.send({
      channelId: "123456789012345678",
      text: "first answer",
      nonce: "first",
    });

    await started.promise;

    const second = connection.send({
      channelId: "123456789012345678",
      text: "second answer",
      nonce: "second",
    });

    const settled = Promise.allSettled([first, second]);
    await connection.close();

    expect(await settled).toEqual([
      {
        status: "rejected",
        reason: new Error("Discord connection is closed."),
      },
      {
        status: "rejected",
        reason: new Error("Discord connection is closed."),
      },
    ]);
    expect(networkCalls).toBe(1);
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
  });

  test("REST rate limits reject for durable retry with no SDK retry queue", async () => {
    const { adapter, host, client, clientFactory } = fixture();
    const connection = await adapter.connect(host);
    const options = clientFactory.mock.calls[0]?.[0];

    expect(options?.rest).toEqual({
      retries: 0,
      timeout: 10_000,
      rejectOnRateLimit: ["/"],
    });

    const makeRequest = mock(async () => {
      const response = new Response(
        JSON.stringify({
          message: "Rate limited",
          retry_after: 65.5,
          global: true,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "65.5",
            "X-RateLimit-Global": "true",
            "X-RateLimit-Scope": "global",
          },
        },
      );

      return {
        body: null,
        bodyUsed: response.bodyUsed,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: response.headers,
        arrayBuffer: () => response.arrayBuffer(),
        text: () => response.text(),
        json: () => response.json(),
      };
    });

    const rest = new REST({ ...options?.rest, makeRequest }).setToken(
      host.token,
    );

    client.rest = rest;

    try {
      const error = await connection
        .send({
          channelId: "123456789012345678",
          text: "answer",
          nonce: "request",
        })
        .catch((error: Error) => error);

      expect(error).toMatchObject({
        details: {
          permanent: false,
          status: 429,
          rateLimit: {
            scope: "adapter",
          },
        },
      });

      if (!(error instanceof GatewayTransportError)) throw error;

      expect(error.details.retryAfterMs).toBeGreaterThanOrEqual(65_500);
      expect(makeRequest).toHaveBeenCalledTimes(1);
    } finally {
      await connection.close();
      rest.clearHashSweeper();
      rest.clearHandlerSweeper();
    }
  });

  test("validates REST responses before returning a message ID", async () => {
    const { adapter, host, client } = fixture();
    const connection = await adapter.connect(host);
    client.post.mockResolvedValueOnce({ id: "" });

    await expect(
      connection.send({
        channelId: "channel",
        text: "answer",
        nonce: "request",
      }),
    ).rejects.toThrow("Discord returned an invalid message response.");
    await connection.close();
  });

  test("failed login destroys the client and redacts credentials", async () => {
    const { adapter, host, client, states } = fixture();
    client.login.mockRejectedValueOnce(new Error("Invalid test-token"));

    await expect(adapter.connect(host)).rejects.toThrow("Invalid [redacted]");
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(client.eventNames()).toEqual([]);
    expect(states.at(-1)).toEqual({
      status: "error",
      error: "Invalid [redacted]",
    });
  });

  test("a cleanup failure preserves the original login failure", async () => {
    const { adapter, host, client } = fixture();
    client.login.mockRejectedValueOnce(new Error("Invalid token"));
    client.destroy.mockRejectedValueOnce(new Error("Cleanup failed"));

    await expect(adapter.connect(host)).rejects.toThrow("Invalid token");
    expect(client.eventNames()).toEqual([]);
  });

  test("diagnostic errors and callback failures do not invalidate the session", async () => {
    const { adapter, host, client, states, onMessage, onInvalidated } =
      fixture();

    const connection = await adapter.connect(host);
    client.emit("error", new Error("SDK test-token error"));
    client.emit("shardError", new Error("shard test-token error"));
    onMessage.mockRejectedValueOnce(new Error("processing failed"));
    client.emit("messageCreate", message());
    await Promise.resolve();

    expect(states.at(-1)).toEqual({
      status: "error",
      error: "processing failed",
    });
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(client.destroy).not.toHaveBeenCalled();
    expect(
      await connection.send({
        channelId: "channel",
        text: "answer",
        nonce: "request",
      }),
    ).toBe("answer");
    await connection.close();
  });

  test("only explicit invalidation requests one reconnect", async () => {
    const { adapter, host, client, onInvalidated } = fixture();
    const connection = await adapter.connect(host);
    client.emit("invalidated");
    client.emit("invalidated");
    expect(onInvalidated).toHaveBeenCalledTimes(1);
    expect(onInvalidated).toHaveBeenCalledWith(
      "Discord session invalidated. Reconnect the gateway.",
    );
    await connection.close();
    client.emit("invalidated");
    expect(onInvalidated).toHaveBeenCalledTimes(1);
  });

  test("strips only a leading native mention of this application for routing", async () => {
    const { adapter, host, client, onMessage } = fixture();
    const connection = await adapter.connect(host);

    for (const content of [
      "<@application> @researcher hello",
      "  <@!application>\n@researcher hello",
    ]) {
      client.emit("messageCreate", message({ content }));
      expect(onMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: content,
          routingText: "@researcher hello",
        }),
      );
    }

    for (const content of [
      "<@other> @researcher hello",
      "hello <@application> @researcher",
      "<@application-other> @researcher",
      "<@application>@researcher hello",
    ]) {
      client.emit("messageCreate", message({ content }));
      const normalized = onMessage.mock.calls.at(-1)?.[0];
      expect(normalized).toMatchObject({ text: content });
      expect(normalized).not.toHaveProperty("routingText");
    }

    await connection.close();
  });

  test("an own native mention without content has empty routing text", async () => {
    const { adapter, host, client, onMessage } = fixture();
    const connection = await adapter.connect(host);

    for (const content of ["<@application>", "<@!application>"]) {
      client.emit("messageCreate", message({ content }));

      expect(onMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: content, routingText: "" }),
      );
    }

    await connection.close();
  });

  test("HTTP permission failures retain permanent status without credentials", async () => {
    const { adapter, host, client } = fixture();
    const connection = await adapter.connect(host);

    for (const status of [403, 404]) {
      client.post.mockRejectedValueOnce(
        new HTTPError(
          status,
          "test-token denied",
          "POST",
          "https://discord.com",
          {},
        ),
      );
      await expect(
        connection.send({
          channelId: "channel",
          text: "answer",
          nonce: "request",
        }),
      ).rejects.toMatchObject({ details: { permanent: true, status } });
    }

    client.post.mockRejectedValueOnce(
      new DiscordAPIError(
        { code: 50001, message: "Missing test-token" },
        50001,
        403,
        "POST",
        "https://discord.com",
        {},
      ),
    );

    const error = await connection
      .send({ channelId: "channel", text: "answer", nonce: "request" })
      .catch((error: Error) => error);

    expect(error).toMatchObject({ details: { permanent: true, status: 403 } });
    expect(String(error)).toContain("[redacted]");
    expect(String(error)).not.toContain(host.token);
    await connection.close();
  });

  test("SDK rate-limit failures preserve milliseconds and global scope", async () => {
    const { adapter, host, client } = fixture();
    const connection = await adapter.connect(host);

    for (const scope of ["global", "shared", "user"] as const) {
      client.post.mockRejectedValueOnce(
        new RateLimitError({
          timeToReset: 70_000,
          retryAfter: 65_000,
          sublimitTimeout: 90_000,
          global: scope === "global",
          scope,
          route: "/channels/:id/messages",
          majorParameter: "channel",
          method: "POST",
          hash: "bucket",
          limit: 5,
          url: "https://discord.com",
        }),
      );
      await expect(
        connection.send({
          channelId: "channel",
          text: "answer",
          nonce: "request",
        }),
      ).rejects.toMatchObject({
        details: {
          permanent: false,
          status: 429,
          retryAfterMs: 90_000,
          rateLimit: {
            scope: scope === "global" ? "adapter" : "channel",
          },
        },
      });
    }

    await connection.close();
  });

  test("raw API rate-limit retry_after seconds become durable milliseconds", async () => {
    const { adapter, host, client } = fixture();
    const connection = await adapter.connect(host);

    const raw = {
      code: 0,
      message: "Rate limited test-token",
      retry_after: 65.5,
      global: true,
    };

    client.post.mockRejectedValueOnce(
      new DiscordAPIError(raw, 0, 429, "POST", "https://discord.com", {}),
    );
    await expect(
      connection.send({
        channelId: "channel",
        text: "answer",
        nonce: "request",
      }),
    ).rejects.toMatchObject({
      details: {
        permanent: false,
        status: 429,
        retryAfterMs: 65_500,
        rateLimit: {
          scope: "adapter",
        },
      },
    });
    await connection.close();
  });
});

test("Discord contributes a discoverable secret-backed adapter", () => {
  const plugin = discordPlugin();
  const setting = plugin.settings?.[0];

  expect(setting?.key).toBe("token");
  expect(plugin.chatAdapters?.[0]?.secretKey).toBe(
    pluginSettingKey(plugin.id, setting?.key ?? ""),
  );
});
