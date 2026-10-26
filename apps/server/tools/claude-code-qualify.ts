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
  type ToolCall,
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

const thinkingBlockEvents = (block: Block, index: number): object[] => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "", signature: "" },
  },
  {
    type: "content_block_delta",
    index,
    delta: { type: "thinking_delta", thinking: block["thinking"] },
  },
  {
    type: "content_block_delta",
    index,
    delta: { type: "signature_delta", signature: block["signature"] },
  },
];

const toolUseBlockEvents = (block: Block, index: number): object[] => [
  {
    type: "content_block_start",
    index,
    content_block: { ...block, input: {} },
  },
  {
    type: "content_block_delta",
    index,
    delta: {
      type: "input_json_delta",
      partial_json: JSON.stringify(block["input"]),
    },
  },
];

const textBlockEvents = (block: Block, index: number): object[] => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text: block["text"] },
  },
];

const blockEvents = (block: Block, index: number): object[] => {
  if (block.type === "thinking") return thinkingBlockEvents(block, index);

  if (block.type === "tool_use") return toolUseBlockEvents(block, index);

  return textBlockEvents(block, index);
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
    events.push(...blockEvents(block, index));
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

/** A local Messages API that answers each parsed request body with `respond`. */
const fixturePeer = (respond: (wire: Wire) => Response) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) =>
      new URL(request.url).pathname === "/v1/messages"
        ? respond(wireBody.parse(await request.json()))
        : new Response("{}", { status: 404 }),
  });

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

const ADMISSION_MODES = [
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
];

const TEXT_BLOCK = { type: "text", text: "FIRST λ" } satisfies Block;

const THINKING_FIXTURE = {
  type: "thinking",
  thinking: "fixture thought",
  signature: "fixture-signature",
} satisfies Block;

const READ_FILE_TOOL = {
  type: "tool_use",
  id: "host_tool_1",
  name: "mcp__crumble__read_file",
  input: { path: "fixture.txt" },
} satisfies Block;

const TOOL_BLOCKS = new Map<string, Block>([
  ["tools", READ_FILE_TOOL],
  ["tool_max", READ_FILE_TOOL],
  [
    "unknown_tool",
    {
      type: "tool_use",
      id: "host_tool_1",
      name: "mcp__fastmail__draft_email",
      input: { to: "fixture" },
    },
  ],
]);

const BASE_BLOCKS = new Map<string, Block[]>([
  ["thinking", [THINKING_FIXTURE]],
]);

const fixtureBlocks = (mode: string): Block[] => {
  const tool = TOOL_BLOCKS.get(mode);

  return [...(BASE_BLOCKS.get(mode) ?? [TEXT_BLOCK]), ...(tool ? [tool] : [])];
};

const ADMISSION_STOP = new Map<string, string>([
  ["max", "max_tokens"],
  ["tool_max", "max_tokens"],
  ["context", "model_context_window_exceeded"],
  ["tools", "tool_use"],
  ["unknown_tool", "tool_use"],
  ["refusal", "refusal"],
]);

const stopFor = (mode: string) =>
  mode === "disconnect" ? undefined : (ADMISSION_STOP.get(mode) ?? "end_turn");

const fixtureError = () =>
  Response.json(
    {
      type: "error",
      error: { type: "rate_limit_error", message: "fixture" },
    },
    { status: 429 },
  );

const fixtureCancel = (onClose: () => void) =>
  new Response(
    new ReadableStream({
      cancel: () => {
        onClose();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

const fixtureAnswer = (mode: string): Response =>
  new Response(
    sse(fixtureBlocks(mode), stopFor(mode), "claude-sonnet-4-6", "msg_fixture"),
    { headers: { "content-type": "text/event-stream" } },
  );

const admissionResponse = (mode: string, onClose: () => void): Response => {
  if (mode === "error") return fixtureError();

  if (mode === "cancel") return fixtureCancel(onClose);

  return fixtureAnswer(mode);
};

type PeerState = { mode: string; closed: boolean };

const replayedToolNames = (bodies: Wire[]): string[] =>
  (bodies.at(-1)?.messages ?? []).flatMap((item) =>
    Array.isArray(item.content)
      ? item.content
          .filter((entry) => entry.type === "tool_use")
          .map((entry) => String(entry["name"]))
      : [],
  );

async function expectUnknownTool(c: AdmissionCase) {
  const calls = c.message.content.filter((item) => item.type === "toolCall");

  check(
    calls[0]?.name === "mcp__fastmail__draft_email",
    "unknown_tool: name changed",
  );
  c.peer.mode = "final";

  const followup = await complete(c.options, "claude-sonnet-4-6", [
    user("Local protocol fixture"),
    c.message,
    {
      role: "toolResult",
      toolCallId: "host_tool_1",
      toolName: "mcp__fastmail__draft_email",
      content: [{ type: "text", text: "Tool does not exist." }],
      isError: true,
      timestamp: 0,
    },
  ]);

  check(textOf(followup) === "FIRST λ", "unknown_tool: followup failed");

  const replayed = replayedToolNames(c.bodies);

  check(
    replayed.join() === "mcp__fastmail__draft_email",
    `unknown_tool: replayed as ${replayed.join()}`,
  );
}

type ContentCheck = (
  c: AdmissionCase,
  calls: ToolCall[],
) => void | Promise<void>;

const contentChecks = new Map<string, ContentCheck>([
  [
    "thinking",
    (c) =>
      check(
        c.message.content.some(
          (item) =>
            item.type === "thinking" &&
            item.thinkingSignature === "fixture-signature",
        ),
        "thinking: signature lost",
      ),
  ],
  [
    "tools",
    (c, calls) =>
      check(
        calls[0]?.name === "read_file",
        `${c.mode}: tool call not mapped back`,
      ),
  ],
  [
    "tool_max",
    (c, calls) =>
      check(
        calls[0]?.name === "read_file",
        `${c.mode}: tool call not mapped back`,
      ),
  ],
  ["unknown_tool", (c) => expectUnknownTool(c)],
]);

async function expectCalls(c: AdmissionCase) {
  const calls = c.message.content.filter((item) => item.type === "toolCall");
  const assertion = contentChecks.get(c.mode);

  if (assertion) return await assertion(c, calls);

  return check(textOf(c.message) === "FIRST λ", `${c.mode}: text lost`);
}

const EXPECTED_STOP = new Map<string, string>([
  ["max", "length"],
  ["context", "length"],
  ["tools", "toolUse"],
  ["tool_max", "toolUse"],
  ["unknown_tool", "toolUse"],
]);

async function expectContent(c: AdmissionCase) {
  const { mode, message } = c;

  check(
    message.usage.input === 101 &&
      message.usage.cacheRead === 211 &&
      message.usage.cacheWrite === 313,
    `${mode}: usage not the first response's`,
  );

  await expectCalls(c);

  const expected = EXPECTED_STOP.get(mode) ?? "stop";

  check(
    message.stopReason === expected,
    `${mode}: stop ${message.stopReason}, expected ${expected}`,
  );
}

async function expectCancel(c: AdmissionCase) {
  c.row.cancel_ms = Math.round(performance.now() - c.started);
  await Bun.sleep(500);
  check(
    c.message.stopReason === "aborted" && c.peer.closed,
    "cancel: upstream connection not closed",
  );
  check((c.row.cancel_ms ?? 0) < 3000, "cancel: took longer than 3 s");
}

async function expectOutcome(c: AdmissionCase) {
  const { mode, message } = c;

  if (["error", "disconnect"].includes(mode))
    return check(message.stopReason === "error", `${mode}: expected an error`);

  if (mode === "cancel") return expectCancel(c);

  if (mode === "refusal")
    return check(
      message.stopReason === "error",
      "refusal: expected a terminal error",
    );

  await expectContent(c);
}

type AdmissionCase = {
  mode: string;
  row: Row;
  message: AssistantMessage;
  options: AdapterOptions;
  bodies: Wire[];
  started: number;
  peer: PeerState;
};

async function admissionCase(mode: string): Promise<Row> {
  const home = mkdtempSync(join(tmpdir(), "crumble-qualify-"));
  let requests = 0;
  const bodies: Wire[] = [];
  const peerState: PeerState = { mode, closed: false };
  let entered: () => void = () => {};

  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });

  const peer = fixturePeer((wire) => {
    bodies.push(wire);
    requests++;
    entered();

    return admissionResponse(peerState.mode, () => {
      peerState.closed = true;
    });
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
    await expectOutcome({
      mode,
      row,
      message,
      options,
      bodies,
      started,
      peer: peerState,
    });

    row.upstream_requests = requests;
    check(
      requests === (mode === "unknown_tool" ? 2 : 1),
      `${mode}: ${requests} upstream requests`,
    );

    return row;
  } finally {
    await peer.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}

/** Every stop reason, error, disconnect, and cancellation: one upstream request each. */
async function admission() {
  const rows = [];

  for (const mode of ADMISSION_MODES) rows.push(await admissionCase(mode));

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

type WireContent = Wire["messages"][number]["content"];

const markIndexes = (value: WireContent): number[] => {
  if (!Array.isArray(value)) return [];

  const found: number[] = [];

  for (const [index, entry] of value.entries())
    if ("cache_control" in entry) found.push(index);

  return found;
};

/** Positions of the message content blocks that carry a cache directive. */
const breakpoints = (wire: Wire | undefined): [number, number][] =>
  (wire?.messages ?? []).flatMap((item, i) =>
    markIndexes(item.content).map((j): [number, number] => [i, j]),
  );

const cacheContext = (messages: Message[], withTools: boolean) =>
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

const CACHE_THINKING = {
  type: "thinking",
  thinking: "PUBLIC SYNTHETIC THINKING",
  signature: "public-fixture-opaque-signature",
} satisfies Block;

const cacheBlocks = (wire: Wire, number: number, tools: boolean): Block[] =>
  tools
    ? [
        CACHE_THINKING,
        {
          type: "tool_use",
          id: `toolu_public_${number}`,
          name: wire.tools[0]?.name ?? "",
          input: {},
        },
      ]
    : [{ type: "text", text: "PUBLIC SYNTHETIC ANSWER" }];

const cacheResponse = (wire: Wire, number: number, tools: boolean) =>
  new Response(
    sse(
      cacheBlocks(wire, number, tools),
      tools ? "tool_use" : "end_turn",
      wire.model,
      `msg_public_${number}`,
    ),
    { headers: { "content-type": "text/event-stream" } },
  );

const earlierAnswer = (index: number): AssistantMessage => ({
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

const cacheHistory = (): Message[] => {
  const history: Message[] = [];

  for (let index = 0; index < 12; index++)
    history.push(
      user(`Public earlier question ${index}`),
      earlierAnswer(index),
    );

  history.push(user("Run the public probe."));

  return history;
};

type CacheRun = {
  modelId: string;
  options: AdapterOptions;
  wires: Wire[];
  peerTools: { value: boolean };
  written: Set<string>;
  receipts: { round: number; prefix: string }[];
  followups: string[];
  history: Message[];
  schedule: boolean[];
  previous: { prefix: Prompt; at: [number, number] } | undefined;
};

const checkPrefix = (run: CacheRun, current: Prompt, round: number) => {
  if (!run.previous) return;

  const candidate = cut(current, run.previous.at);

  check(
    Bun.deepEquals(candidate, run.previous.prefix),
    `cache round ${round}: cached prefix changed`,
  );
  run.receipts.push({ round, prefix: digest(run.previous.prefix) });
};

const findOpening = (wire: Wire, needle: string) =>
  wire.messages.findIndex(
    (item) =>
      item.role === "user" &&
      Array.isArray(item.content) &&
      JSON.stringify(
        content(JSON.parse(JSON.stringify(item.content))),
      ).includes(needle),
  );

const openingFrame = (run: CacheRun, wire: Wire) =>
  findOpening(wire, run.followups.at(-2) ?? "\0");

const onOpeningFrame = (markers: [number, number][], opening: number) =>
  markers.length === 2 && markers[0]?.[0] === opening;

const checkOpening = (
  run: CacheRun,
  wire: Wire,
  current: Prompt,
  markers: [number, number][],
  round: number,
) => {
  if (round !== run.schedule.length - 1) return;

  const first = markers[0];

  check(
    onOpeningFrame(markers, openingFrame(run, wire)),
    `cache: no breakpoint on the loop's opening frame: ${JSON.stringify(markers)}`,
  );

  if (first)
    check(
      run.written.has(digest(cut(current, first))),
      "cache: turn breakpoint not on a written prefix",
    );
};

const recordMarkers = (
  run: CacheRun,
  current: Prompt,
  markers: [number, number][],
) => {
  for (const at of markers) run.written.add(digest(cut(current, at)));
  const last = markers.at(-1);

  if (last) run.previous = { prefix: cut(current, last), at: last };
};

const checkBreakpoints = (
  wire: Wire,
  markers: [number, number][],
  round: number,
) =>
  check(
    markersOf(wire) <= 4 && markers.length >= 1 && markers.length <= 2,
    `cache round ${round}: breakpoints ${markersOf(wire)}/${markers.length}`,
  );

const checkSignature = (wire: Wire, round: number) => {
  if (![1, 2, 5].includes(round)) return;

  check(
    JSON.stringify(wire.messages).includes(
      '"signature":"public-fixture-opaque-signature"',
    ),
    `cache round ${round}: signed thinking lost`,
  );
};

const appendToolResults = (run: CacheRun, message: AssistantMessage) => {
  for (const call of message.content.filter((item) => item.type === "toolCall"))
    run.history.push({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "Public tool result\n".repeat(1000) }],
      isError: false,
      timestamp: 0,
    });
};

const appendTurn = (
  run: CacheRun,
  message: AssistantMessage,
  withTools: boolean,
  round: number,
) => {
  if (withTools) return appendToolResults(run, message);

  run.followups.push(`Public followup ${round}`);
  run.history.push(user(run.followups.at(-1) ?? ""));
};

const streamProbe = (run: CacheRun, messages: Message[]) =>
  streamClaudeCode(
    run.options,
    model(run.modelId),
    cacheContext(messages, true),
  ).result();

async function cacheRound(
  run: CacheRun,
  round: number,
  withTools: boolean,
): Promise<boolean> {
  run.peerTools.value = withTools;
  const start = run.wires.length;

  const message = await streamProbe(run, run.history);

  check(
    message.stopReason !== "error",
    `cache round ${round}: ${message.errorMessage}`,
  );
  check(
    run.wires.length === start + 1,
    `cache round ${round}: extra inference request`,
  );
  const wire = run.wires.at(-1);

  if (!wire) return false;

  const markers = breakpoints(wire);

  checkBreakpoints(wire, markers, round);
  const current = prompt(wire);

  checkPrefix(run, current, round);
  checkOpening(run, wire, current, markers, round);
  recordMarkers(run, current, markers);
  checkSignature(wire, round);
  run.history.push(message);
  appendTurn(run, message, withTools, round);

  return true;
}

/** A tool-less one-shot (a summary) carries no message mark: nothing replays its turn. */
async function checkOneShot(run: CacheRun) {
  run.peerTools.value = false;
  await streamClaudeCode(
    run.options,
    model(run.modelId),
    cacheContext(
      [user("Public transcript to summarize.\n".repeat(200))],
      false,
    ),
  ).result();

  const marks = breakpoints(run.wires.at(-1));

  check(marks.length === 0, `one-shot: ${marks.length} message marks`);
  check(
    run.wires.every((wire) => !JSON.stringify(wire).includes("<total_tokens>")),
    "native budget reminder present",
  );
}

/**
 * Twenty rounds of tool continuations, ordinary turns, and a 14-round loop with thinking: every request must carry
 * the previous request's cached prefix unchanged, keep signed thinking, and stay within four breakpoints. After the
 * long loop the next turn must carry a breakpoint on the loop's opening frame. A tool-less one-shot drops its message
 * marks. This checks exact prefix reuse, not cache hit rates.
 */
async function cacheWire(modelId: string) {
  const home = mkdtempSync(join(tmpdir(), "crumble-qualify-cache-"));
  const wires: Wire[] = [];
  const peerTools = { value: true };

  const peer = fixturePeer((wire) => {
    wires.push(wire);

    return cacheResponse(wire, wires.length, peerTools.value);
  });

  const run: CacheRun = {
    modelId,
    options: adapter(`http://127.0.0.1:${peer.port}`, home),
    wires,
    peerTools,
    written: new Set<string>(),
    receipts: [],
    followups: [],
    history: cacheHistory(),
    schedule: [
      true,
      true,
      false,
      false,
      ...Array<boolean>(14).fill(true),
      false,
      true,
    ],
    previous: undefined,
  };

  try {
    for (const [round, withTools] of run.schedule.entries())
      if (!(await cacheRound(run, round, withTools))) break;

    await checkOneShot(run);

    return { requests: run.wires.length, receipts: run.receipts.length };
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
