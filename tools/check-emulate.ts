import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  agentResponse,
  chatSnapshotResponse,
  executionResponse,
  modelResponse,
  providerResponse,
} from "../apps/server/src/contract/api-responses";
import { EMULATE_MODEL_IDS } from "../apps/server/src/providers/emulate-profile";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { emulateModels } from "../apps/server/src/providers/emulate";
import { startEmulate, startLocalApp } from "./emulate-process";
import type { LocalProcess } from "./emulate-process";
import {
  ERROR_TEXT,
  REPLY_TEXT,
  STREAM_TEXT,
  TOOL_REPLY_TEXT,
} from "./emulate-scenarios";

const textOf = (message: AssistantMessage) =>
  message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

async function transportSmoke() {
  const emulator = await startEmulate();

  try {
    const models = emulateModels(`${emulator.url}/v1`);
    const model = models.getModel("emulate", "local-stream");
    assert(model);

    const context: Context = {
      messages: [
        { role: "user", content: "local transport", timestamp: Date.now() },
      ],
    };

    const stream = models.streamSimple(model, context, {
      signal: AbortSignal.timeout(15_000),
      maxRetries: 0,
    });

    const deltas: Array<string> = [];

    for await (const event of stream) {
      if (event.type === "text_delta") {
        deltas.push(event.delta);
      }
    }

    const answer = await stream.result();
    assert.equal(
      answer.stopReason,
      "stop",
      answer.errorMessage ?? "stream failed",
    );
    assert(deltas.length > 1, "Pi must receive incremental content");
    assert.equal(deltas.join(""), STREAM_TEXT);

    const toolModel = models.getModel("emulate", "local-tool");
    assert(toolModel);
    context.tools = [
      {
        name: "history_search",
        description: "Search local history",
        parameters: Type.Object({ query: Type.Optional(Type.String()) }),
      },
    ];

    const first = await models.completeSimple(toolModel, context, {
      signal: AbortSignal.timeout(15_000),
      maxRetries: 0,
    });

    assert.equal(
      first.stopReason,
      "toolUse",
      first.errorMessage ?? "tool call failed",
    );
    const call = first.content.find((block) => block.type === "toolCall");
    assert(call?.type === "toolCall");
    assert.equal(call.name, "history_search");
    assert.deepEqual(call.arguments, { query: "local" });
    context.messages.push(first, {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "[]" }],
      isError: false,
      timestamp: Date.now(),
    });

    const final = await models.completeSimple(toolModel, context, {
      signal: AbortSignal.timeout(15_000),
      maxRetries: 0,
    });

    assert.equal(
      final.stopReason,
      "stop",
      final.errorMessage ?? "continuation failed",
    );
    assert.equal(textOf(final), TOOL_REPLY_TEXT);
    process.stdout.write(
      "PASS real Pi streaming and tool-result continuation\n",
    );
  } finally {
    await emulator.close();
  }
}

async function closeChildren(children: ReadonlyArray<LocalProcess>) {
  const closed = await Promise.allSettled(
    children.toReversed().map((child) => child.close()),
  );

  const failures: Array<unknown> = [];

  for (const result of closed) {
    if (result.status === "rejected") {
      failures.push(result.reason);
    }
  }

  if (failures.length) {
    throw new AggregateError(failures, "Local smoke cleanup failed");
  }
}

type Snapshot = z.infer<typeof chatSnapshotResponse>;

type SmokeRequest = Record<string, string | { enabled: boolean }>;

const authResponse = z.object({ token: z.string().min(1) });

const callsResponse = z.array(
  z.object({
    model: z.string(),
    status: z.number(),
    fault: z.enum(["none", "stall", "disconnect"]),
    delivery: z.enum(["pending", "completed", "client_aborted", "error"]),
    matched: z.object({ id: z.string() }).nullable(),
  }),
);

async function request(url: string, init: RequestInit = {}, status = 200) {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(20_000),
      ...(init.signal ? [init.signal] : []),
    ]),
  });

  assert.equal(
    response.status,
    status,
    `${url}: ${response.status === status ? "" : await response.text()}`,
  );

  return response;
}

async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  let last: T | undefined;

  do {
    const value = await read();
    last = value;

    if (accept(value)) {
      return value;
    }

    await delay(100);
  } while (Date.now() < deadline);

  throw new Error(
    `Local smoke wait exceeded 20 seconds: ${JSON.stringify(last)}`,
  );
}

async function applicationSmoke() {
  const dataDir = await mkdtemp(join(tmpdir(), "crumble-emulate-"));
  const owned: Array<LocalProcess> = [];
  const bots = new Map<string, string>();
  const streams = new Set<AbortController>();
  let app: LocalProcess | undefined;
  let token = "";

  const credentials = {
    name: "Local smoke",
    email: `${crypto.randomUUID()}@example.test`,
    password: "local-smoke-password",
  };

  const api = (path: string, body?: SmokeRequest, status = 200) => {
    assert(app);

    const init: RequestInit = {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    };

    if (body !== undefined) {
      init.method = "POST";
      init.body = JSON.stringify(body);
    }

    return request(`${app.url}${path}`, init, status);
  };

  const snapshot = async (id: string) =>
    chatSnapshotResponse.parse(
      await (await api(`/v1/agents/${id}/chat`)).json(),
    );

  const send = async (id: string) => {
    const requestId = crypto.randomUUID();

    const receipt = executionResponse.parse(
      await (
        await api(
          `/v1/agents/${id}/messages`,
          { content: "local smoke", requestId },
          202,
        )
      ).json(),
    );

    assert.equal(receipt.requestId, requestId);
    assert.equal(receipt.agentId, id);

    return requestId;
  };

  const turn = async (id: string, expected: "done" | "failed" = "done") => {
    const requestId = await send(id);

    const execution = await until(
      async () =>
        executionResponse
          .array()
          .parse(await (await api(`/v1/executions?agentId=${id}`)).json())
          .find((entry) => entry.requestId === requestId),
      (entry) =>
        !!entry && ["done", "failed", "cancelled"].includes(entry.status),
    );

    assert.equal(
      execution?.status,
      expected,
      execution?.error ?? "Unexpected execution result",
    );

    return until(
      () => snapshot(id),
      (chat) =>
        chat.status !== "running" &&
        chat.messages.some((message) => message.requestId === requestId),
    );
  };

  const checkCatalog = async () => {
    const providers = providerResponse
      .array()
      .parse(await (await api("/v1/providers")).json());

    assert.deepEqual(
      providers.map((provider) => [provider.provider, provider.configured]),
      [["emulate", true]],
    );

    const models = modelResponse
      .array()
      .parse(await (await api("/v1/models")).json());

    assert(models.every((model) => model.provider === "emulate"));
    assert.deepEqual(
      models.map((model) => model.id).sort(),
      [...EMULATE_MODEL_IDS].sort(),
    );
  };

  const observe = async (id: string, accept: (chat: Snapshot) => boolean) => {
    assert(app);
    const controller = new AbortController();
    streams.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      const response = await request(
        `${app.url}/v1/agents/${id}/events?partial=true`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        },
      );

      assert.match(
        response.headers.get("content-type") ?? "",
        /text\/event-stream/,
      );
      assert(response.body);
      reader = response.body.getReader();
      await send(id);
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const chunk: Awaited<
          ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
        > = await reader.read();

        assert(!chunk.done, "Chat event stream ended before completion");
        buffer += decoder
          .decode(chunk.value, { stream: true })
          .replaceAll("\r\n", "\n");
        let boundary: number;

        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          if (
            !frame.split("\n").some((line) => line.trim() === "event: snapshot")
          ) {
            continue;
          }

          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");

          const chat = chatSnapshotResponse.parse(JSON.parse(data));

          if (accept(chat)) {
            return chat;
          }
        }
      }
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => {});
      streams.delete(controller);
    }
  };

  try {
    let emulator = await startEmulate();
    owned.push(emulator);
    app = await startLocalApp({
      baseUrl: `${emulator.url}/v1`,
      dataDir,
      port: 0,
    });
    owned.push(app);
    token = authResponse.parse(
      await (await api("/api/auth/sign-up/email", credentials)).json(),
    ).token;
    await checkCatalog();

    for (const model of EMULATE_MODEL_IDS) {
      const bot = agentResponse.parse(
        await (
          await api(
            "/v1/agents",
            {
              name: model,
              provider: "emulate",
              model,
              review: { enabled: false },
            },
            201,
          )
        ).json(),
      );

      bots.set(model, bot.id);
    }

    const bot = (model: string) => {
      const id = bots.get(model);
      assert(id);

      return id;
    };

    const hasReply = (chat: Snapshot, text: string) =>
      chat.messages.some(
        (message) => message.role === "assistant" && message.content === text,
      );

    assert(hasReply(await turn(bot("local-reply")), REPLY_TEXT));
    const partials = new Set<string>();
    await observe(bot("local-stream"), (chat) => {
      if (chat.partial && !hasReply(chat, STREAM_TEXT)) {
        partials.add(chat.partial);
      }

      return chat.status === "idle" && hasReply(chat, STREAM_TEXT);
    });
    assert(
      partials.size >= 2,
      `Expected distinct partial texts before completion, got ${partials.size}`,
    );
    const toolChat = await turn(bot("local-tool"));
    assert(hasReply(toolChat, TOOL_REPLY_TEXT));

    const call = toolChat.messages
      .flatMap((message) => message.blocks ?? [])
      .find(
        (block) => block.type === "toolCall" && block.name === "history_search",
      );

    assert(call?.type === "toolCall");
    assert.deepEqual(call.arguments, { query: "local" });

    const result = toolChat.messages.find(
      (message) => message.toolCallId === call.id,
    );

    assert(
      result &&
        result.toolName === "history_search" &&
        result.content.trim() &&
        result.isError !== true,
      "Missing successful actual history_search result",
    );

    const calls = async () =>
      callsResponse.parse(
        await (await request(`${emulator.url}/_ai/calls`)).json(),
      );

    const toolCalls = (await calls()).filter(
      (entry) => entry.model === "local-tool",
    );

    assert.deepEqual(
      toolCalls.map((entry) => [entry.matched?.id, entry.status]),
      [
        ["local-tool-call", 200],
        ["local-tool-result", 200],
      ],
    );
    const failed = await turn(bot("local-error"), "failed");
    assert.equal(failed.status, "idle");
    assert(!failed.messages.some((message) => message.role === "assistant"));
    assert(failed.error?.includes(ERROR_TEXT));
    await send(bot("local-stall"));
    await until(
      () => snapshot(bot("local-stall")),
      (chat) => chat.status === "running",
    );
    await until(calls, (entries) =>
      entries.some((entry) => entry.model === "local-stall"),
    );
    await api(`/v1/agents/${bot("local-stall")}/abort`, {}, 204);

    const stopped = await until(
      () => snapshot(bot("local-stall")),
      (chat) => chat.status !== "running",
    );

    assert.equal(stopped.working, "idle", "Aborted bot is still working");
    await until(calls, (entries) =>
      entries.some(
        (entry) =>
          entry.model === "local-stall" &&
          entry.status === 200 &&
          entry.fault === "stall" &&
          entry.delivery === "client_aborted",
      ),
    );

    const unknown = await request(
      `${emulator.url}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "unknown-local-model",
          messages: [{ role: "user", content: "local" }],
        }),
      },
      400,
    );

    assert((await unknown.text()).length > 0);
    await emulator.close();
    const unavailable = await turn(bot("local-reply"), "failed");
    assert.equal(unavailable.status, "idle");
    assert(unavailable.error);
    assert.equal(
      unavailable.messages.filter(
        (message) =>
          message.role === "assistant" && message.content === REPLY_TEXT,
      ).length,
      1,
      "Unavailable emulator must not produce a fallback reply",
    );
    await app.close();
    const oldUrl = emulator.url;
    emulator = await startEmulate();
    owned.push(emulator);
    assert.notEqual(
      emulator.url,
      oldUrl,
      "Restart must exercise a different emulator port",
    );
    app = await startLocalApp({
      baseUrl: `${emulator.url}/v1`,
      dataDir,
      port: 0,
    });
    owned.push(app);
    token = authResponse.parse(
      await (await api("/api/auth/sign-in/email", credentials)).json(),
    ).token;
    await checkCatalog();
    assert(
      hasReply(await snapshot(bot("local-reply")), REPLY_TEXT),
      "Saved transcript was not restored",
    );
    const restored = await turn(bot("local-reply"));
    assert.equal(restored.status, "idle");
    assert.equal(
      restored.messages.filter(
        (message) =>
          message.role === "assistant" && message.content === REPLY_TEXT,
      ).length,
      2,
    );
    assert(
      (await calls()).some(
        (entry) =>
          entry.model === "local-reply" && entry.matched?.id === "local-reply",
      ),
      "Restored bot did not use the new endpoint",
    );

    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("pre-existing listener"),
    });

    try {
      const port = listener.port;
      assert(port);
      await assert.rejects(async () => {
        const unexpected = await startLocalApp({
          baseUrl: `${emulator.url}/v1`,
          dataDir: join(dataDir, "occupied"),
          port,
        });

        owned.push(unexpected);
      }, /exited before readiness/);
      assert.equal(
        await (await request(`http://127.0.0.1:${listener.port}`)).text(),
        "pre-existing listener",
      );
    } finally {
      await listener.stop(true);
    }

    process.stdout.write(
      `PASS authenticated app: five models, fixed reply, ${partials.size} streamed partials, history_search, provider error, abort, strict mismatch, no fallback, restart persistence/new endpoint, occupied-port preservation\n`,
    );
  } finally {
    for (const stream of streams) {
      stream.abort();
    }

    if (app) {
      await Promise.allSettled(
        [...bots.values()].map((id) => api(`/v1/agents/${id}/abort`, {}, 204)),
      );
    }
    await closeChildren(owned);
    await rm(dataDir, { recursive: true, force: true });
  }
}

await transportSmoke();

await applicationSmoke();
