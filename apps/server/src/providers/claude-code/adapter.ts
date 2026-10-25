// Ported from Hermes' claude-subscription-directsdk directsdk.py (MIT, see THIRD_PARTY_NOTICES.md).
import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type Message,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  acceptsThinkingDisable,
  nativeModel,
  supportsAdaptiveThinking,
} from "./catalog";
import { Admission, type Block, type CapturedMessage } from "./relay";
import {
  childEnv,
  installHint,
  resolveClaude,
  signInCommand,
  type ClaudeCodeOptions,
  type ClaudeCodeStatus,
} from "./setup";
import { Match } from "effect";

/** The Pi AI api id of the Claude Code adapter. */
export const CLAUDE_CODE_API = "claude-code";

const PREFIX = "mcp__crumble__";
const INERT_MCP = join(import.meta.dir, "inert-mcp.ts");
// A clean answer returns at the CLI's result event; a CLI that will not exit is killed after this.

const DRAIN_GRACE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 600_000;

// Claude Code's own error codes for errors it answers without a relayed upstream status.
const NATIVE_ERRORS = new Map([
  ["rate_limit", "429 rate limit"],
  ["billing_error", "402 billing error"],
  ["authentication_failed", "401 authentication failed"],
  ["overloaded", "529 overloaded"],
  ["server_error", "503 server error"],
]);

export type AdapterOptions = ClaudeCodeOptions & {
  /** Claude Code's working directory: stable, since the CLI writes it into every request's environment. */
  workDir: string;
  /** Where the relay forwards. Tests point it at a loopback fixture. */
  upstream?: string;
  /** Wire qualification only: environment for the real CLI against a fixture upstream, such as a fixture API key. */
  fixtureEnv?: Record<string, string>;
  /** The cached status, refreshed when it is stale or after an authentication failure. */
  status: () => Promise<ClaudeCodeStatus>;
  invalidateStatus: () => void;
};

type NativeFrame = {
  type: "user" | "assistant";
  message: {
    role: "user" | "assistant";
    content: Block[];
    id?: string;
    type?: string;
    model?: string;
    stop_reason?: string;
  };
  shouldQuery?: boolean;
};

type AssistantFields = Omit<NativeFrame["message"], "role" | "content">;

/** A native session id that stays the same for every request of one conversation. */
function conversationSessionId(system: string, frames: NativeFrame[]) {
  const digest = createHash("sha256")
    .update(JSON.stringify([system, frames[0]?.message ?? null]))
    .digest();

  // UUID version 4 layout over the digest's first 16 bytes.
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Crumble tool names and the names Claude Code sees; names over 50 characters get a stable hashed alias. */
function toolNames(tools: { name: string }[]) {
  const names = new Map<string, string>();
  const native = new Map<string, string>();

  for (const { name } of tools) {
    if (!NAME.test(name) || names.has(name))
      throw new Error(
        "Tool names must be unique ASCII identifiers of at most 64 characters",
      );

    const alias =
      name.length <= 50
        ? name
        : `${name.slice(0, 41)}_${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;

    const other = native.get(alias);

    if (other)
      throw new Error(
        `Tool name collision: ${name} and ${other} map to ${alias}`,
      );
    names.set(name, alias);
    native.set(alias, name);
  }

  return { names, crumble: native };
}

const COMBINATORS = ["oneOf", "allOf", "anyOf"];

const jsonSchema = z.record(z.string(), z.json());

/**
 * Anthropic's validator rejects top-level oneOf/allOf/anyOf and the null branch of nullable unions. The combinators
 * are advisory (Crumble re-validates arguments); nested unions other than nullable ones stay untouched.
 */
export function normalizeInputSchema(schema: z.infer<typeof jsonSchema>) {
  const normalized = stripNullable(schema);

  if (COMBINATORS.some((key) => key in normalized)) {
    for (const key of COMBINATORS) delete normalized[key];
    normalized["type"] ??= "object";
  }

  if (
    normalized["type"] === "object" &&
    !jsonSchema.safeParse(normalized["properties"]).success
  )
    normalized["properties"] = {};

  return normalized;
}

const nullOnly = z.object({ type: z.literal("null") });

function stripNullable(schema: z.infer<typeof jsonSchema>) {
  const copy: z.infer<typeof jsonSchema> = {};

  for (const [key, value] of Object.entries(schema)) {
    const nested = jsonSchema.safeParse(value);

    if (nested.success) copy[key] = stripNullable(nested.data);
    else if (Array.isArray(value))
      copy[key] = value.map((item) => {
        const entry = jsonSchema.safeParse(item);

        return entry.success ? stripNullable(entry.data) : item;
      });
    else copy[key] = value;
  }

  const union = z.array(jsonSchema).safeParse(copy["anyOf"] ?? copy["oneOf"]);

  if (union.success) {
    const others = union.data.filter(
      (member) => !nullOnly.safeParse(member).success,
    );

    if (others.length === 1 && others.length < union.data.length) {
      delete copy["anyOf"];
      delete copy["oneOf"];

      return { ...copy, ...others[0] };
    }
  }

  return copy;
}

const contentBlocks = (
  content: (TextContent | { type: "image"; data: string; mimeType: string })[],
): Block[] =>
  content.flatMap((item): Block[] =>
    item.type === "text"
      ? item.text.trim()
        ? [{ type: "text", text: item.text }]
        : []
      : [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: item.mimeType,
              data: item.data,
            },
          },
        ],
  );

const nativeStop = (reason: StopReason) =>
  Match.value(reason).pipe(
    Match.when("toolUse", () => "tool_use"),
    Match.when("length", () => "max_tokens"),
    Match.orElse(() => "end_turn"),
  );

/** The system prompt and the conversation as stream-json frames, ending in the frame that queries. */
export function prepareHistory(
  context: TranscriptContext,
  model: Model<Api>,
  names: Map<string, string>,
) {
  const system = getCurrentSystemPrompt(context.messages);
  const frames: NativeFrame[] = [];

  const append = (
    role: "user" | "assistant",
    content: Block[],
    extra: AssistantFields = {},
  ) => {
    const last = frames.at(-1);

    if (role === "user" && last?.type === "user")
      last.message.content.push(...content);
    else frames.push({ type: role, message: { ...extra, role, content } });
  };

  for (const message of transformMessages(
    context.messages,
    model,
  ) satisfies Message[]) {
    if (message.role === "system") continue;

    if (message.role === "user") {
      const content = Array.isArray(message.content)
        ? contentBlocks(message.content)
        : message.content.trim()
          ? [{ type: "text", text: message.content }]
          : [];

      if (content.length > 0) append("user", content);
    } else if (message.role === "assistant") {
      const content = message.content.flatMap((item): Block[] => {
        if (item.type === "text")
          return item.text.trim() ? [{ type: "text", text: item.text }] : [];

        if (item.type === "thinking") {
          if (item.redacted)
            return [
              { type: "redacted_thinking", data: item.thinkingSignature ?? "" },
            ];

          if (item.thinkingSignature?.trim())
            return [
              {
                type: "thinking",
                thinking: item.thinking,
                signature: item.thinkingSignature,
              },
            ];

          return item.thinking.trim()
            ? [{ type: "text", text: item.thinking }]
            : [];
        }

        // A call outside the inventory replays as the model named it.
        const name = names.get(item.name);

        return [
          {
            type: "tool_use",
            id: item.id,
            name: name === undefined ? item.name : `${PREFIX}${name}`,
            input: item.arguments,
          },
        ];
      });

      if (content.length > 0)
        append("assistant", content, {
          id: message.responseId ?? `msg_replayed_${frames.length}`,
          type: "message",
          model: message.responseModel ?? nativeModel(model.id),
          stop_reason: nativeStop(message.stopReason),
        });
    } else {
      const text = message.content.every((item) => item.type === "text");

      const result: Block = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: text
          ? message.content
              .map((item) => (item.type === "text" ? item.text : ""))
              .join("\n")
          : contentBlocks(message.content),
      };

      if (message.isError) result.is_error = true;
      append("user", [result]);
    }
  }

  const last = frames.at(-1);

  if (!last || last.type !== "user" || last.message.content.length === 0)
    throw new Error(
      "History must end in a nonempty user or tool-result message; assistant prefill is unsupported",
    );

  return { system, frames };
}

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Generation fields Claude Code applies from its private settings file, plus the effort for `--effort`. */
function requestBody(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
) {
  const body: JsonObject = {};

  const level = options?.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : "off";

  const reasoning = level === "off" ? undefined : level;

  let effort: Effort | undefined;

  if (reasoning === undefined) {
    if (acceptsThinkingDisable(model.id)) {
      body["thinking"] = { type: "disabled" };
      // Clear-thinking context edits are invalid when thinking is disabled.
      body["context_management"] = { edits: [] };
    } else effort = "low";
  } else {
    // Routes without adaptive thinking 400 on the block; their default thinking plus the effort stand in.
    if (supportsAdaptiveThinking(model.id))
      body["thinking"] = { type: "adaptive", display: "summarized" };
    effort = reasoning === "minimal" ? "low" : reasoning;
  }

  if (effort) body["output_config"] = { effort };

  if (options?.maxTokens !== undefined) body["max_tokens"] = options.maxTokens;

  return { body, effort };
}

type StreamJson = z.infer<typeof streamJson>;

const streamJson = z.looseObject({
  type: z.string(),
  subtype: z.string().nullish(),
  num_turns: z.number().nullish(),
  is_error: z.boolean().nullish(),
  error: z.string().nullish(),
  total_cost_usd: z.number().nullish(),
  usage: z.looseObject({}).nullish(),
  // System events such as `permission_denied` carry `message` as plain text, which nothing reads.
  message: z
    .looseObject({
      error: z.json().optional(),
      content: z
        .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
        .optional(),
    })
    .or(z.string().transform(() => undefined))
    .optional(),
  event: z
    .looseObject({
      type: z.string(),
      index: z.number().optional(),
      content_block: z.looseObject({ type: z.string() }).optional(),
      delta: z
        .looseObject({
          type: z.string().optional(),
          text: z.string().optional(),
          thinking: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

/** Reads the CLI's stdout one JSON line at a time, with a read-idle deadline. */
class Lines {
  private readonly queue: (StreamJson | Error | null)[] = [];
  private waiting: (() => void) | undefined;

  constructor(child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout });

    lines.on("line", (line) => {
      if (!line.trim()) return;

      try {
        this.push(streamJson.parse(JSON.parse(line)));
      } catch {
        // The offending line is the whole diagnosis (a shim banner, a stray print); keep it.
        this.push(
          new Error(
            `Invalid native stream-json output: ${JSON.stringify(line.slice(0, 300))}`,
          ),
        );
      }
    });
    child.on("close", () => this.push(null));
  }

  private push(item: StreamJson | Error | null) {
    this.queue.push(item);
    this.waiting?.();
  }

  async next(timeoutMs: number, signal: AbortSignal) {
    while (this.queue.length === 0) {
      if (signal.aborted) throw new Error("Claude request cancelled");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stop: (() => void) | undefined;

      const timedOut = await new Promise<boolean>((resolve) => {
        stop = () => resolve(false);
        this.waiting = stop;
        timer = setTimeout(() => resolve(true), timeoutMs);
        signal.addEventListener("abort", stop, { once: true });
      });

      clearTimeout(timer);

      if (stop) signal.removeEventListener("abort", stop);
      this.waiting = undefined;

      if (timedOut) throw new Error("Claude request timed out");
    }

    const item = this.queue.shift() ?? null;

    if (item instanceof Error) throw item;

    return item;
  }
}

/** Kills Claude Code and every process it started: it runs as the leader of its own process group. */
function killTree(child: ChildProcessWithoutNullStreams) {
  if (
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.pid === undefined
  )
    return;

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

const exited = (child: ChildProcessWithoutNullStreams) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise<number | null>((resolve) =>
        child.once("exit", (code) => resolve(code)),
      );

function piUsage(usage: CapturedMessage["usage"] | undefined): Usage {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  const oneHour = usage?.cache_creation?.ephemeral_1h_input_tokens;

  const result: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    // Subscription use has no per-request price; Claude Code's list-price estimate is not a charge.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  if (oneHour !== undefined) result.cacheWrite1h = oneHour;

  return result;
}

const toolInput = z.record(z.string(), z.json());

/** Runs one model request through a fresh Claude Code process and streams it as Pi AI events. */
export function streamClaudeCode(
  adapter: AdapterOptions,
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: piUsage(undefined),
    stopReason: "pending",
    timestamp: Date.now(),
  };

  void run(adapter, model, context, options, stream, partial).catch(
    (error: Error) => {
      const aborted = options?.signal?.aborted === true;

      stream.push({
        type: "error",
        reason: aborted ? "aborted" : "error",
        error: {
          ...partial,
          stopReason: aborted ? "aborted" : "error",
          errorMessage: aborted ? "Claude request cancelled" : error.message,
        },
      });
    },
  );

  return stream;
}

async function run(
  adapter: AdapterOptions,
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
) {
  stream.push({ type: "start", partial });
  const status = await adapter.status();

  if (status.status === "signed_out")
    throw new Error(
      `${status.message} Run on the server: ${signInCommand(resolveClaude(adapter) ?? "claude", adapter.configDir)}`,
    );

  if (status.status !== "signed_in")
    throw new Error(
      status.status === "cli_missing" ? installHint(adapter) : status.message,
    );
  const command = resolveClaude(adapter);

  if (!command) throw new Error(installHint(adapter));
  const tools = getCurrentTools(context.messages);
  const { names, crumble } = toolNames(tools);
  const { system, frames } = prepareHistory(context, model, names);
  const { body, effort } = requestBody(model, options);

  const manifest = tools.map((tool) => {
    // The manifest (inert MCP server) and the request body must advertise the same schema.
    const schema = normalizeInputSchema(
      jsonSchema.parse(JSON.parse(JSON.stringify(tool.parameters))),
    );

    return {
      name: names.get(tool.name) ?? tool.name,
      description: tool.description,
      inputSchema: schema,
    };
  });

  body["tools"] = manifest.map((tool) => ({
    name: `${PREFIX}${tool.name}`,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const queried = frames.at(-1)?.message.content;

  const admission = new Admission(
    adapter.upstream ?? "https://api.anthropic.com",
    timeoutMs,
    queried,
  );

  admission.oneShot = manifest.length === 0 && frames.length === 1;
  const signal = options?.signal ?? new AbortController().signal;
  const scratch = mkdtempSync(join(tmpdir(), "crumble-claude-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  let handedOff = false;
  const stderr: string[] = [];

  const stderrTail = () => {
    const text = stderr.join("").trim().replaceAll(/\s+/g, " ");

    return text ? ` (native stderr: ${text.slice(0, 400)})` : "";
  };

  const cancel = () => {
    admission.abort();

    if (child) killTree(child);
  };

  signal.addEventListener("abort", cancel, { once: true });

  try {
    writeFileSync(join(scratch, "tools.json"), JSON.stringify(manifest));
    // Settings apply env inside the process, avoiding the per-argument limit for large schemas.
    writeFileSync(
      join(scratch, "settings.json"),
      JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(body) } }),
    );
    writeFileSync(join(scratch, "system.md"), system);
    mkdirSync(adapter.workDir, { recursive: true, mode: 0o700 });

    const env = childEnv(adapter);

    Object.assign(env, adapter.fixtureEnv, {
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_COMPACT: "1",
      // Crumble owns budgets; the replayed reminder invalidates cached history.
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
      ANTHROPIC_BASE_URL: admission.url,
    });

    if (options?.maxTokens !== undefined)
      env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = String(options.maxTokens);

    const mcp = {
      mcpServers: {
        crumble: {
          command: process.execPath,
          args: [INERT_MCP, join(scratch, "tools.json")],
        },
      },
    };

    const args = [
      "-p",
      "--model",
      nativeModel(model.id),
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools",
      "",
      "--system-prompt-file",
      join(scratch, "system.md"),
      "--settings",
      join(scratch, "settings.json"),
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--max-turns",
      "1",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--mcp-config",
      JSON.stringify(mcp),
      // The CLI applies its own effort message, which overrides the request body's effort.
      ...(effort ? ["--effort", effort] : []),
      // One native session per conversation: the CLI names a per-session scratch directory near the top of every
      // request, so a new id per spawn would move the cache prefix on every call.
      "--session-id",
      conversationSessionId(system, frames),
    ];

    if (signal.aborted) throw new Error("Claude request cancelled");
    child = spawn(command, args, {
      env,
      cwd: adapter.workDir,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const cli = child;

    cli.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 40) stderr.push(chunk);
    });

    const spawnError = new Promise<never>((_, reject) =>
      cli.once("error", reject),
    );

    const lines = new Lines(cli);

    const receive = () =>
      Promise.race([lines.next(timeoutMs, signal), spawnError]);

    const send = (data: string) =>
      new Promise<void>((resolve, reject) =>
        cli.stdin.write(data, (error) =>
          error && !signal.aborted ? reject(error) : resolve(),
        ),
      );

    for (const [index, frame] of frames.entries()) {
      const replayed = frame.type === "user" && index < frames.length - 1;

      await send(
        `${JSON.stringify(replayed ? { ...frame, shouldQuery: false } : frame)}\n`,
      );

      if (!replayed) continue;

      for (;;) {
        const ack = await receive();

        if (ack === null) {
          if (signal.aborted) throw new Error("Claude request cancelled");
          throw new Error(
            `Native exited before replay acknowledgment (exit=${cli.exitCode})${stderrTail()}`,
          );
        }

        if (ack.type === "result") {
          if (ack.num_turns !== 0 || ack.is_error)
            throw new Error(
              `Native history replay not supported: expected zero-turn acknowledgment${stderrTail()}`,
            );
          break;
        }
      }
    }

    cli.stdin.end();
    const assistants: StreamJson[] = [];
    const results: StreamJson[] = [];
    let stopped = false;
    let nativeError: string | undefined;
    let nativeErrorCode: string | undefined;
    let fast = false;
    let streamed = "";
    const blocks = new Map<number, number>();

    for (;;) {
      const event = await receive();

      if (event === null) break;

      if (event.type === "assistant") {
        if (event.error || event.message?.error) {
          nativeError = (event.message?.content ?? [])
            .flatMap((item) => (item.type === "text" ? [item.text ?? ""] : []))
            .join("\n");
          nativeErrorCode = event.error ?? undefined;
        } else assistants.push(event);
      } else if (event.type === "result") {
        results.push(event);

        if (fastEligible(event, admission, stopped, nativeError)) {
          fast = true;
          break;
        }
      } else if (event.type === "stream_event" && event.event) {
        const native = event.event;
        const index = native.index ?? -1;

        if (native.type === "message_stop") stopped = true;
        else if (native.type === "content_block_start") {
          const kind = native.content_block?.type;

          if (kind === "text" || kind === "thinking") {
            const contentIndex = partial.content.length;

            partial.content.push(
              kind === "text"
                ? { type: "text", text: "" }
                : { type: "thinking", thinking: "" },
            );
            blocks.set(index, contentIndex);
            stream.push({
              type: kind === "text" ? "text_start" : "thinking_start",
              contentIndex,
              partial,
            });
          }
        } else if (native.type === "content_block_delta") {
          const contentIndex = blocks.get(index);

          const target =
            contentIndex === undefined
              ? undefined
              : partial.content[contentIndex];

          const delta = native.delta;

          if (
            contentIndex !== undefined &&
            target?.type === "text" &&
            delta?.type === "text_delta"
          ) {
            target.text += delta.text ?? "";
            streamed += delta.text ?? "";
            stream.push({
              type: "text_delta",
              contentIndex,
              delta: delta.text ?? "",
              partial,
            });
          } else if (
            contentIndex !== undefined &&
            target?.type === "thinking" &&
            delta?.type === "thinking_delta"
          ) {
            target.thinking += delta.thinking ?? "";
            stream.push({
              type: "thinking_delta",
              contentIndex,
              delta: delta.thinking ?? "",
              partial,
            });
          }
        } else if (native.type === "content_block_stop") {
          const contentIndex = blocks.get(index);

          const target =
            contentIndex === undefined
              ? undefined
              : partial.content[contentIndex];

          if (contentIndex !== undefined && target?.type === "text")
            stream.push({
              type: "text_end",
              contentIndex,
              content: target.text,
              partial,
            });
          else if (contentIndex !== undefined && target?.type === "thinking")
            stream.push({
              type: "thinking_end",
              contentIndex,
              content: target.thinking,
              partial,
            });
        }
      }
    }

    let exitCode: number | null = null;

    if (fast) {
      handedOff = true;
      handOff(cli, admission);
    } else {
      exitCode = await exited(cli);
    }

    if (signal.aborted) throw new Error("Claude request cancelled");
    const captured = admission.capture.message;

    if (!admission.used) {
      if (nativeErrorCode === "authentication_failed") {
        adapter.invalidateStatus();
        throw new Error(
          `Claude Code has no usable login (native: ${nativeError})${stderrTail()}`,
        );
      }

      if (nativeError)
        throw new Error(
          `Claude Code ${NATIVE_ERRORS.get(nativeErrorCode ?? "") ?? "error"}: ${nativeError}`,
        );
      throw new Error(`Claude Code made no model request${stderrTail()}`);
    }

    if (admission.status !== 200 || !admission.capture.complete || !captured) {
      // The CLI's last error is the admission denial; name the first attempt's outcome so reports are diagnosable.
      const upstream = admission.errorText();

      const first = [
        `first upstream attempt: status ${admission.status ?? "none"}`,
        `capture ${admission.capture.complete ? "complete" : "incomplete"}`,
        ...(admission.failure ? [`relay failure ${admission.failure}`] : []),
        `native retries denied: ${admission.denied}`,
        ...(upstream ? [`upstream said: ${upstream.slice(0, 500)}`] : []),
      ].join(", ");

      if (admission.status === 401) adapter.invalidateStatus();
      throw new Error(
        `Incomplete upstream response (${first})${nativeError ? `: ${nativeError}` : ""}`,
      );
    }

    // Stricter than Hermes, which drops only the cut-off call: no tool from a response with a broken call runs.
    if (admission.capture.dropped > 0)
      throw new Error(
        `Incomplete tool call: ${admission.capture.dropped} tool call(s) ended before their arguments were complete (stop reason ${captured.stop_reason ?? "none"})`,
      );

    const refused = captured.stop_reason === "refusal";
    // A refusal or a denied recovery attempt makes the CLI report an error of its own; the first response stands.
    const handled = admission.denied > 0 || refused;

    if (nativeError !== undefined && !handled)
      throw new Error(
        `Claude Code ${NATIVE_ERRORS.get(nativeErrorCode ?? "") ?? "error"}: ${nativeError}`,
      );

    if (results.length !== 1)
      throw new Error("Incomplete native response: one result required");
    const final = results[0];

    const toolCalls = captured.content.filter(
      (item) => item.type === "tool_use",
    );

    const boundary =
      toolCalls.length > 0 &&
      final?.subtype === "error_max_turns" &&
      (fast || exitCode === 1);

    if (
      !boundary &&
      !handled &&
      ((!fast && exitCode !== 0) ||
        final?.is_error ||
        final?.subtype !== "success")
    )
      throw new Error(
        `Native request failed: ${final?.subtype ?? "no result"}${stderrTail()}`,
      );

    const content = captured.content.flatMap(
      (item): AssistantMessage["content"] => {
        if (item.type === "text")
          return [{ type: "text", text: item.text ?? "" }];

        if (item.type === "thinking") {
          const block: ThinkingContent = {
            type: "thinking",
            thinking: item.thinking ?? "",
          };

          if (item.signature) block.thinkingSignature = item.signature;

          return [block];
        }

        if (item.type === "redacted_thinking")
          return [
            {
              type: "thinking",
              thinking: "",
              thinkingSignature: item.data ?? "",
              redacted: true,
            },
          ];

        if (item.type === "tool_use" && !refused) {
          // Built-ins are off, so any other name is the model's; Crumble answers an unknown name with an error.
          const offered = (item.name ?? "").replace(
            new RegExp(`^${PREFIX}`),
            "",
          );

          const input = toolInput.safeParse(item.input ?? {});

          const call: ToolCall = {
            type: "toolCall",
            id: item.id ?? "",
            name: crumble.get(offered) ?? offered,
            arguments: input.success ? input.data : {},
          };

          if (!input.success)
            call.argumentsError = `Tool arguments were not a JSON object: ${JSON.stringify(item.input)}`;

          return [call];
        }

        return [];
      },
    );

    const text = content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("");

    if (!text.startsWith(streamed))
      throw new Error("Native final text differs from incremental stream");
    const calls = content.filter((item) => item.type === "toolCall");

    const message: AssistantMessage = {
      ...partial,
      content,
      usage: piUsage(captured.usage),
      stopReason: "stop",
    };

    if (captured.id) message.responseId = captured.id;

    if (captured.model) message.responseModel = captured.model;

    if (captured.stop_reason) message.rawStopReason = captured.stop_reason;

    for (const call of calls) {
      const contentIndex = message.content.indexOf(call);

      stream.push({ type: "toolcall_start", contentIndex, partial: message });
      stream.push({
        type: "toolcall_end",
        contentIndex,
        toolCall: call,
        partial: message,
      });
    }

    if (refused) {
      // A refusal is terminal: Pi AI's Anthropic adapter reports it as an error with the explanation.
      const details = captured.stop_details;

      stream.push({
        type: "error",
        reason: "error",
        error: {
          ...message,
          stopReason: "error",
          errorMessage:
            details?.explanation?.trim() ||
            (details?.category
              ? `provider refusal category: ${details.category}`
              : "The model refused to complete the request"),
        },
      });

      return;
    }

    const reason: "stop" | "length" | "toolUse" =
      calls.length > 0
        ? "toolUse"
        : captured.stop_reason === "max_tokens" ||
            captured.stop_reason === "model_context_window_exceeded"
          ? "length"
          : "stop";

    stream.push({
      type: "done",
      reason,
      message: { ...message, stopReason: reason },
    });
  } finally {
    signal.removeEventListener("abort", cancel);

    if (!handedOff) {
      if (child) {
        killTree(child);
        await exited(child);
      }

      await admission.close();
    }

    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A clean admitted answer returns at the CLI's result event; its exit code and later output are never read. */
function fastEligible(
  result: StreamJson,
  admission: Admission,
  stopped: boolean,
  nativeError: string | undefined,
) {
  const message = admission.capture.message;

  return (
    admission.used &&
    admission.status === 200 &&
    admission.capture.complete &&
    stopped &&
    nativeError === undefined &&
    admission.denied === 0 &&
    message !== undefined &&
    message.stop_reason !== "refusal" &&
    ((result.subtype === "success" && !result.is_error) ||
      (result.subtype === "error_max_turns" &&
        message.content.some((item) => item.type === "tool_use")))
  );
}

/** Lets a finished CLI exit on its own, killing it after a grace period; the consumed admission stays up until then. */
function handOff(child: ChildProcessWithoutNullStreams, admission: Admission) {
  const timer = setTimeout(() => killTree(child), DRAIN_GRACE_MS);

  void exited(child).then(async () => {
    clearTimeout(timer);
    await admission.close();
  });
}

/** Pi AI's `ProviderStreams` for Claude Code models. */
export function claudeCodeStreams(adapter: AdapterOptions): ProviderStreams {
  return {
    stream: (model, context, options) =>
      streamClaudeCode(adapter, model, context, options),
    streamSimple: (model, context, options) =>
      streamClaudeCode(adapter, model, context, options),
  };
}
