// Qualifies a Claude Code version for the adapter: the real CLI against a loopback Messages peer, with a fixture
// API key and no inference or account credentials. Ported from Hermes' evals/directsdk_admission.py and
// evals/directsdk_cache_wire.py (MIT, see THIRD_PARTY_NOTICES.md). Run locally, not in CI:
//   bun tools/claude-code-qualify.ts /absolute/path/to/claude
// A version that passes may be added to QUALIFIED_VERSIONS in src/claude-code/setup.ts.
import {
  normalizeContext,
  Type,
  type AssistantMessage,
  type Message,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  CLAUDE_CODE_API,
  streamClaudeCode,
  type AdapterOptions,
} from "../src/providers/claude-code/adapter";

const binary = process.argv[2];

if (!binary)
  throw new Error(
    "Usage: bun tools/claude-code-qualify.ts /absolute/path/to/claude",
  );

const USAGE = {
  input_tokens: 101,
  output_tokens: 37,
  cache_read_input_tokens: 211,
  cache_creation_input_tokens: 313,
};

const failures: string[] = [];

/** One admission case's receipt. */
type Row = {
  mode: string;
  stop?: string;
  cancel_ms?: number;
  upstream_requests?: number;
};

const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};

const model = (id: string): Model<typeof CLAUDE_CODE_API> => ({
  id,
  name: id,
  api: CLAUDE_CODE_API,
  provider: "claude-code",
  baseUrl: "process://claude-code",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 64_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

type Block = {
  type: string;
  [key: string]: z.infer<ReturnType<typeof z.json>>;
};

function sse(
  blocks: Block[],
  stop: string | undefined,
  modelId: string,
  id: string,
) {
  const events: object[] = [
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: modelId,
        content: [],
        stop_reason: null,
        usage: USAGE,
      },
    },
  ];

  for (const [index, block] of blocks.entries()) {
    if (block.type === "thinking") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block["thinking"] },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: block["signature"] },
      });
    } else if (block.type === "tool_use") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { ...block, input: {} },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block["input"]),
        },
      });
    } else {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block["text"] },
      });
    }

    events.push({ type: "content_block_stop", index });
  }

  if (stop) {
    events.push({
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: USAGE,
    });
    events.push({ type: "message_stop" });
  }

  return events
    .map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

const wireBody = z.looseObject({
  model: z.string(),
  tools: z.array(z.looseObject({ name: z.string() })),
  system: z.array(z.looseObject({})),
  messages: z.array(
    z.looseObject({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(z.looseObject({ type: z.string() })),
      ]),
    }),
  ),
});

type Wire = z.infer<typeof wireBody>;

function adapter(upstream: string, home: string): AdapterOptions {
  return {
    command: binary,
    configDir: join(home, "config"),
    workDir: join(home, "work"),
    telemetry: false,
    env: { PATH: process.env["PATH"] ?? "", HOME: home },
    upstream,
    fixtureEnv: { ANTHROPIC_API_KEY: "sk-ant-public-offline-fixture" },
    status: async () => ({
      status: "signed_in",
      cliVersion: "fixture",
      plan: "",
    }),
    invalidateStatus: () => {},
  };
}

async function complete(
  options: AdapterOptions,
  modelId: string,
  messages: Message[],
  tools = true,
  signal?: AbortSignal,
) {
  const context = normalizeContext({
    systemPrompt: "Public synthetic system.",
    messages,
    tools: tools
      ? [
          {
            name: "read_file",
            description: "Read a fixture",
            parameters: Type.Object({ path: Type.String() }),
          },
        ]
      : [],
  });

  const stream: SimpleStreamOptions = { maxTokens: 2400 };

  if (signal) stream.signal = signal;

  return streamClaudeCode(options, model(modelId), context, stream).result();
}

const textOf = (message: AssistantMessage) =>
  message.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("");

const user = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: 0,
});

/** Every stop reason, error, disconnect, and cancellation: one upstream request each. */
async function admission() {
  const rows = [];

  for (const mode of [
    "final",
    "tools",
    "max",
    "tool_max",
    "context",
    "thinking",
    "refusal",
    "error",
    "disconnect",
    "cancel",
    "unknown_tool",
  ]) {
    const home = mkdtempSync(join(tmpdir(), "crumble-qualify-"));
    let requests = 0;
    let peerMode = mode;
    const bodies: Wire[] = [];
    let entered: () => void = () => {};

    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });

    let closed = false;

    const peer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname !== "/v1/messages")
          return new Response("{}", { status: 404 });
        bodies.push(wireBody.parse(await request.json()));
        requests++;
        entered();

        if (peerMode === "error")
          return Response.json(
            {
              type: "error",
              error: { type: "rate_limit_error", message: "fixture" },
            },
            { status: 429 },
          );

        if (peerMode === "cancel")
          return new Response(
            new ReadableStream({
              cancel: () => {
                closed = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        let blocks: Block[] = [{ type: "text", text: "FIRST λ" }];

        if (peerMode === "thinking")
          blocks = [
            {
              type: "thinking",
              thinking: "fixture thought",
              signature: "fixture-signature",
            },
          ];

        if (peerMode === "tools" || peerMode === "tool_max")
          blocks.push({
            type: "tool_use",
            id: "host_tool_1",
            name: "mcp__crumble__read_file",
            input: { path: "fixture.txt" },
          });

        if (peerMode === "unknown_tool")
          blocks.push({
            type: "tool_use",
            id: "host_tool_1",
            name: "mcp__fastmail__draft_email",
            input: { to: "fixture" },
          });

        const stop =
          peerMode === "disconnect"
            ? undefined
            : ({
                max: "max_tokens",
                tool_max: "max_tokens",
                context: "model_context_window_exceeded",
                tools: "tool_use",
                unknown_tool: "tool_use",
                refusal: "refusal",
              }[peerMode] ?? "end_turn");

        return new Response(
          sse(blocks, stop, "claude-sonnet-4-6", "msg_fixture"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    const options = adapter(`http://127.0.0.1:${peer.port}`, home);
    const row: Row = { mode };

    try {
      const controller = new AbortController();

      const pending = complete(
        options,
        "claude-sonnet-4-6",
        [user("Local protocol fixture")],
        true,
        controller.signal,
      );

      let started = 0;

      if (mode === "cancel") {
        await enteredPromise;
        started = performance.now();
        controller.abort();
      }

      const message = await pending;

      row.stop = message.stopReason;

      if (["error", "disconnect"].includes(mode))
        check(message.stopReason === "error", `${mode}: expected an error`);
      else if (mode === "cancel") {
        row.cancel_ms = Math.round(performance.now() - started);
        await Bun.sleep(500);
        check(
          message.stopReason === "aborted" && closed,
          "cancel: upstream connection not closed",
        );
        check((row.cancel_ms ?? 0) < 3000, "cancel: took longer than 3 s");
      } else if (mode === "refusal")
        check(
          message.stopReason === "error",
          "refusal: expected a terminal error",
        );
      else {
        check(
          message.usage.input === 101 &&
            message.usage.cacheRead === 211 &&
            message.usage.cacheWrite === 313,
          `${mode}: usage not the first response's`,
        );

        const calls = message.content.filter(
          (item) => item.type === "toolCall",
        );

        if (mode === "thinking")
          check(
            message.content.some(
              (item) =>
                item.type === "thinking" &&
                item.thinkingSignature === "fixture-signature",
            ),
            "thinking: signature lost",
          );
        else if (mode === "tools" || mode === "tool_max")
          check(
            calls[0]?.name === "read_file",
            `${mode}: tool call not mapped back`,
          );
        else if (mode === "unknown_tool") {
          check(
            calls[0]?.name === "mcp__fastmail__draft_email",
            "unknown_tool: name changed",
          );
          peerMode = "final";

          const followup = await complete(options, "claude-sonnet-4-6", [
            user("Local protocol fixture"),
            message,
            {
              role: "toolResult",
              toolCallId: "host_tool_1",
              toolName: "mcp__fastmail__draft_email",
              content: [{ type: "text", text: "Tool does not exist." }],
              isError: true,
              timestamp: 0,
            },
          ]);

          check(
            textOf(followup) === "FIRST λ",
            "unknown_tool: followup failed",
          );

          const replayed = (bodies.at(-1)?.messages ?? []).flatMap((item) =>
            Array.isArray(item.content)
              ? item.content
                  .filter((entry) => entry.type === "tool_use")
                  .map((entry) => String(entry["name"]))
              : [],
          );

          check(
            replayed.join() === "mcp__fastmail__draft_email",
            `unknown_tool: replayed as ${replayed.join()}`,
          );
        } else check(textOf(message) === "FIRST λ", `${mode}: text lost`);

        const expected =
          {
            max: "length",
            context: "length",
            tools: "toolUse",
            tool_max: "toolUse",
            unknown_tool: "toolUse",
          }[mode] ?? "stop";

        check(
          message.stopReason === expected,
          `${mode}: stop ${message.stopReason}, expected ${expected}`,
        );
      }

      row.upstream_requests = requests;
      check(
        requests === (mode === "unknown_tool" ? 2 : 1),
        `${mode}: ${requests} upstream requests`,
      );
      rows.push(row);
    } finally {
      await peer.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  }

  return rows;
}

const digest = (value: Prompt) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** Wire content without cache directives, which move to the newest breakpoint and are not cached prompt text. */
function content(
  value: z.infer<ReturnType<typeof z.json>>,
): z.infer<ReturnType<typeof z.json>> {
  if (Array.isArray(value)) return value.map(content);
  const object = z.record(z.string(), z.json()).safeParse(value);

  if (!object.success) return value;

  return Object.fromEntries(
    Object.entries(object.data).flatMap(([key, item]) =>
      key === "cache_control" ? [] : [[key, content(item)]],
    ),
  );
}

const prompt = (wire: Wire) =>
  z
    .looseObject({ messages: z.array(z.looseObject({ content: z.json() })) })
    .parse(
      content(
        JSON.parse(
          JSON.stringify({
            tools: wire.tools,
            system: wire.system,
            messages: wire.messages,
          }),
        ),
      ),
    );

type Prompt = ReturnType<typeof prompt>;

function cut(value: Prompt, at: [number, number]): Prompt {
  const copy = structuredClone(value);

  copy.messages = copy.messages.slice(0, at[0] + 1);
  const last = copy.messages.at(-1);

  if (last && Array.isArray(last.content))
    last.content = last.content.slice(0, at[1] + 1);

  return copy;
}

const markersOf = (wire: Wire) =>
  JSON.stringify(wire).match(/[{,]"cache_control":/g)?.length ?? 0;

/**
 * Twenty rounds of tool continuations, ordinary turns, and a 14-round loop with thinking: every request must carry
 * the previous request's cached prefix unchanged, keep signed thinking, and stay within four breakpoints. After the
 * long loop the next turn must carry a breakpoint on the loop's opening frame. A tool-less one-shot drops its message
 * marks. This checks exact prefix reuse, not cache hit rates.
 */
async function cacheWire(modelId: string) {
  const home = mkdtempSync(join(tmpdir(), "crumble-qualify-cache-"));
  const wires: Wire[] = [];
  let tools = true;

  const thinking = {
    type: "thinking",
    thinking: "PUBLIC SYNTHETIC THINKING",
    signature: "public-fixture-opaque-signature",
  };

  const peer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname !== "/v1/messages")
        return new Response("{}", { status: 404 });
      const wire = wireBody.parse(await request.json());

      wires.push(wire);
      const number = wires.length;

      const blocks: Block[] = tools
        ? [
            thinking,
            {
              type: "tool_use",
              id: `toolu_public_${number}`,
              name: wire.tools[0]?.name ?? "",
              input: {},
            },
          ]
        : [{ type: "text", text: "PUBLIC SYNTHETIC ANSWER" }];

      return new Response(
        sse(
          blocks,
          tools ? "tool_use" : "end_turn",
          wire.model,
          `msg_public_${number}`,
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  const options = adapter(`http://127.0.0.1:${peer.port}`, home);

  const schedule = [
    true,
    true,
    false,
    false,
    ...Array<boolean>(14).fill(true),
    false,
    true,
  ];

  const history: Message[] = [];

  for (let index = 0; index < 12; index++)
    history.push(user(`Public earlier question ${index}`), {
      role: "assistant",
      content: [{ type: "text", text: `Public earlier answer ${index}` }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "earlier",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    });
  history.push(user("Run the public probe."));
  const receipts = [];
  const written = new Set<string>();
  const followups: string[] = [];
  let previous: { prefix: Prompt; at: [number, number] } | undefined;

  const context = (messages: Message[], withTools: boolean) =>
    normalizeContext({
      systemPrompt: "PUBLIC SYNTHETIC SYSTEM\n".repeat(300),
      messages,
      tools: withTools
        ? [
            {
              name: "probe",
              description: "Public probe",
              parameters: Type.Object({}),
            },
          ]
        : [],
    });

  try {
    for (const [round, withTools] of schedule.entries()) {
      tools = withTools;
      const start = wires.length;

      const message = await streamClaudeCode(
        options,
        model(modelId),
        context(history, true),
      ).result();

      check(
        message.stopReason !== "error",
        `cache round ${round}: ${message.errorMessage}`,
      );
      check(
        wires.length === start + 1,
        `cache round ${round}: extra inference request`,
      );
      const wire = wires.at(-1);

      if (!wire) break;

      const messageMarkers = wire.messages.flatMap((item, i) =>
        Array.isArray(item.content)
          ? item.content.flatMap((entry, j): [number, number][] =>
              "cache_control" in entry ? [[i, j]] : [],
            )
          : [],
      );

      check(
        markersOf(wire) <= 4 &&
          messageMarkers.length >= 1 &&
          messageMarkers.length <= 2,
        `cache round ${round}: breakpoints ${markersOf(wire)}/${messageMarkers.length}`,
      );
      const current = prompt(wire);

      if (previous) {
        const candidate = cut(current, previous.at);

        check(
          Bun.deepEquals(candidate, previous.prefix),
          `cache round ${round}: cached prefix changed`,
        );
        receipts.push({ round, prefix: digest(previous.prefix) });
      }

      if (round === schedule.length - 1) {
        const [first, last] = [messageMarkers[0], messageMarkers.at(-1)];

        const opening = wire.messages.findIndex(
          (item) =>
            item.role === "user" &&
            Array.isArray(item.content) &&
            JSON.stringify(
              content(JSON.parse(JSON.stringify(item.content))),
            ).includes(followups.at(-2) ?? "\0"),
        );

        check(
          messageMarkers.length === 2 && first?.[0] === opening,
          `cache: no breakpoint on the loop's opening frame: ${JSON.stringify(messageMarkers)}`,
        );

        if (first && last)
          check(
            written.has(digest(cut(current, first))),
            "cache: turn breakpoint not on a written prefix",
          );
      }

      for (const at of messageMarkers) written.add(digest(cut(current, at)));
      const lastMarker = messageMarkers.at(-1);

      if (lastMarker)
        previous = { prefix: cut(current, lastMarker), at: lastMarker };

      if ([1, 2, 5].includes(round))
        check(
          JSON.stringify(wire.messages).includes(
            '"signature":"public-fixture-opaque-signature"',
          ),
          `cache round ${round}: signed thinking lost`,
        );
      history.push(message);

      if (withTools)
        for (const call of message.content.filter(
          (item) => item.type === "toolCall",
        ))
          history.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [
              { type: "text", text: "Public tool result\n".repeat(1000) },
            ],
            isError: false,
            timestamp: 0,
          });
      else {
        followups.push(`Public followup ${round}`);
        history.push(user(followups.at(-1) ?? ""));
      }
    }

    // A tool-less one-shot (a summary) carries no message mark: nothing replays its turn.
    tools = false;
    await streamClaudeCode(
      options,
      model(modelId),
      context([user("Public transcript to summarize.\n".repeat(200))], false),
    ).result();
    const oneShot = wires.at(-1);

    const oneShotMarks = (oneShot?.messages ?? []).flatMap((item) =>
      Array.isArray(item.content)
        ? item.content.filter((entry) => "cache_control" in entry)
        : [],
    );

    check(
      oneShotMarks.length === 0,
      `one-shot: ${oneShotMarks.length} message marks`,
    );
    check(
      wires.every((wire) => !JSON.stringify(wire).includes("<total_tokens>")),
      "native budget reminder present",
    );

    return { requests: wires.length, receipts: receipts.length };
  } finally {
    await peer.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}

const sha = createHash("sha256").update(readFileSync(binary)).digest("hex");
const version = Bun.spawnSync([binary, "--version"]).stdout.toString().trim();

const report = {
  version,
  sha256: sha,
  admission: await admission(),
  cache: await cacheWire(process.argv[3] ?? "claude-sonnet-5"),
  failures,
};

console.log(JSON.stringify(report, null, 2));

process.exit(failures.length === 0 ? 0 : 1);
