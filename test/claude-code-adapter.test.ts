import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  normalizeContext,
  Type,
  type AssistantMessage,
  type Message,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  CLAUDE_CODE_API,
  streamClaudeCode,
  type AdapterOptions,
} from "../src/claude-code/adapter";
import type { ClaudeCodeStatus } from "../src/claude-code/setup";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.ts");

type Reply = { status?: number; events: object[]; cut?: boolean };

let upstream: ReturnType<typeof Bun.serve> | undefined;
let requests: string[] = [];
let dirs: string[] = [];

beforeAll(() => chmodSync(FAKE, 0o755));

afterEach(async () => {
  await upstream?.stop(true);
  upstream = undefined;
  requests = [];

  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "crumble-claude-test-"));

  dirs.push(dir);

  return dir;
};

/** A fake Anthropic upstream answering each request with the next scripted reply. */
function serve(replies: Reply[]) {
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push(await request.text());
      const reply = replies.shift() ?? replies.at(-1);

      if (!reply) return new Response("no reply scripted", { status: 500 });

      const body = reply.events
        .map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`)
        .join("");

      return new Response(body, {
        status: reply.status ?? 200,
        headers: {
          "content-type": reply.status
            ? "application/json"
            : "text/event-stream",
        },
      });
    },
  });

  return `http://127.0.0.1:${upstream.port}`;
}

const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 2,
};

const start = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [],
    stop_reason: null,
    usage,
  },
};

const textReply = (text: string, stop = "end_turn"): object[] => [
  start,
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: stop },
    usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
];

const toolReply = (name: string, json: string): object[] => [
  start,
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_1", name, input: {} },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: json },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
];

const model: Model<typeof CLAUDE_CODE_API> = {
  id: "claude-sonnet-5-5",
  name: "Sonnet 5.5",
  api: CLAUDE_CODE_API,
  provider: "claude-code",
  baseUrl: "process://claude-code",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1_000_000,
  maxTokens: 64_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const lookup = {
  name: "lookup",
  description: "Look something up",
  parameters: Type.Object({ query: Type.String() }),
};

const signedIn: ClaudeCodeStatus = {
  status: "signed_in",
  cliVersion: "2.1.309",
  plan: "Claude Max",
};

/** Adapter options around the fake CLI; `fake` settings reach it through its config directory, `env` through Crumble's. */
function adapter(
  url: string,
  fake: Record<string, string> = {},
  status: ClaudeCodeStatus = signedIn,
  env: Record<string, string> = {},
): AdapterOptions & { invalidated: number } {
  const dir = tempDir();

  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "fake.json"), JSON.stringify(fake));

  const options = {
    command: FAKE,
    configDir: join(dir, "config"),
    workDir: join(dir, "work"),
    telemetry: true,
    env: { PATH: process.env["PATH"] ?? "", HOME: dir, ...env },
    upstream: url,
    status: async () => status,
    invalidated: 0,
    invalidateStatus: () => {
      options.invalidated++;
    },
  };

  return options;
}

const user = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: 1,
});

async function collect(
  options: AdapterOptions,
  messages: Message[],
  stream?: SimpleStreamOptions,
) {
  const events = streamClaudeCode(
    options,
    model,
    normalizeContext({
      systemPrompt: "You are a bot.",
      messages,
      tools: [lookup],
    }),
    stream,
  );

  const kinds: string[] = [];

  for await (const event of events) kinds.push(event.type);

  return { kinds, message: await events.result() };
}

const textOf = (message: AssistantMessage) =>
  message.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("");

const requestBody = z.looseObject({
  model: z.string(),
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
  messages: z.array(z.looseObject({ role: z.string(), content: z.json() })),
});

describe("Claude Code adapter", () => {
  test("streams a text answer with its usage through one upstream request", async () => {
    const options = adapter(serve([{ events: textReply("Hello there") }]));
    const { kinds, message } = await collect(options, [user("hi")]);

    expect(message.stopReason).toBe("stop");
    expect(textOf(message)).toBe("Hello there");
    expect(kinds).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(message.usage).toMatchObject({
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 2,
    });
    expect(requests).toHaveLength(1);
    const sent = requestBody.parse(JSON.parse(requests[0] ?? ""));

    expect(sent.model).toBe("claude-sonnet-5-5[1m]");
    expect(sent.tools?.map((tool) => tool.name)).toEqual([
      "mcp__crumble__lookup",
    ]);
  });

  test("returns a tool call under Crumble's name when the CLI stops at its turn limit", async () => {
    const options = adapter(
      serve([
        { events: toolReply("mcp__crumble__lookup", '{"query":"weather"}') },
      ]),
    );

    const { message } = await collect(options, [user("look it up")]);

    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([
      {
        type: "toolCall",
        id: "toolu_1",
        name: "lookup",
        arguments: { query: "weather" },
      },
    ]);
    expect(requests).toHaveLength(1);
  });

  test("replays earlier turns in order, one acknowledged frame at a time", async () => {
    const options = adapter(serve([{ events: textReply("done") }]));

    const history: Message[] = [
      user("first"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan", thinkingSignature: "sig" },
          {
            type: "toolCall",
            id: "toolu_0",
            name: "lookup",
            arguments: { query: "x" },
          },
        ],
        api: CLAUDE_CODE_API,
        provider: "claude-code",
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_0",
        toolName: "lookup",
        content: [{ type: "text", text: "sunny" }],
        isError: false,
        timestamp: 3,
      },
      user("thanks"),
    ];

    await collect(options, history);
    const sent = requestBody.parse(JSON.parse(requests[0] ?? ""));

    expect(sent.messages.map((item) => item.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(sent.messages[1]?.content).toEqual([
      { type: "thinking", thinking: "plan", signature: "sig" },
      {
        type: "tool_use",
        id: "toolu_0",
        name: "mcp__crumble__lookup",
        input: { query: "x" },
      },
    ]);
    expect(sent.messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_0", content: "sunny" },
      { type: "text", text: "thanks" },
    ]);
  });

  test("refuses the CLI's recovery request and keeps the first response", async () => {
    const options = adapter(
      serve([
        { events: textReply("cut", "max_tokens") },
        { events: textReply("second") },
      ]),
      { FAKE_RECOVER: "1" },
    );

    const { message } = await collect(options, [user("long answer")]);

    expect(message.stopReason).toBe("length");
    expect(textOf(message)).toBe("cut");
    expect(requests).toHaveLength(1);
  });

  test("fails a truncated stream without releasing tool calls", async () => {
    const events = toolReply("mcp__crumble__lookup", '{"query":"x"}').slice(
      0,
      4,
    );

    const options = adapter(serve([{ events }]));
    const { message } = await collect(options, [user("go")]);

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("Incomplete upstream response");
    expect(message.content.some((item) => item.type === "toolCall")).toBe(
      false,
    );
  });

  test("runs no tool from a response whose tool call was cut off mid-argument", async () => {
    const events = [
      start,
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "mcp__crumble__lookup",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"x"}' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_2",
          name: "mcp__crumble__lookup",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"query":"cut' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];

    const options = adapter(serve([{ events }]));
    const { message } = await collect(options, [user("go")]);

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("Incomplete tool call");
    expect(message.content.some((item) => item.type === "toolCall")).toBe(
      false,
    );
  });

  test("reports an upstream rejection with its status", async () => {
    const options = adapter(serve([{ status: 529, events: [] }]));
    const { message } = await collect(options, [user("go")]);

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("status 529");
  });

  test("finishes a refusal as an error with its explanation and no tool calls", async () => {
    const events = toolReply("mcp__crumble__lookup", '{"query":"x"}').map(
      (event) =>
        "delta" in event && "type" in event && event.type === "message_delta"
          ? {
              type: "message_delta",
              delta: {
                stop_reason: "refusal",
                stop_details: { explanation: "Declined." },
              },
              usage: {},
            }
          : event,
    );

    const options = adapter(serve([{ events }]));
    const { message } = await collect(options, [user("go")]);

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("Declined.");
    expect(message.content.some((item) => item.type === "toolCall")).toBe(
      false,
    );
  });

  test("fails with the status reason and starts no process when Claude Code is not usable", async () => {
    const dir = tempDir();

    const options = adapter(
      "http://127.0.0.1:9",
      { FAKE_PIDS: join(dir, "pids") },
      {
        status: "signed_out",
        cliVersion: "2.1.309",
        message: "Claude Code is not signed in for Crumble.",
      },
    );

    const { message } = await collect(options, [user("go")]);

    expect(message.errorMessage).toStartWith(
      "Claude Code is not signed in for Crumble. Run on the server: CLAUDE_CONFIG_DIR=",
    );
    expect(() => readFileSync(join(dir, "pids"))).toThrow();
  });

  test("hands the CLI only allowlisted environment and its own config directory", async () => {
    const dir = tempDir();

    const options = adapter(
      serve([{ events: textReply("ok") }]),
      { FAKE_ENV: join(dir, "env.json"), FAKE_ARGV: join(dir, "argv.json") },
      signedIn,
      {
        ANTHROPIC_API_KEY: "sk-ant-should-not-pass",
        ANTHROPIC_BASE_URL: "https://elsewhere.example",
        CRUMBLE_TOKEN: "secret",
      },
    );

    await collect(options, [user("go")], { reasoning: "high" });

    const env = z
      .record(z.string(), z.string())
      .parse(JSON.parse(readFileSync(join(dir, "env.json"), "utf8")));

    const argv = z
      .array(z.string())
      .parse(JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")));

    // The fake merges its own settings file into what it was given; only the real environment matters here.
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["CRUMBLE_TOKEN"]).toBeUndefined();
    expect(env["ANTHROPIC_BASE_URL"]).toStartWith("http://127.0.0.1:");
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(options.configDir);
    expect(env["CLAUDE_CODE_MAX_RETRIES"]).toBe("0");
    expect(env["DISABLE_AUTOUPDATER"]).toBe("1");
    expect(argv).toContain("--strict-mcp-config");
    expect(
      argv.slice(argv.indexOf("--max-turns"), argv.indexOf("--max-turns") + 2),
    ).toEqual(["--max-turns", "1"]);
    expect(
      argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2),
    ).toEqual(["--tools", ""]);
    expect(
      argv.slice(argv.indexOf("--effort"), argv.indexOf("--effort") + 2),
    ).toEqual(["--effort", "high"]);
  });

  test("stopping a turn kills the CLI and every process it started", async () => {
    const dir = tempDir();
    const pids = join(dir, "pids");

    const options = adapter(serve([{ events: textReply("never") }]), {
      FAKE_MODE: "hang",
      FAKE_PIDS: pids,
    });

    const controller = new AbortController();
    const done = collect(options, [user("go")], { signal: controller.signal });

    // The fake records the CLI and its grandchild once both run.
    for (let tries = 0; tries < 100; tries++) {
      const lines = readFileSync(pids, { encoding: "utf8", flag: "a+" })
        .trim()
        .split("\n")
        .filter(Boolean);

      if (lines.length >= 2) break;
      await Bun.sleep(20);
    }

    controller.abort();
    const { message } = await done;

    expect(message.stopReason).toBe("aborted");
    await Bun.sleep(200);

    const alive = readFileSync(pids, "utf8")
      .trim()
      .split("\n")
      .filter((pid) => {
        try {
          process.kill(Number(pid), 0);

          return true;
        } catch {
          return false;
        }
      });

    expect(alive).toEqual([]);
  });
});
