// Ported from Hermes' claude-subscription-directsdk admission.py (MIT, see THIRD_PARTY_NOTICES.md).
import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";

/** Request-scoped native HTTP admission: forwards Claude Code's first Messages request, refuses the rest. */

const UNCACHEABLE = new Set(["thinking", "redacted_thinking"]);

// Anthropic's cache lookup checks at most this many positions back from a breakpoint, the breakpoint itself
// included, and allows this many breakpoints across tools, system and messages.
const LOOKBACK = 20;
const MAX_BREAKPOINTS = 4;

// Native's own byte-level watchdog against api.anthropic.com (180 s); behind the relay it widens to 300 s.
const UPSTREAM_IDLE_MS = 180_000;
const GZIP_HOSTS = new Set(["api.anthropic.com"]);

const GZIP_CA_ENV = [
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
];

const PROXY_ENV = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];

// Claude Code 2.1.302's origin-400 test.
const GO_BAD_JSON =
  /^bad json: (?:invalid character |unexpected EOF$|unexpected end of JSON input$|EOF$)/;

const DENIAL = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "CRUMBLE_MODEL_ADMISSION_CONSUMED",
  },
});

let gzipLatched: string | undefined;

const cacheControl = z.looseObject({ type: z.string() });

const block = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  cache_control: cacheControl.optional(),
  get content() {
    return z.union([z.string(), z.array(block)]).optional();
  },
});

/** A content block of a Messages request, keeping fields this module does not read. */
export type Block = z.infer<typeof block>;

const message = z.looseObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([z.string(), z.array(block)]),
});

type Message = z.infer<typeof message>;

const body = z.looseObject({
  messages: z.array(message),
  tools: z.array(z.looseObject({})).optional(),
});

type Body = z.infer<typeof body>;

type Position = { message: number; index: number; block: Block };

/** The native request, validated; the parsed object itself is returned so its key order survives re-encoding. */
function decode(payload: string): Body | undefined {
  let raw: Body;

  try {
    raw = JSON.parse(payload);
  } catch {
    return undefined;
  }

  // SAFETY: `raw` is JSON.parse output; the schema check below proves the shape before anything reads it.
  return body.safeParse(raw).success ? raw : undefined;
}

const encode = (value: Body) => JSON.stringify(value);

/** A block without the given keys, compared regardless of cache markers or the restored fields. */
function without(entry: Block, ...keys: string[]) {
  const copy = { ...entry };

  for (const key of keys) delete copy[key];

  return copy;
}

const plain = (entry: Block) => without(entry, "cache_control");

const sameBlocks = (left: readonly Block[], right: readonly Block[]) =>
  left.length === right.length &&
  left.every((item, index) => {
    const other = right[index];

    return other !== undefined && Bun.deepEquals(plain(item), plain(other));
  });

/** Every `cache_control` in the request: nested ones (tool_result content) and top-level ones included. */
const breakpoints = (value: Body) =>
  encode(value).match(/[{,]"cache_control":/g)?.length ?? 0;

const listContent = (item: Message | undefined) =>
  Array.isArray(item?.content) ? item.content : undefined;

function positions(messages: Message[]) {
  return messages.flatMap((item, messageIndex) =>
    (listContent(item) ?? []).map((entry, index): Position => ({
      message: messageIndex,
      index,
      block: entry,
    })),
  );
}

const before = (
  left: Position | { message: number; index: number },
  right: Position,
) =>
  left.message < right.message ||
  (left.message === right.message && left.index < right.index);

/**
 * Put the host's first user turn ahead of the context native prepends to it, on the conversation's first request
 * only, so the frame becomes a prefix the next request replays unchanged.
 */
function frameFirst(messages: Message[], queried: readonly Block[]) {
  if (messages.some((item) => item.role === "assistant")) return false;
  const first = messages.find((item) => item.role === "user");
  const content = listContent(first);

  if (!first || !content || content.length <= queried.length) return false;
  const starts = [];

  for (let start = 0; start <= content.length - queried.length; start++)
    if (sameBlocks(content.slice(start, start + queried.length), queried))
      starts.push(start);

  const start = starts[0];

  if (starts.length !== 1 || start === undefined || start === 0) return false;

  if (!content.slice(0, start).every((entry) => entry.type === "text"))
    return false;

  first.content = [
    ...content.slice(start, start + queried.length),
    ...content.slice(0, start),
    ...content.slice(start + queried.length),
  ];

  return true;
}

// The only trailing system text moved: native's date line, exactly as its opening request ends the environment.
const DATE_LINE = /^Today's date is \d{4}-\d{2}-\d{2}\.$/;

/**
 * Keep native's per-request context in the prefix later requests replay: append the trailing date line to the
 * environment message, and drop plain text before the queried frame on later user turns. Anything unexpected
 * forwards unchanged.
 */
export function stableRequestContext(
  payload: string,
  queried: readonly Block[] | undefined,
) {
  const value = decode(payload);

  if (!value) return payload;
  const { messages } = value;
  let changed = false;
  const last = messages.at(-1);

  const environment = messages
    .slice(0, -1)
    .find((item) => item.role === "system");

  const content = last?.content;

  const tail: Block | undefined =
    content === undefined
      ? undefined
      : Array.isArray(content)
        ? content.length === 1
          ? content[0]
          : undefined
        : { type: "text", text: content };

  if (
    last?.role === "system" &&
    environment &&
    tail?.type === "text" &&
    DATE_LINE.test(tail.text ?? "")
  ) {
    const line = tail.text ?? "";
    const original = environment.content;

    const target: Block | undefined = Array.isArray(original)
      ? original.at(-1)
      : { type: "text", text: original };

    if (target?.type === "text" && !(target.text ?? "").endsWith(line)) {
      if (Array.isArray(original))
        target.text = `${target.text ?? ""}\n\n${line}`;
      else environment.content = `${original}\n\n${line}`;
      const mark = tail.cache_control ?? cacheControlOf(last);
      messages.pop();
      const previous = listContent(messages.at(-1));
      const end = previous?.at(-1);

      if (mark && end) end.cache_control ??= mark;
      changed = true;
    }
  }

  const newest = messages.findLast((item) => item.role === "user");
  const blocks = listContent(newest);

  if (
    queried?.length &&
    queried.some((entry) => entry.type !== "tool_result") &&
    blocks &&
    messages.some((item) => item.role === "assistant")
  ) {
    const hits = [];

    for (let start = 0; start <= blocks.length - queried.length; start++)
      if (sameBlocks(blocks.slice(start, start + queried.length), queried))
        hits.push(start);

    const start = hits.length === 1 ? hits[0] : undefined;

    if (
      start &&
      blocks
        .slice(0, start)
        .every(
          (entry) =>
            entry.type === "text" &&
            Object.keys(entry).every((key) =>
              ["type", "text", "cache_control"].includes(key),
            ),
        )
    ) {
      const mark = blocks
        .slice(0, start)
        .find((entry) => entry.cache_control)?.cache_control;

      blocks.splice(0, start);
      const head = blocks[0];

      if (mark && head) head.cache_control ??= mark;
      changed = true;
    }
  }

  return changed ? encode(value) : payload;
}

// A top-level message mark, which the schema leaves among the unread fields.
const cacheControlOf = (item: Message) => {
  const parsed = cacheControl.safeParse(item["cache_control"]);

  return parsed.success ? parsed.data : undefined;
};

/** A user message carrying anything but tool results: a new turn, or a steering message after them. */
const opensTurn = (item: Message) =>
  item.role === "user" &&
  (!Array.isArray(item.content) ||
    item.content.some((entry) => entry.type !== "tool_result"));

/**
 * Keep a breakpoint where the open turn's thinking starts, so the next turn still reads it: after a tool loop longer
 * than the cache lookback, the recurring breakpoint cannot reach that entry. The mark goes on the last cacheable
 * block of the user message right before the turn's first assistant message with thinking, only within the
 * breakpoint limit; at the limit a spare native mark moves there instead.
 */
function keepTurnMark(
  value: Body,
  messages: Message[],
  last: number,
  target: Position,
) {
  let opening: number | undefined;

  for (let index = 0; index < last; index++)
    if (opensTurn(messages[index] ?? { role: "assistant", content: "" }))
      opening = index;

  if (opening === undefined) return false;
  let thought: number | undefined;

  for (let index = opening + 1; index <= last; index++) {
    const item = messages[index];

    if (
      item?.role === "assistant" &&
      listContent(item)?.some((entry) => UNCACHEABLE.has(entry.type))
    ) {
      thought = index;
      break;
    }
  }

  if (thought === undefined) return false;
  let frame = opening;

  for (let index = thought - 1; index > opening; index--)
    if (messages[index]?.role === "user") {
      frame = index;
      break;
    }

  const content = listContent(messages[frame]);

  if (!content) return false;
  let mark: number | undefined;

  for (let index = content.length - 1; index >= 0; index--)
    if (!UNCACHEABLE.has(content[index]?.type ?? "thinking")) {
      mark = index;
      break;
    }

  const marked = mark === undefined ? undefined : content[mark];

  if (
    mark === undefined ||
    !marked ||
    marked.cache_control ||
    !before({ message: frame, index: mark }, target)
  )
    return false;

  const span = messages
    .slice(frame, target.message)
    .reduce(
      (total, item) =>
        total + (Array.isArray(item.content) ? item.content.length : 1),
      0,
    );

  // The recurring breakpoint's own lookback still reaches it.
  if (span - mark + target.index + 1 <= LOOKBACK) return false;

  const later = positions(messages).filter(
    (entry) =>
      entry.block.cache_control &&
      before({ message: frame, index: mark }, entry),
  );

  const next = later[0]?.block.cache_control;

  if (!next) return false;

  if (breakpoints(value) < MAX_BREAKPOINTS) {
    marked.cache_control = structuredClone(next);

    return true;
  }

  const spare = later.find((entry) => before(entry, target));

  if (!spare?.block.cache_control || !target.block.cache_control) return false;
  marked.cache_control = spare.block.cache_control;
  delete spare.block.cache_control;

  return true;
}

/**
 * Keep the recurring message `cache_control` on content the next request replays unchanged: everything through the
 * last assistant message, plus the leading blocks of the newest turn equal to the queried frame. Marks after that
 * span fold onto its last block; system and tools marks are never touched, and the count never grows past four.
 */
export function pinMessageBreakpoint(
  payload: string,
  queried: readonly Block[] | undefined,
) {
  if (!queried?.length) return payload;
  const value = decode(payload);

  if (!value) return payload;
  const { messages } = value;
  const reordered = frameFirst(messages, queried);
  const all = positions(messages);
  const marked = all.filter((entry) => entry.block.cache_control);

  if (marked.length === 0) return payload;
  const last = messages.findLastIndex((item) => item.role === "assistant");
  const stable = all.filter((entry) => entry.message <= last);
  const newest = messages[last + 1];

  const newestContent =
    newest?.role === "user" ? listContent(newest) : undefined;

  if (newestContent) {
    const prefix: Position[] = [];

    for (const [index, sent] of newestContent.entries()) {
      const host = queried[index];

      if (!host || !Bun.deepEquals(plain(sent), plain(host))) break;
      prefix.push({ message: last + 1, index, block: sent });
    }

    if (newestContent[prefix.length]?.type !== "tool_result")
      stable.push(...prefix);
  }

  const target = stable.findLast((entry) => !UNCACHEABLE.has(entry.block.type));
  const after = target ? marked.filter((entry) => before(target, entry)) : [];
  const moved = after[0]?.block.cache_control;
  const folded = target !== undefined && moved !== undefined;

  if (folded) {
    for (const entry of after) delete entry.block.cache_control;
    target.block.cache_control ??= moved;
  }

  const turn =
    target !== undefined && keepTurnMark(value, messages, last, target);

  if (!(reordered || folded || turn)) return payload;

  return encode(value);
}

/** Remove native's message marks from a tool-less one-shot that nothing replays; system and tools marks stay. */
export function dropMessageBreakpoints(payload: string) {
  const value = decode(payload);

  if (!value) return payload;
  let dropped = false;

  for (const item of value.messages)
    for (const entry of listContent(item) ?? [])
      if (entry.cache_control) {
        delete entry.cache_control;
        dropped = true;
      }

  return dropped ? encode(value) : payload;
}

/**
 * Ask the API to stream tool arguments as the model writes them. Native turns this on only for a first-party base
 * URL, so behind the relay a large argument arrives only when complete. A value native already set wins.
 */
export function streamToolInput(payload: string) {
  const value = decode(payload);

  const tools = (value?.tools ?? []).filter(
    (tool) => !("eager_input_streaming" in tool),
  );

  if (!value || tools.length === 0) return payload;

  for (const tool of tools) tool["eager_input_streaming"] = true;

  return encode(value);
}

export class QueriedTurnMismatch extends Error {
  constructor() {
    super("Native request does not uniquely match the queried tool results");
    this.name = "QueriedTurnMismatch";
  }
}

const unmatched = (): never => {
  throw new QueriedTurnMismatch();
};

const bareText = (entry: Block) =>
  entry.type === "text" &&
  entry.text !== undefined &&
  Object.keys(entry).length === 2;

const joinedText = (value: Block["content"]) => {
  if (value === undefined) return undefined;

  if (!Array.isArray(value)) return value;

  return value.every(bareText)
    ? value.map((entry) => entry.text ?? "").join("")
    : undefined;
};

function restoreContent(sent: Block["content"], host: Block["content"]) {
  // Scalar/list equivalence is allowed only for text with no metadata or markers.
  if (!Array.isArray(host) || !Array.isArray(sent)) {
    const left = joinedText(sent);
    const right = joinedText(host);

    if (left === undefined || right === undefined || !left.startsWith(right))
      return unmatched();

    return structuredClone(host);
  }

  return restoreSequence(sent, host);
}

function restoreBlock(sent: Block, host: Block): Block {
  const restored = structuredClone(host);

  if (host.type === "tool_result") {
    // Missing means false.
    if ((sent.is_error ?? false) !== (host.is_error ?? false))
      return unmatched();

    const ignored = ["content", "is_error", "cache_control"];

    if (!Bun.deepEquals(without(sent, ...ignored), without(host, ...ignored)))
      return unmatched();

    if ("content" in sent !== "content" in host) return unmatched();

    if ("content" in host)
      restored.content = restoreContent(sent.content, host.content);
  } else if (!Bun.deepEquals(plain(sent), plain(host))) return unmatched();

  if (sent.cache_control) {
    if (
      host.cache_control &&
      !Bun.deepEquals(sent.cache_control, host.cache_control)
    )
      return unmatched();
    restored.cache_control = structuredClone(sent.cache_control);
  }

  return restored;
}

function restoreSequence(sent: Block[], host: Block[]): Block[] {
  const restored: Block[] = [];
  let hostIndex = 0;
  let sentIndex = 0;

  while (hostIndex < host.length) {
    const hostBlock = host[hostIndex];
    const sentBlock = sent[sentIndex];

    if (!hostBlock || !sentBlock) return unmatched();

    if (bareText(hostBlock) && bareText(sentBlock)) {
      let hostEnd = hostIndex + 1;
      let sentEnd = sentIndex + 1;

      while (hostEnd < host.length && bareText(host[hostEnd] ?? hostBlock))
        hostEnd++;

      while (sentEnd < sent.length && bareText(sent[sentEnd] ?? sentBlock))
        sentEnd++;

      const original = host
        .slice(hostIndex, hostEnd)
        .map((entry) => entry.text ?? "")
        .join("");

      const actual = sent
        .slice(sentIndex, sentEnd)
        .map((entry) => entry.text ?? "")
        .join("");

      // Extensions before a protected host block are insertions, not suffixes.
      if (
        !(hostEnd === host.length
          ? actual.startsWith(original)
          : actual === original)
      )
        return unmatched();
      restored.push(...structuredClone(host.slice(hostIndex, hostEnd)));
      hostIndex = hostEnd;
      sentIndex = sentEnd;
    } else {
      restored.push(restoreBlock(sentBlock, hostBlock));
      hostIndex++;
      sentIndex++;
    }
  }

  if (sent.slice(sentIndex).some((entry) => !bareText(entry)))
    return unmatched();

  return restored;
}

/**
 * Restore the host's exact tool-result frame in the newest user message, anchored by its unique ordered result IDs.
 * Only trailing bare text native added is dropped; anything that cannot be proven lossless throws.
 */
export function restoreQueriedTurn(
  payload: string,
  queried: readonly Block[] | undefined,
) {
  if (
    !queried?.length ||
    !queried.some((entry) => entry.type === "tool_result")
  )
    return payload;
  const value = decode(payload);

  if (!value) return unmatched();

  const last = value.messages.findLastIndex(
    (item) => item.role === "assistant",
  );

  const newest = value.messages[last + 1];
  const native = newest?.role === "user" ? listContent(newest) : undefined;

  if (!newest || !native) return unmatched();

  const resultIds = queried.flatMap((entry) =>
    entry.type === "tool_result" ? [entry.tool_use_id ?? ""] : [],
  );

  if (
    resultIds.some((id) => !id) ||
    new Set(resultIds).size !== resultIds.length
  )
    return unmatched();

  const nativeIds = native.flatMap((entry) =>
    entry.type === "tool_result" ? [entry.tool_use_id] : [],
  );

  if (!Bun.deepEquals(resultIds, nativeIds)) return unmatched();
  const restored = restoreSequence(native, [...queried]);

  if (Bun.deepEquals(native, restored)) return payload;
  newest.content = restored;

  return encode(value);
}

const usage = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
  cache_creation: z
    .looseObject({ ephemeral_1h_input_tokens: z.number().optional() })
    .nullish(),
});

const capturedBlock = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
  data: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.json().optional(),
  citations: z.array(z.json()).optional(),
});

const capturedMessage = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  content: z.array(capturedBlock),
  stop_reason: z.string().nullish(),
  stop_details: z
    .looseObject({
      explanation: z.string().nullish(),
      category: z.string().nullish(),
    })
    .nullish(),
  usage,
});

/** The assistant message the relay captured from the upstream stream. */
export type CapturedMessage = z.infer<typeof capturedMessage>;

const streamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message_start"), message: capturedMessage }),
  z.object({
    type: z.literal("content_block_start"),
    index: z.number(),
    content_block: capturedBlock,
  }),
  z.object({
    type: z.literal("content_block_delta"),
    index: z.number(),
    delta: z.looseObject({
      type: z.string(),
      text: z.string().optional(),
      thinking: z.string().optional(),
      signature: z.string().optional(),
      partial_json: z.string().optional(),
      citation: z.json().optional(),
    }),
  }),
  z.object({ type: z.literal("content_block_stop"), index: z.number() }),
  z.object({
    type: z.literal("message_delta"),
    delta: z.looseObject({
      stop_reason: z.string().nullish(),
      stop_details: capturedMessage.shape.stop_details,
    }),
    usage: z.looseObject({}).optional(),
  }),
  z.object({ type: z.literal("message_stop") }),
]);

const knownEvents = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
]);

const eventType = z.looseObject({ type: z.string() });

/** Builds the upstream's assistant message from its server-sent events. */
export class Capture {
  message: CapturedMessage | undefined;
  complete = false;
  private pending = "";
  private readonly decoder = new TextDecoder();
  private readonly arguments = new Map<number, string>();
  private readonly unparsed: number[] = [];

  /** Tool calls whose streamed arguments were not complete JSON; they were removed from the message. */
  get dropped() {
    return this.unparsed.length;
  }

  feed(chunk: Uint8Array) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    let match = /\r?\n\r?\n/.exec(this.pending);

    while (match) {
      const frame = this.pending.slice(0, match.index);

      this.pending = this.pending.slice(match.index + match[0].length);

      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");

      if (data) this.event(JSON.parse(data));
      match = /\r?\n\r?\n/.exec(this.pending);
    }
  }

  private event(raw: z.input<typeof eventType>) {
    if (!knownEvents.has(eventType.parse(raw).type)) return;
    const event = streamEvent.parse(raw);

    switch (event.type) {
      case "message_start":
        this.message = structuredClone(event.message);
        break;
      case "content_block_start":
        this.message?.content.push(structuredClone(event.content_block));
        break;
      case "content_block_delta": {
        const { delta, index } = event;
        const target = this.message?.content[index];

        if (!target) throw new Error("Delta for an unknown content block");

        if (delta.type === "text_delta")
          target.text = (target.text ?? "") + (delta.text ?? "");
        else if (delta.type === "thinking_delta")
          target.thinking = (target.thinking ?? "") + (delta.thinking ?? "");
        else if (delta.type === "signature_delta")
          target.signature = (target.signature ?? "") + (delta.signature ?? "");
        else if (delta.type === "input_json_delta")
          this.arguments.set(
            index,
            (this.arguments.get(index) ?? "") + (delta.partial_json ?? ""),
          );
        else if (
          delta.type === "citations_delta" &&
          delta.citation !== undefined
        )
          (target.citations ??= []).push(structuredClone(delta.citation));
        break;
      }

      case "content_block_stop": {
        const raw = this.arguments.get(event.index);

        if (raw === undefined) break;
        this.arguments.delete(event.index);
        const target = this.message?.content[event.index];

        try {
          // A no-argument tool call streams one empty partial_json.
          const input = raw.trim() ? z.json().parse(JSON.parse(raw)) : {};

          if (target) target.input = input;
        } catch {
          // Streamed tool input is not validated: a reply cut off at max_tokens ends mid-argument. The call is
          // dropped at message_stop, never run with guessed arguments.
          this.unparsed.push(event.index);
        }

        break;
      }

      case "message_delta":
        if (this.message) {
          Object.assign(this.message, event.delta);
          Object.assign(this.message.usage, event.usage ?? {});
        }

        break;
      case "message_stop":
        for (const index of this.unparsed.toSorted((a, b) => b - a))
          this.message?.content.splice(index, 1);
        this.complete = Boolean(
          this.message?.stop_reason && this.arguments.size === 0,
        );
        break;
    }
  }
}

const goError = z.object({ reason: z.literal("bad_json"), error: z.string() });

const anthropicError = z.object({
  type: z.string().optional(),
  error: z.looseObject({
    type: z.string().optional(),
    message: z.string().optional(),
    details: z.looseObject({ error_code: z.string().optional() }).optional(),
  }),
});

/** Why the origin refused a gzip body, when it did; then the latch turns compression off for the process. */
function rejectionKind(status: number, headers: Headers, text: string) {
  if (![400, 403, 415].includes(status)) return undefined;

  if (
    !(headers.get("request-id") ?? "").startsWith("req_") &&
    !headers.get("cf-ray")
  )
    return "non_anthropic_rejection";

  if (status === 415) return "unsupported_encoding";

  if (status !== 400) return undefined;
  let raw: z.input<typeof anthropicError>;

  try {
    raw = JSON.parse(text);
  } catch {
    return GO_BAD_JSON.test(text.trimEnd())
      ? "invalid_json_at_origin"
      : undefined;
  }

  const go = goError.safeParse(raw);

  if (go.success)
    return GO_BAD_JSON.test(go.data.error)
      ? "invalid_json_at_origin"
      : undefined;
  const parsed = anthropicError.safeParse(raw);

  if (!parsed.success) return undefined;
  const { type, error } = parsed.data;

  if (
    error.details?.error_code === "request_body_encoding_unsupported" ||
    error.message?.startsWith("Unsupported Content-Encoding")
  )
    return "unsupported_encoding";

  // The message prefix counts only in a full Anthropic error envelope.
  if (
    type === "error" &&
    error.type !== undefined &&
    (error.message?.startsWith("The request body is not valid JSON") ||
      error.message?.startsWith(
        "Failed to parse request: could not parse request body as JSON",
      ))
  )
    return "invalid_json_at_origin";

  return undefined;
}

const FORWARDED_REQUEST_HEADERS_EXCLUDED = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "proxy-authorization",
  "proxy-connection",
  "accept-encoding",
]);

// Bun's fetch has already decoded the body and frames it itself.
const FORWARDED_RESPONSE_HEADERS_EXCLUDED = new Set([
  "connection",
  "transfer-encoding",
  "server",
  "date",
  "content-length",
  "content-encoding",
]);

class UpstreamIdle extends Error {
  constructor(seconds: number) {
    super(`no upstream bytes for ${seconds} s`);
    this.name = "UpstreamIdle";
  }
}

/**
 * One loopback listener per model request on a random port and route. Claude Code is pointed at it through
 * `ANTHROPIC_BASE_URL`; its authorization headers pass through memory to the upstream and are never logged or kept.
 */
export class Admission {
  readonly url: string;
  used = false;
  denied = 0;
  status: number | undefined;
  requestId: string | undefined;
  failure: string | undefined;
  unrestored: string | undefined;
  /** A tool-less one-shot that nothing replays: its message marks are dropped instead of moved. */
  oneShot = false;
  readonly capture = new Capture();
  private errorBody = "";
  private cancelled = false;
  private readonly upstream: URL;
  private readonly prefix = `/admit/${randomBytes(32).toString("base64url")}`;
  private readonly controller = new AbortController();
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    upstream: string,
    private readonly timeoutMs: number,
    private readonly queried?: readonly Block[],
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.upstream = new URL(upstream);
    this.env = env;
    const host = this.upstream.hostname;
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(host);

    if (
      (this.upstream.protocol !== "https:" &&
        !(this.upstream.protocol === "http:" && local)) ||
      !host ||
      this.upstream.username ||
      this.upstream.password ||
      this.upstream.search ||
      this.upstream.hash
    )
      throw new Error(
        "Native upstream must be HTTPS or a loopback HTTP fixture",
      );
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // A healthy upstream can think for minutes before its next byte; the upstream idle limit bounds it instead.
      idleTimeout: 0,
      fetch: (request) => this.handle(request),
    });
    this.url = `http://127.0.0.1:${this.server.port}${this.prefix}`;
  }

  /** The upstream's own message for a non-200 answer, empty when none was captured. */
  errorText() {
    try {
      const parsed = z
        .object({ error: z.object({ message: z.string() }) })
        .safeParse(JSON.parse(this.errorBody));

      return parsed.success ? parsed.data.error.message : this.errorBody;
    } catch {
      return this.errorBody;
    }
  }

  abort() {
    this.cancelled = true;
    this.controller.abort();
  }

  async close() {
    this.abort();
    await this.server.stop(true);
  }

  private gzipEligible(payload: string, headers: Headers) {
    return (
      GZIP_HOSTS.has(this.upstream.hostname) &&
      this.upstream.port === "" &&
      !PROXY_ENV.some((name) => this.env[name]) &&
      !GZIP_CA_ENV.some((name) => name in this.env) &&
      !["0", "false", "no", "off"].includes(
        (this.env["CLAUDE_CODE_GZIP_REQUEST_BODIES"] ?? "").toLowerCase(),
      ) &&
      Buffer.byteLength(payload) >= 4096 &&
      gzipLatched === undefined &&
      !headers.has("content-encoding")
    );
  }

  private async handle(request: Request) {
    const path = new URL(request.url);

    if (
      request.method !== "POST" ||
      path.pathname !== `${this.prefix}/v1/messages` ||
      request.headers.has("origin")
    )
      return new Response(null, { status: 404 });

    if (this.cancelled || this.used) {
      this.denied++;

      return new Response(DENIAL, {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    this.used = true;

    try {
      return await this.forward(request, path);
    } catch (error) {
      this.failure = error instanceof Error ? error.name : "Error";

      return new Response(null, { status: 502 });
    }
  }

  private async forward(request: Request, path: URL) {
    let payload = await request.text();

    if (this.oneShot) payload = dropMessageBreakpoints(payload);

    try {
      payload = restoreQueriedTurn(payload, this.queried);
    } catch (error) {
      // Restoration is hygiene, not a gate: a frame it cannot prove lossless forwards as native built it.
      if (!(error instanceof QueriedTurnMismatch)) throw error;
      this.unrestored = error.message;
    }

    payload = stableRequestContext(payload, this.queried);
    payload = pinMessageBreakpoint(payload, this.queried);
    payload = streamToolInput(payload);
    const headers = new Headers();

    for (const [key, value] of request.headers)
      if (!FORWARDED_REQUEST_HEADERS_EXCLUDED.has(key)) headers.set(key, value);
    headers.set("accept-encoding", "identity");
    const route = `${this.upstream.origin}${this.upstream.pathname.replace(/\/$/, "")}/v1/messages${path.search}`;
    const compressed = this.gzipEligible(payload, request.headers);

    const send = (gzip: boolean) => {
      const wire = gzip
        ? Bun.gzipSync(
            Buffer.from(
              `${payload}\n${Array.from({ length: randomInt(257) }, () => (randomInt(2) ? " " : "\t")).join("")}`,
            ),
            { level: 3 },
          )
        : payload;

      const sent = new Headers(headers);

      if (gzip) sent.set("content-encoding", "gzip");

      return fetch(route, {
        method: "POST",
        headers: sent,
        body: wire,
        signal: this.controller.signal,
      });
    };

    let response = await send(compressed);
    let prefix: Uint8Array | undefined;

    if (compressed && [400, 403, 415].includes(response.status)) {
      // Recorded before the body read, so a failed read still reports this answer as an identity send would.
      this.requestId = requestIdOf(response.headers);
      this.status = response.status;
      prefix = new Uint8Array(await response.arrayBuffer());

      const reason = rejectionKind(
        response.status,
        response.headers,
        new TextDecoder().decode(prefix.slice(0, 8192)),
      );

      if (reason) {
        this.requestId = undefined;
        this.status = undefined;
        gzipLatched ??= reason;
        console.warn(
          `request gzip disabled: ${reason} status=${response.status}`,
        );

        if (this.cancelled) return new Response(null, { status: 499 });
        response = await send(false);
        prefix = undefined;
      }
    }

    this.requestId = requestIdOf(response.headers);
    this.status = response.status;
    const forwarded = new Headers();

    for (const [key, value] of response.headers)
      if (!FORWARDED_RESPONSE_HEADERS_EXCLUDED.has(key))
        forwarded.set(key, value);
    forwarded.set("connection", "close");

    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();

    void this.pipe(response, prefix, writable.getWriter());

    return new Response(readable, {
      status: response.status,
      headers: forwarded,
    });
  }

  private async pipe(
    response: Response,
    prefix: Uint8Array | undefined,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {
    const idle = Math.min(this.timeoutMs, UPSTREAM_IDLE_MS);

    const deliver = async (chunk: Uint8Array) => {
      if (response.status === 200) this.capture.feed(chunk);
      else if (this.errorBody.length < 65536)
        // The rejection reason ("prompt is too long"), bounded.
        this.errorBody += new TextDecoder().decode(chunk);
      await writer.write(chunk);
    };

    try {
      if (prefix) await deliver(prefix);
      else if (response.body) {
        const reader = response.body.getReader();

        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined;

          const result = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new UpstreamIdle(idle / 1000)),
                idle,
              );
            }),
          ]).finally(() => clearTimeout(timer));

          if (result.done) break;
          await deliver(result.value);
        }
      }

      await writer.close();
    } catch (error) {
      this.failure = error instanceof Error ? error.name : "Error";
      this.controller.abort();
      await writer.abort(error).catch(() => undefined);
    }
  }
}

const requestIdOf = (headers: Headers) =>
  headers.get("request-id") ?? headers.get("x-request-id") ?? undefined;
