// Ported from Hermes' claude-subscription-directsdk admission.py (MIT, see THIRD_PARTY_NOTICES.md).
import { z } from "zod";

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

type CapturedBlock = z.infer<typeof capturedBlock>;

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

type ContentDelta = Extract<
  z.infer<typeof streamEvent>,
  { type: "content_block_delta" }
>;

type MessageDelta = Extract<
  z.infer<typeof streamEvent>,
  { type: "message_delta" }
>;

const knownEvents = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
]);

const TEXT_DELTA_FIELDS = new Map<string, "text" | "thinking" | "signature">([
  ["text_delta", "text"],
  ["thinking_delta", "thinking"],
  ["signature_delta", "signature"],
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
      case "content_block_delta":
        this.applyDelta(event);
        break;
      case "content_block_stop":
        this.finishArguments(event.index);
        break;

      case "message_delta":
        this.applyMessageDelta(event);
        break;
      case "message_stop":
        this.finishMessage();
        break;
    }
  }

  private applyMessageDelta({ delta, usage }: MessageDelta) {
    if (!this.message) return;
    Object.assign(this.message, delta);
    Object.assign(this.message.usage, usage ?? {});
  }

  private applyDelta({ delta, index }: ContentDelta) {
    const target = this.message?.content[index];

    if (!target) throw new Error("Delta for an unknown content block");
    const field = TEXT_DELTA_FIELDS.get(delta.type);

    if (field) target[field] = (target[field] ?? "") + (delta[field] ?? "");
    else this.applyStructuredDelta(target, index, delta);
  }

  private applyStructuredDelta(
    target: CapturedBlock,
    index: number,
    delta: ContentDelta["delta"],
  ) {
    if (delta.type === "input_json_delta")
      this.arguments.set(
        index,
        (this.arguments.get(index) ?? "") + (delta.partial_json ?? ""),
      );
    else if (delta.type === "citations_delta" && delta.citation !== undefined)
      (target.citations ??= []).push(structuredClone(delta.citation));
  }

  private finishArguments(index: number) {
    const raw = this.arguments.get(index);

    if (raw === undefined) return;
    this.arguments.delete(index);
    const target = this.message?.content[index];

    try {
      // A no-argument tool call streams one empty partial_json.
      const input = raw.trim() ? z.json().parse(JSON.parse(raw)) : {};

      if (target) target.input = input;
    } catch {
      // Streamed tool input is not validated: a reply cut off at max_tokens ends mid-argument. The call is
      // dropped at message_stop, never run with guessed arguments.
      this.unparsed.push(index);
    }
  }

  private finishMessage() {
    for (const index of this.unparsed.toSorted((a, b) => b - a))
      this.message?.content.splice(index, 1);
    this.complete = Boolean(
      this.message?.stop_reason && this.arguments.size === 0,
    );
  }
}
