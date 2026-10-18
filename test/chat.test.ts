import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentRuntime } from "../src/runtime";
import { CrumbleService } from "../src/service";
import { Store } from "../src/store";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function open(
  dir: string,
  responses: FauxResponseStep[],
  input: ("text" | "image")[] = ["text", "image"],
) {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "chat", input }],
  });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const store = new Store(dir);
  const service = new CrumbleService(store, new AgentRuntime(dir, { models }));
  return { store, service };
}

function setup(responses: FauxResponseStep[], input?: ("text" | "image")[]) {
  const dir = mkdtempSync(join(tmpdir(), "bot-chat-"));
  dirs.push(dir);
  const opened = open(dir, responses, input);
  const agent = opened.store.createAgent({
    name: "Chat",
    avatar: "bot",
    description: "",
    instructions: "Answer",
    provider: "faux",
    model: "chat",
    enabled: true,
    folder: "Personal",
    tools: [],
    skills: [],
    mcpServers: [],
    delegates: [],
  });
  return { ...opened, dir, agent };
}

async function settle(service: CrumbleService, executionId: string) {
  for (let i = 0; i < 200; i++) {
    const status = service.store.getExecution(executionId)?.status;
    if (status !== "pending" && status !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Execution did not settle");
}

describe("continuous bot chat", () => {
  test("keeps the full transcript visible after compaction", async () => {
    const { service, agent } = setup([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("second answer"),
      fauxAssistantMessage("Summary of earlier work"),
    ]);
    // Pi keeps the newest 20k tokens verbatim, so only a long latest turn leaves older turns to summarize.
    const long = `second question ${"word ".repeat(25000)}`;
    for (const [index, text] of ["first question", long].entries())
      await settle(
        service,
        (await service.sendChat(agent.id, text, uuid(index + 1))).id,
      );
    await service.compact(agent.id);
    let transcript = (await service.chatSnapshot(agent.id)).messages;
    for (let i = 0; i < 200 && transcript.at(-1)?.kind !== "compaction"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      transcript = (await service.chatSnapshot(agent.id)).messages;
    }
    expect(transcript.at(-1)?.kind).toBe("compaction");
    expect(transcript.at(-1)?.content).toContain("Summary of earlier work");
    expect(transcript.map((message) => message.content)).toEqual([
      "first question",
      "first answer",
      long,
      "second answer",
      transcript.at(-1)!.content,
    ]);
    await service.close();
  });

  test("pages older history without splitting or repeating entries", async () => {
    const { service, agent } = setup(
      Array.from({ length: 3 }, (_, i) => fauxAssistantMessage(`answer ${i}`)),
    );
    for (let i = 0; i < 3; i++)
      await settle(
        service,
        (await service.sendChat(agent.id, `question ${i}`, uuid(i + 1))).id,
      );
    const seen: string[] = [];
    let page = await service.history(agent.id, { limit: 2 });
    seen.unshift(...page.messages.map((message) => message.id));
    while (page.hasMore && page.oldestEntryId) {
      page = await service.history(agent.id, {
        before: page.oldestEntryId,
        limit: 2,
      });
      seen.unshift(...page.messages.map((message) => message.id));
    }
    const all = (await service.history(agent.id, { limit: 200 })).messages;
    expect(seen).toEqual(all.map((message) => message.id));
    expect(all.filter((message) => message.role === "user")).toHaveLength(3);
    await service.close();
  });

  test("a reply sends bounded context once and displays the original text", async () => {
    const requests: string[] = [];
    const record: FauxResponseStep = (context) => {
      requests.push(JSON.stringify(context.messages.at(-1)));
      return fauxAssistantMessage("noted");
    };
    const { service, agent } = setup([record, record, record]);
    await settle(
      service,
      (await service.sendChat(agent.id, "x".repeat(20000), uuid(1))).id,
    );
    await settle(
      service,
      (await service.sendChat(agent.id, "unrelated", uuid(2))).id,
    );
    const target = (await service.chatSnapshot(agent.id)).messages.find(
      (message) => message.role === "user" && message.content.startsWith("x"),
    )!;
    const reply = await service.sendChat(
      agent.id,
      "expand on this",
      uuid(3),
      target.entryId,
    );
    await settle(service, reply.id);
    expect(requests[2]).toContain("reply_context");
    expect(requests[2]).toContain("expand on this");
    expect(requests[2]!.length).toBeLessThan(14000);
    const shown = (await service.chatSnapshot(agent.id)).messages.find(
      (message) => message.replyTo === target.entryId,
    )!;
    expect(shown.content).toBe("expand on this");
    expect(shown.replyPreview).toBe("x".repeat(240));
    await expect(
      service.sendChat(agent.id, "bad", uuid(4), "other-agent:1"),
    ).rejects.toThrow("different agent");
    await service.close();
  });

  test("restarts keep one chat and one durable input per request", async () => {
    const { service, agent, dir } = setup([fauxAssistantMessage("once")]);
    const chat = await service.chat(agent.id);
    const first = await service.sendChat(agent.id, "hello", uuid(1));
    await settle(service, first.id);
    await service.close();
    const reopened = open(dir, [fauxAssistantMessage("never")]);
    expect((await reopened.service.chat(agent.id)).id).toBe(chat.id);
    const again = await reopened.service.sendChat(agent.id, "hello", uuid(1));
    expect(again.id).toBe(first.id);
    const users = (
      await reopened.service.chatSnapshot(agent.id)
    ).messages.filter((message) => message.role === "user");
    expect(users.map((message) => message.content)).toEqual(["hello"]);
    await reopened.service.close();
  });
});

// A 1×1 PNG.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const notes = Buffer.from("Buy oat milk").toString("base64");

describe("activity", () => {
  test("announces each finished reply with the start of its text", async () => {
    const { service, agent } = setup([
      fauxAssistantMessage("All done, two meetings tomorrow."),
    ]);
    const events: unknown[] = [];
    service.onActivity((event) => events.push(event));
    await settle(
      service,
      (await service.sendChat(agent.id, "check", uuid(1))).id,
    );
    for (let i = 0; i < 100 && !events.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([
      expect.objectContaining({
        type: "reply",
        agentId: agent.id,
        agentName: "Chat",
        origin: "owner",
        preview: "All done, two meetings tomorrow.",
      }),
    ]);
    await service.close();
  });
});

describe("attachments", () => {
  test("reach the model as content blocks and stay out of snapshots", async () => {
    const seen: unknown[] = [];
    const record: FauxResponseStep = (context) => {
      seen.push(context.messages.at(-1)?.content);
      return fauxAssistantMessage("got them");
    };
    const { service, store, agent } = setup([record]);
    const execution = await service.sendChat(
      agent.id,
      "what is this?",
      uuid(1),
      undefined,
      [
        { name: "dot.png", mimeType: "image/png", data: png },
        { name: "notes.txt", mimeType: "text/plain", data: notes },
      ],
    );
    await settle(service, execution.id);
    expect(seen[0]).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", data: png, mimeType: "image/png" },
      {
        type: "text",
        text: '<attachment name="notes.txt">\nBuy oat milk\n</attachment>',
      },
    ]);
    expect(store.executionAttachments(execution.id)).toEqual([]);
    const shown = (await service.chatSnapshot(agent.id)).messages.find(
      (message) => message.role === "user",
    )!;
    expect(shown.content).toBe("what is this?");
    expect(shown.attachments).toEqual([
      { name: "dot.png", mimeType: "image/png", size: 70, kind: "image" },
      { name: "notes.txt", mimeType: "text/plain", size: 12, kind: "text" },
    ]);
    expect(JSON.stringify(shown.blocks)).not.toContain(png);
    const image = await service.runtime.attachment(agent, shown.entryId, 0);
    expect(image.mimeType).toBe("image/png");
    expect(image.data.toString("base64")).toBe(png);
    await expect(
      service.runtime.attachment(agent, shown.entryId, 1),
    ).rejects.toThrow("Attachment not found");
    await service.close();
  });

  test("an image alone is a message", async () => {
    const { service, agent } = setup([fauxAssistantMessage("a dot")]);
    await settle(
      service,
      (
        await service.sendChat(agent.id, "", uuid(1), undefined, [
          { name: "dot.png", mimeType: "image/png", data: png },
        ])
      ).id,
    );
    const users = (await service.chatSnapshot(agent.id)).messages.filter(
      (message) => message.role === "user",
    );
    expect(users).toHaveLength(1);
    expect(users[0]!.attachments?.[0]?.name).toBe("dot.png");
    await service.close();
  });

  test("models without image input refuse images before answering", async () => {
    const { service, agent } = setup([fauxAssistantMessage("never")], ["text"]);
    await expect(
      service.sendChat(agent.id, "look", uuid(1), undefined, [
        { name: "dot.png", mimeType: "image/png", data: png },
      ]),
    ).rejects.toThrow("can't read images");
    await service.close();
  });

  test("unsupported files are refused without leaving an execution", async () => {
    const { service, store, agent } = setup([]);
    await expect(
      service.sendChat(agent.id, "read", uuid(1), undefined, [
        { name: "doc.pdf", mimeType: "application/pdf", data: notes },
      ]),
    ).rejects.toThrow("only images");
    expect(store.listExecutions(agent.id)).toEqual([]);
    await service.close();
  });

  test("a request ID retried with other files is refused", async () => {
    const { service, agent } = setup([fauxAssistantMessage("ok")]);
    const first = await service.sendChat(agent.id, "see", uuid(1), undefined, [
      { name: "notes.txt", mimeType: "text/plain", data: notes },
    ]);
    await settle(service, first.id);
    await expect(service.sendChat(agent.id, "see", uuid(1))).rejects.toThrow(
      "different message",
    );
    await service.close();
  });

  test("recovery resubmits attachments that were stored before a crash", async () => {
    const seen: unknown[] = [];
    const { service, store, agent, dir } = setup([]);
    const chat = await service.chat(agent.id);
    store.createExecution({
      agentId: agent.id,
      conversationId: chat.id,
      scheduleId: null,
      submissionId: null,
      requestId: uuid(1),
      prompt: "after the crash",
      replyTo: null,
      attachments: [{ name: "notes.txt", mimeType: "text/plain", data: notes }],
      attachmentsDigest: "digest",
      status: "pending",
      error: null,
    });
    await service.close();
    const reopened = open(dir, [
      (context) => {
        seen.push(context.messages.at(-1)?.content);
        return fauxAssistantMessage("recovered");
      },
    ]);
    await reopened.service.recover();
    const execution = reopened.store.listExecutions(agent.id)[0]!;
    await settle(reopened.service, execution.id);
    expect(JSON.stringify(seen[0])).toContain("Buy oat milk");
    await reopened.service.close();
  });
});
