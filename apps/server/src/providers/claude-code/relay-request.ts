// Ported from Hermes' claude-subscription-directsdk admission.py (MIT, see THIRD_PARTY_NOTICES.md).
import { z } from "zod";

const UNCACHEABLE = new Set(["thinking", "redacted_thinking"]);

// Anthropic's cache lookup checks at most this many positions back from a breakpoint, the breakpoint itself
// included, and allows this many breakpoints across tools, system and messages.
const LOOKBACK = 20;
const MAX_BREAKPOINTS = 4;

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
  const start = uniqueFrameStart(content, queried);

  if (start === undefined || start === 0) return false;

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

function singleBlock(content: Message["content"] | undefined) {
  if (content === undefined) return;

  if (Array.isArray(content))
    return content.length === 1 ? content[0] : undefined;

  return { type: "text", text: content };
}

function dateTail(last: Message | undefined) {
  const tail: Block | undefined = singleBlock(last?.content);

  return last?.role === "system" &&
    tail?.type === "text" &&
    DATE_LINE.test(tail.text ?? "")
    ? tail
    : undefined;
}

function appendToEnvironment(environment: Message, line: string) {
  const original = environment.content;

  const target: Block | undefined = Array.isArray(original)
    ? original.at(-1)
    : { type: "text", text: original };

  if (target?.type !== "text" || (target.text ?? "").endsWith(line))
    return false;

  if (Array.isArray(original)) target.text = `${target.text ?? ""}\n\n${line}`;
  else environment.content = `${original}\n\n${line}`;

  return true;
}

function carryMark(target: Block | undefined, mark: Block["cache_control"]) {
  if (mark && target) target.cache_control ??= mark;
}

function relocateDate(messages: Message[]) {
  const last = messages.at(-1);

  const environment = messages
    .slice(0, -1)
    .find((item) => item.role === "system");

  const tail = dateTail(last);

  if (!last || !environment || !tail) return false;

  const line = tail.text ?? "";

  if (!appendToEnvironment(environment, line)) return false;
  const mark = tail.cache_control ?? cacheControlOf(last);

  messages.pop();
  carryMark(listContent(messages.at(-1))?.at(-1), mark);

  return true;
}

function uniqueFrameStart(blocks: Block[], queried: readonly Block[]) {
  const hits = [];

  for (let start = 0; start <= blocks.length - queried.length; start++)
    if (sameBlocks(blocks.slice(start, start + queried.length), queried))
      hits.push(start);

  return hits.length === 1 ? hits[0] : undefined;
}

const contextText = (entry: Block) =>
  entry.type === "text" &&
  Object.keys(entry).every((key) =>
    ["type", "text", "cache_control"].includes(key),
  );

function dropHistoricalContext(
  messages: Message[],
  queried: readonly Block[] | undefined,
) {
  const newest = messages.findLast((item) => item.role === "user");
  const blocks = listContent(newest);

  if (
    !queried?.some((entry) => entry.type !== "tool_result") ||
    !blocks ||
    !messages.some((item) => item.role === "assistant")
  )
    return false;

  const start = uniqueFrameStart(blocks, queried);

  if (!start || !blocks.slice(0, start).every(contextText)) return false;

  const mark = blocks
    .slice(0, start)
    .find((entry) => entry.cache_control)?.cache_control;

  blocks.splice(0, start);
  carryMark(blocks[0], mark);

  return true;
}

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
  const relocated = relocateDate(value.messages);
  const dropped = dropHistoricalContext(value.messages, queried);

  return relocated || dropped ? encode(value) : payload;
}

// A top-level message mark, which the schema leaves among the unread fields.
const cacheControlOf = (item: Message) => {
  const parsed = cacheControl.safeParse(item["cache_control"]);

  return parsed.success ? parsed.data : undefined;
};

const opensTurn = (item: Message) =>
  item.role === "user" &&
  (!Array.isArray(item.content) ||
    item.content.some((entry) => entry.type !== "tool_result"));

function turnFrameIndex(messages: Message[], last: number) {
  const opening = messages.slice(0, last).findLastIndex(opensTurn);

  if (opening < 0) return;

  const offset = messages
    .slice(opening + 1, last + 1)
    .findIndex(
      (item) =>
        item.role === "assistant" &&
        listContent(item)?.some((entry) => UNCACHEABLE.has(entry.type)),
    );

  if (offset < 0) return;
  const thought = opening + 1 + offset;

  const user = messages
    .slice(opening + 1, thought)
    .findLastIndex((item) => item.role === "user");

  return user < 0 ? opening : opening + 1 + user;
}

const blockCount = (item: Message) =>
  Array.isArray(item.content) ? item.content.length : 1;

function moveTurnMark(
  value: Body,
  messages: Message[],
  from: Position,
  target: Position,
) {
  const later = positions(messages).filter(
    (entry) => entry.block.cache_control && before(from, entry),
  );

  const next = later[0]?.block.cache_control;

  if (!next) return false;

  if (breakpoints(value) < MAX_BREAKPOINTS) {
    from.block.cache_control = structuredClone(next);

    return true;
  }

  const spare = later.find((entry) => before(entry, target));

  if (!spare?.block.cache_control || !target.block.cache_control) return false;
  from.block.cache_control = spare.block.cache_control;
  delete spare.block.cache_control;

  return true;
}

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
  const frame = turnFrameIndex(messages, last);

  if (frame === undefined) return false;
  const content = listContent(messages[frame]);

  if (!content) return false;

  const mark = content.findLastIndex((entry) => !UNCACHEABLE.has(entry.type));

  const marked = content[mark];

  if (!marked || marked.cache_control) return false;
  const from = { message: frame, index: mark, block: marked };

  if (!before(from, target)) return false;

  const span = messages
    .slice(frame, target.message)
    .reduce((total, item) => total + blockCount(item), 0);

  if (span - mark + target.index + 1 <= LOOKBACK) return false;

  return moveTurnMark(value, messages, from, target);
}

function stableSpan(
  messages: Message[],
  last: number,
  queried: readonly Block[],
) {
  const stable = positions(messages).filter((entry) => entry.message <= last);
  const newest = messages[last + 1];

  const newestContent =
    newest?.role === "user" ? listContent(newest) : undefined;

  if (!newestContent) return stable;
  const prefix: Position[] = [];

  for (const [index, sent] of newestContent.entries()) {
    const host = queried[index];

    if (!host || !Bun.deepEquals(plain(sent), plain(host))) break;
    prefix.push({ message: last + 1, index, block: sent });
  }

  if (newestContent[prefix.length]?.type !== "tool_result")
    stable.push(...prefix);

  return stable;
}

function foldMarks(marked: readonly Position[], target: Position | undefined) {
  const after = target ? marked.filter((entry) => before(target, entry)) : [];
  const moved = after[0]?.block.cache_control;

  if (target === undefined || moved === undefined) return false;

  for (const entry of after) delete entry.block.cache_control;
  target.block.cache_control ??= moved;

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

  const marked = positions(messages).filter(
    (entry) => entry.block.cache_control,
  );

  if (marked.length === 0) return payload;
  const last = messages.findLastIndex((item) => item.role === "assistant");

  const target = stableSpan(messages, last, queried).findLast(
    (entry) => !UNCACHEABLE.has(entry.block.type),
  );

  const folded = foldMarks(marked, target);

  const turn =
    target !== undefined && keepTurnMark(value, messages, last, target);

  if (!(reordered || folded || turn)) return payload;

  return encode(value);
}

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
  if (value === undefined) return;

  if (!Array.isArray(value)) return value;

  return value.every(bareText)
    ? value.map((entry) => entry.text ?? "").join("")
    : undefined;
};

function restoreContent(sent: Block["content"], host: Block["content"]) {
  if (!Array.isArray(host) || !Array.isArray(sent)) {
    const left = joinedText(sent);
    const right = joinedText(host);

    if (left === undefined || right === undefined || !left.startsWith(right))
      return unmatched();

    return structuredClone(host);
  }

  return restoreSequence(sent, host);
}

function restoreToolResult(sent: Block, host: Block, restored: Block) {
  // Missing means false.
  if ((sent.is_error ?? false) !== (host.is_error ?? false)) return unmatched();

  const ignored = ["content", "is_error", "cache_control"];

  if (!Bun.deepEquals(without(sent, ...ignored), without(host, ...ignored)))
    return unmatched();

  if ("content" in sent !== "content" in host) return unmatched();

  if ("content" in host)
    restored.content = restoreContent(sent.content, host.content);
}

function restoreBlock(sent: Block, host: Block): Block {
  const restored = structuredClone(host);

  if (host.type === "tool_result") restoreToolResult(sent, host, restored);
  else if (!Bun.deepEquals(plain(sent), plain(host))) return unmatched();

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

function bareTextRun(blocks: Block[], start: number) {
  let end = start + 1;

  while (end < blocks.length && bareText(blocks[end] ?? { type: "" })) end++;

  const text = blocks
    .slice(start, end)
    .map((entry) => entry.text ?? "")
    .join("");

  return { end, text };
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
      const original = bareTextRun(host, hostIndex);
      const actual = bareTextRun(sent, sentIndex);

      if (
        !(original.end === host.length
          ? actual.text.startsWith(original.text)
          : actual.text === original.text)
      )
        return unmatched();
      restored.push(...structuredClone(host.slice(hostIndex, original.end)));
      hostIndex = original.end;
      sentIndex = actual.end;
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

function newestToolTurn(messages: Message[]) {
  const newest =
    messages[messages.findLastIndex((item) => item.role === "assistant") + 1];

  return newest?.role === "user" ? newest : undefined;
}

function queriedResultIds(queried: readonly Block[]) {
  const ids = queried.flatMap((entry) =>
    entry.type === "tool_result" ? [entry.tool_use_id ?? ""] : [],
  );

  if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
    return unmatched();

  return ids;
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
  const newest = newestToolTurn(value.messages);
  const native = listContent(newest);

  if (!newest || !native) return unmatched();

  const nativeIds = native.flatMap((entry) =>
    entry.type === "tool_result" ? [entry.tool_use_id] : [],
  );

  if (!Bun.deepEquals(queriedResultIds(queried), nativeIds)) return unmatched();
  const restored = restoreSequence(native, [...queried]);

  if (Bun.deepEquals(native, restored)) return payload;
  newest.content = restored;

  return encode(value);
}
