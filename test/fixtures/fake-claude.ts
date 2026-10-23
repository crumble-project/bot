#!/usr/bin/env bun
// A stand-in for Claude Code's stream-json mode: acknowledges replayed frames, sends one Messages request through
// ANTHROPIC_BASE_URL, echoes the reply as stream-json, and ends a tool call with `error_max_turns` like the real CLI.
// No credentials or network beyond the loopback relay.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";

// Claude Code gets an allowlisted environment, so test settings travel in a file in its config directory.
const settingsFile = `${process.env["CLAUDE_CONFIG_DIR"] ?? ""}/fake.json`;

const env = {
  ...process.env,
  ...z
    .record(z.string(), z.string())
    .parse(
      existsSync(settingsFile)
        ? JSON.parse(readFileSync(settingsFile, "utf8"))
        : {},
    ),
};

const args = process.argv.slice(2);

if (env["FAKE_PIDS"]) appendFileSync(env["FAKE_PIDS"], `${process.pid}\n`);

if (env["FAKE_ARGV"]) writeFileSync(env["FAKE_ARGV"], JSON.stringify(args));

if (env["FAKE_ENV"]) writeFileSync(env["FAKE_ENV"], JSON.stringify(env));

if (args[0] === "--version") {
  console.log(`${env["FAKE_VERSION"] ?? "2.1.309"} (Claude Code)`);
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  console.log(
    JSON.stringify({
      loggedIn: env["FAKE_LOGGED_IN"] !== "0",
      subscriptionType: "max",
    }),
  );
  process.exit(env["FAKE_LOGGED_IN"] === "0" ? 1 : 0);
}

type Json = z.infer<ReturnType<typeof z.json>>;

const emit = (value: Json) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);

if (env["FAKE_MODE"] === "hang") {
  // A grandchild in the same process group, to prove cancellation kills the whole tree.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });

  if (env["FAKE_PIDS"] && child.pid)
    appendFileSync(env["FAKE_PIDS"], `${child.pid}\n`);
  setInterval(() => {}, 1000);
} else {
  const frame = z.looseObject({
    type: z.string(),
    shouldQuery: z.boolean().optional(),
    message: z.looseObject({ role: z.string(), content: z.json() }),
  });

  const messages: {
    role: string;
    content: z.infer<ReturnType<typeof z.json>>;
  }[] = [];

  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const row = frame.parse(JSON.parse(line));

    messages.push({ role: row.message.role, content: row.message.content });

    if (row.shouldQuery === false)
      emit({ type: "result", num_turns: 0, is_error: false });
  }

  const settingsPath = args[args.indexOf("--settings") + 1] ?? "";

  const extra = z
    .object({ env: z.object({ CLAUDE_CODE_EXTRA_BODY: z.string() }) })
    .parse(JSON.parse(readFileSync(settingsPath, "utf8")));

  const body = {
    ...JSON.parse(extra.env.CLAUDE_CODE_EXTRA_BODY),
    model: args[args.indexOf("--model") + 1],
    system: readFileSync(
      args[args.indexOf("--system-prompt-file") + 1] ?? "",
      "utf8",
    ),
    messages,
    stream: true,
  };

  const url = `${env["ANTHROPIC_BASE_URL"]}/v1/messages`;

  const request = () =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fake-subscription-token",
      },
      body: JSON.stringify(body),
    });

  const response = await request();

  if (response.status !== 200) {
    const text = await response.text();

    emit({
      type: "assistant",
      error: "server_error",
      message: {
        content: [
          { type: "text", text: `API Error: ${response.status} ${text}` },
        ],
      },
    });
    emit({ type: "result", subtype: "success", is_error: true, num_turns: 1 });
    process.exit(1);
  }

  const event = z.looseObject({
    type: z.string(),
    delta: z.looseObject({ stop_reason: z.string().nullish() }).optional(),
  });

  let stopReason: string | null | undefined;
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();

  for (;;) {
    const chunk = await reader?.read();

    if (!chunk || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let end = buffer.indexOf("\n\n");

    while (end >= 0) {
      const data = buffer
        .slice(0, end)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");

      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");

      if (!data) continue;
      const raw = z.json().parse(JSON.parse(data));
      const parsed = event.parse(raw);

      if (parsed.type === "message_delta")
        stopReason = parsed.delta?.stop_reason;
      emit({ type: "stream_event", event: raw });
    }
  }

  emit({ type: "assistant", message: { role: "assistant", content: [] } });

  if (stopReason === "max_tokens" && env["FAKE_RECOVER"] === "1") {
    // Claude Code asks again after a cut-off reply; the relay must refuse.
    const again = await request();

    emit({
      type: "assistant",
      error: "invalid_request",
      message: {
        content: [{ type: "text", text: `API Error: ${again.status}` }],
      },
    });
    emit({ type: "result", subtype: "success", is_error: true, num_turns: 2 });
    process.exit(1);
  }

  if (stopReason === "tool_use") {
    emit({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 2,
    });
    process.exit(1);
  }

  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  process.exit(0);
}
