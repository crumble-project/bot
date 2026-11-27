import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  ImageContent,
  JsonObject,
  Model,
  ProviderStreams,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SOMA_URL_ENV,
  abortSomaStream,
  checkSomaProtocol,
  endSomaRun,
  normalizeSomaUrl,
  readSomaError,
  redactToken,
  somaLineSchema,
  somaMissingBlobsSchema,
  somaRequest,
  uploadSomaBlob,
} from "./client";
import type { SomaConnection, SomaMessage, SomaUsage } from "./client";

export const SOMA_API = "soma";
export const SOMA_PROVIDER = "soma";

const OPAQUE_PREFIX = "soma:";
const ABORT_GRACE_MS = 5000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

export type SomaStreamContext = {
  holdsConversation: (upstream: string) => boolean;
};

type EncodedBlock = {
  type: "text" | "thinking" | "tool_call" | "image";
  text?: string;
  callId?: string;
  name?: string;
  args?: JsonObject;
  mime?: string;
  blob?: string;
  opaque?: z.output<typeof jsonValueSchema>;
};

type EncodedMessage = {
  role: "user" | "assistant" | "tool";
  blocks: Array<EncodedBlock>;
  callId?: string;
  toolName?: string;
  isError?: boolean;
  provider?: string;
  model?: string;
};

type EncodedRequest = {
  upstream: string;
  model: string;
  system: string;
  messages: Array<EncodedMessage>;
  tools: Array<{ name: string; description: string; schema: unknown }>;
  blobs: Record<string, string>;
  blobBytes: Map<string, Uint8Array<ArrayBuffer>>;
};

const jsonObjectSchema = z.record(z.string(), z.json());
const jsonValueSchema = z.json();

export function splitSomaModelId(modelId: string) {
  const slash = modelId.indexOf("/");

  if (slash <= 0 || slash === modelId.length - 1) {
    throw new Error(
      `Soma model "${modelId}" must have the form <upstream>/<model>`,
    );
  }

  return {
    upstream: modelId.slice(0, slash),
    model: modelId.slice(slash + 1),
  };
}

function decodeOpaque(signature: string | undefined) {
  if (!signature?.startsWith(OPAQUE_PREFIX)) {
    return undefined;
  }

  try {
    const parsed = jsonValueSchema.safeParse(
      JSON.parse(signature.slice(OPAQUE_PREFIX.length)),
    );

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function encodeOpaque(opaque: z.output<typeof jsonValueSchema> | undefined) {
  if (opaque === undefined || opaque === null) {
    return undefined;
  }

  return `${OPAQUE_PREFIX}${JSON.stringify(opaque)}`;
}

function registerImage(
  image: ImageContent,
  blobs: Record<string, string>,
  blobBytes: Map<string, Uint8Array<ArrayBuffer>>,
): EncodedBlock {
  const decoded = Buffer.from(image.data, "base64");
  const bytes = new Uint8Array(decoded.byteLength);

  bytes.set(decoded);
  const hash = createHash("sha256").update(bytes).digest("hex");

  blobs[hash] = hash;
  blobBytes.set(hash, bytes);

  return {
    type: "image",
    mime: image.mimeType,
    blob: hash,
  };
}

function encodeMessages(
  model: Model<Api>,
  context: TranscriptContext,
): EncodedRequest {
  const { upstream, model: upstreamModel } = splitSomaModelId(model.id);
  const system = getCurrentSystemPrompt(context.messages) ?? "";
  const tools = (getCurrentTools(context.messages) ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: tool.parameters,
  }));

  const blobs: Record<string, string> = {};
  const blobBytes = new Map<string, Uint8Array<ArrayBuffer>>();
  const messages: Array<EncodedMessage> = [];

  for (const message of context.messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      const blocks: Array<EncodedBlock> =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content.map((block) =>
              block.type === "image"
                ? registerImage(block, blobs, blobBytes)
                : { type: "text", text: block.text },
            );

      messages.push({ role: "user", blocks });
      continue;
    }

    if (message.role === "assistant") {
      const blocks: Array<EncodedBlock> = [];

      for (const block of message.content) {
        if (block.type === "text") {
          const opaque = decodeOpaque(block.textSignature);

          blocks.push({
            type: "text",
            text: block.text,
            ...(opaque !== undefined && { opaque }),
          });
        } else if (block.type === "thinking") {
          const opaque = decodeOpaque(block.thinkingSignature);

          blocks.push({
            type: "thinking",
            text: block.thinking,
            ...(opaque !== undefined && { opaque }),
          });
        } else {
          const opaque = decodeOpaque(block.thoughtSignature);

          blocks.push({
            type: "tool_call",
            callId: block.id,
            name: block.name,
            args: block.arguments,
            ...(opaque !== undefined && { opaque }),
          });
        }
      }

      messages.push({
        role: "assistant",
        provider: upstream,
        model: upstreamModel,
        blocks,
      });
      continue;
    }

    const blocks: Array<EncodedBlock> = message.content.map((block) =>
      block.type === "image"
        ? registerImage(block, blobs, blobBytes)
        : { type: "text", text: block.text },
    );

    messages.push({
      role: "tool",
      callId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      blocks,
    });
  }

  return {
    upstream,
    model: upstreamModel,
    system,
    messages,
    tools,
    blobs,
    blobBytes,
  };
}

function deterministicSessionId(
  system: string,
  messages: Array<EncodedMessage>,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([system, messages[0] ?? null]))
    .digest();

  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "tool_calls":
      return "toolUse";
    case "length":
      return "length";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    default:
      return "stop";
  }
}

function mapUsage(usage: SomaUsage | null | undefined): Usage {
  if (!usage) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }

  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.reasoning > 0 && { reasoning: usage.reasoning }),
    totalTokens:
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: usage.cost,
    },
  };
}

function asJsonObject(value: unknown): JsonObject {
  const direct = jsonObjectSchema.safeParse(value);

  if (direct.success) {
    return direct.data;
  }

  if (typeof value === "string") {
    try {
      const parsed = jsonObjectSchema.safeParse(JSON.parse(value));

      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      return {};
    }
  }

  return {};
}

function emptyPartial(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: mapUsage(undefined),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function applyFinalMessage(
  finalMessage: SomaMessage,
  partial: AssistantMessage,
  stream: AssistantMessageEventStream,
  hadStreamedContent: boolean,
): void {
  const finalBlocks = finalMessage.blocks ?? [];

  if (!hadStreamedContent) {
    for (const block of finalBlocks) {
      if (block.type === "text") {
        const textSignature = encodeOpaque(block.opaque);
        const content: TextContent = {
          type: "text",
          text: block.text ?? "",
          ...(textSignature !== undefined && { textSignature }),
        };
        const contentIndex = partial.content.length;

        partial.content.push(content);
        stream.push({ type: "text_start", contentIndex, partial });

        if (content.text) {
          stream.push({
            type: "text_delta",
            contentIndex,
            delta: content.text,
            partial,
          });
        }
        stream.push({
          type: "text_end",
          contentIndex,
          content: content.text,
          partial,
        });
      } else if (block.type === "thinking") {
        const thinkingSignature = encodeOpaque(block.opaque);
        const content: ThinkingContent = {
          type: "thinking",
          thinking: block.text ?? "",
          ...(thinkingSignature !== undefined && { thinkingSignature }),
        };
        const contentIndex = partial.content.length;

        partial.content.push(content);
        stream.push({ type: "thinking_start", contentIndex, partial });

        if (content.thinking) {
          stream.push({
            type: "thinking_delta",
            contentIndex,
            delta: content.thinking,
            partial,
          });
        }
        stream.push({
          type: "thinking_end",
          contentIndex,
          content: content.thinking,
          partial,
        });
      }
    }
  } else {
    let textCursor = 0;
    let thinkingCursor = 0;

    for (const block of finalBlocks) {
      if (block.type === "text") {
        const textSignature = encodeOpaque(block.opaque);

        if (textSignature !== undefined) {
          while (
            textCursor < partial.content.length &&
            partial.content[textCursor]?.type !== "text"
          ) {
            textCursor++;
          }

          const existing = partial.content[textCursor];

          if (existing?.type === "text") {
            existing.textSignature = textSignature;
            textCursor++;
          }
        }
      } else if (block.type === "thinking") {
        const thinkingSignature = encodeOpaque(block.opaque);

        if (thinkingSignature !== undefined) {
          while (
            thinkingCursor < partial.content.length &&
            partial.content[thinkingCursor]?.type !== "thinking"
          ) {
            thinkingCursor++;
          }

          const existing = partial.content[thinkingCursor];

          if (existing?.type === "thinking") {
            existing.thinkingSignature = thinkingSignature;
            thinkingCursor++;
          }
        }
      }
    }
  }

  for (const block of finalBlocks) {
    if (block.type !== "tool_call") {
      continue;
    }

    const thoughtSignature = encodeOpaque(block.opaque);
    const toolCall: ToolCall = {
      type: "toolCall",
      id: block.callId ?? "",
      name: block.name ?? "",
      arguments: asJsonObject(block.args),
      ...(thoughtSignature !== undefined && { thoughtSignature }),
    };
    const contentIndex = partial.content.length;

    partial.content.push(toolCall);
    stream.push({ type: "toolcall_start", contentIndex, partial });
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
  }

  partial.usage = mapUsage(finalMessage.usage);
  partial.stopReason = mapStopReason(finalMessage.stopReason);
}

async function openStream(
  connection: SomaConnection,
  payload: string,
  blobBytes: Map<string, Uint8Array<ArrayBuffer>>,
  signal: AbortSignal,
): Promise<Response> {
  let response = await somaRequest(connection, "POST", "/v1/stream", {
    body: payload,
    contentType: "application/json",
    signal,
  });

  if (response.status === 409) {
    checkSomaProtocol(response);
    const missing = somaMissingBlobsSchema.parse(await response.json());

    for (const hash of missing.missing) {
      const bytes = blobBytes.get(hash);

      if (!bytes) {
        throw new Error(`Soma server requested unknown blob ${hash}`);
      }

      await uploadSomaBlob(connection, hash, bytes, signal);
    }

    response = await somaRequest(connection, "POST", "/v1/stream", {
      body: payload,
      contentType: "application/json",
      signal,
    });
  }

  checkSomaProtocol(response);

  if (!response.ok) {
    throw new Error(await readSomaError(response, connection.token));
  }

  return response;
}

export function somaStreams(context: SomaStreamContext): ProviderStreams {
  const failedSessions = new Set<string>();

  const runStream = (
    model: Model<Api>,
    transcript: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const partial = emptyPartial(model);

    void (async () => {
      const token = options?.apiKey ?? "";
      const rawUrl = options?.env?.[SOMA_URL_ENV] ?? model.baseUrl ?? "";
      const baseUrl = normalizeSomaUrl(rawUrl);

      if (!baseUrl || !token) {
        partial.stopReason = "error";
        partial.errorMessage = "Soma server URL or token is not configured";
        stream.push({ type: "error", reason: "error", error: partial });
        stream.end(partial);

        return;
      }

      const connection: SomaConnection = {
        baseUrl,
        token,
        ...(options?.fetch && { fetch: options.fetch }),
      };

      const encoded = encodeMessages(model, transcript);
      const sessionId =
        options?.sessionId ??
        deterministicSessionId(encoded.system, encoded.messages);
      const sessionKey = `${encoded.upstream}:${sessionId}`;
      const afterFailedStream = failedSessions.has(sessionKey);
      const thinking = options?.reasoning
        ? clampThinkingLevel(model, options.reasoning)
        : "";

      const payload = JSON.stringify({
        upstream: encoded.upstream,
        ...(Object.keys(encoded.blobs).length > 0 && { blobs: encoded.blobs }),
        ...(afterFailedStream && { afterFailedStream: true }),
        request: {
          model: encoded.model,
          system: encoded.system,
          messages: encoded.messages,
          tools: encoded.tools,
          thinking,
          sessionId,
          epoch: "",
        },
      });

      const transportController = new AbortController();
      let streamId: string | undefined;
      let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const idleMs = options?.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          transportController.abort(new Error("Soma stream idle timeout"));
        }, idleMs);
      };

      const onCallerAbort = () => {
        if (streamId) {
          void abortSomaStream(connection, streamId);
          abortGraceTimer = setTimeout(() => {
            transportController.abort(
              new Error("Soma stream did not end after abort"),
            );
          }, ABORT_GRACE_MS);
        } else {
          transportController.abort(
            options?.signal?.reason ?? new Error("Aborted"),
          );
        }
      };

      if (options?.signal?.aborted) {
        partial.stopReason = "aborted";
        partial.errorMessage = "Request aborted";
        stream.push({ type: "error", reason: "aborted", error: partial });
        stream.end(partial);

        return;
      }

      options?.signal?.addEventListener("abort", onCallerAbort, { once: true });

      try {
        stream.push({ type: "start", partial });
        const response = await openStream(
          connection,
          payload,
          encoded.blobBytes,
          transportController.signal,
        );

        failedSessions.delete(sessionKey);

        if (!response.body) {
          throw new Error("Soma stream returned an empty body");
        }

        resetIdle();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let openBlock: { type: "text" | "thinking"; index: number } | undefined;
        let hadStreamedContent = false;
        let finished = false;

        const closeOpenBlock = () => {
          if (!openBlock) {
            return;
          }

          const current = partial.content[openBlock.index];

          if (openBlock.type === "text" && current?.type === "text") {
            stream.push({
              type: "text_end",
              contentIndex: openBlock.index,
              content: current.text,
              partial,
            });
          } else if (
            openBlock.type === "thinking" &&
            current?.type === "thinking"
          ) {
            stream.push({
              type: "thinking_end",
              contentIndex: openBlock.index,
              content: current.thinking,
              partial,
            });
          }

          openBlock = undefined;
        };

        const handleLine = (rawLine: string) => {
          const trimmed = rawLine.trim();

          if (!trimmed) {
            return;
          }

          resetIdle();
          const line = somaLineSchema.parse(JSON.parse(trimmed));

          if (line.stream) {
            streamId = line.stream;

            if (options?.signal?.aborted) {
              onCallerAbort();
            }

            return;
          }

          if (line.keepAlive) {
            return;
          }

          if (line.delta) {
            if (line.delta.kind === "text") {
              hadStreamedContent = true;

              if (openBlock?.type !== "text") {
                closeOpenBlock();
                const contentIndex = partial.content.length;

                partial.content.push({ type: "text", text: "" });
                openBlock = { type: "text", index: contentIndex };
                stream.push({ type: "text_start", contentIndex, partial });
              }

              const current = partial.content[openBlock.index];

              if (current?.type === "text") {
                current.text += line.delta.text;
                stream.push({
                  type: "text_delta",
                  contentIndex: openBlock.index,
                  delta: line.delta.text,
                  partial,
                });
              }
            } else if (line.delta.kind === "thinking") {
              hadStreamedContent = true;

              if (openBlock?.type !== "thinking") {
                closeOpenBlock();
                const contentIndex = partial.content.length;

                partial.content.push({ type: "thinking", thinking: "" });
                openBlock = { type: "thinking", index: contentIndex };
                stream.push({ type: "thinking_start", contentIndex, partial });
              }

              const current = partial.content[openBlock.index];

              if (current?.type === "thinking") {
                current.thinking += line.delta.text;
                stream.push({
                  type: "thinking_delta",
                  contentIndex: openBlock.index,
                  delta: line.delta.text,
                  partial,
                });
              }
            }

            return;
          }

          if (line.done) {
            closeOpenBlock();
            finished = true;

            if (line.message) {
              applyFinalMessage(
                line.message,
                partial,
                stream,
                hadStreamedContent,
              );
            }

            if (line.error) {
              const reason = options?.signal?.aborted ? "aborted" : "error";

              partial.stopReason = reason;
              partial.errorMessage = redactToken(line.error.message, token);
              stream.push({ type: "error", reason, error: partial });
            } else if (
              partial.stopReason === "aborted" ||
              partial.stopReason === "error"
            ) {
              stream.push({
                type: "error",
                reason: partial.stopReason,
                error: partial,
              });
            } else {
              const doneReason =
                partial.stopReason === "length" ||
                partial.stopReason === "toolUse"
                  ? partial.stopReason
                  : "stop";

              stream.push({
                type: "done",
                reason: doneReason,
                message: partial,
              });
            }

            if (
              context.holdsConversation(encoded.upstream) &&
              partial.stopReason !== "toolUse"
            ) {
              void endSomaRun(connection, encoded.upstream, sessionId);
            }
          }
        };

        while (true) {
          const chunk = await reader.read();

          if (chunk.done) {
            if (buffer.trim()) {
              handleLine(buffer);
            }
            break;
          }

          buffer += decoder.decode(chunk.value, { stream: true });
          const parts = buffer.split("\n");

          buffer = parts.pop() ?? "";

          for (const part of parts) {
            handleLine(part);
          }
        }

        if (!finished) {
          failedSessions.add(sessionKey);
          closeOpenBlock();
          const reason = options?.signal?.aborted ? "aborted" : "error";

          partial.stopReason = reason;
          partial.errorMessage = options?.signal?.aborted
            ? "Request aborted"
            : "Soma stream ended unexpectedly";
          stream.push({ type: "error", reason, error: partial });
        }
      } catch (error) {
        if (streamId) {
          failedSessions.add(sessionKey);
        }

        const reason = options?.signal?.aborted ? "aborted" : "error";
        const message = error instanceof Error ? error.message : String(error);

        partial.stopReason = reason;
        partial.errorMessage = redactToken(message, token);
        stream.push({ type: "error", reason, error: partial });
      } finally {
        clearTimeout(abortGraceTimer);
        clearTimeout(idleTimer);
        options?.signal?.removeEventListener("abort", onCallerAbort);
        stream.end(partial);
      }
    })();

    return stream;
  };

  return {
    stream: runStream,
    streamSimple: runStream,
  };
}
