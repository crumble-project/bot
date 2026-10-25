import { afterEach, describe, expect, test } from "bun:test";
import type { JsonValue } from "@earendil-works/chord";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAPI } from "../app/api";
import {
  activityEvent,
  groupChatResponse,
  groupChatSnapshotResponse,
  groupMessageReceiptResponse,
  historyResponse,
} from "../contract/api-responses";
import { standaloneGroupChats } from "./group-chats";
import { GroupTranscripts } from "./group-transcripts";
import { AgentRuntime } from "../bots/runtime";
import { standaloneScheduler } from "../schedules/scheduler";
import { standaloneBots } from "../bots/bots";
import { Store } from "../../test/support/store";

// Plain header records, so they spread into the defaults.
type TestRequestInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

const token = "t".repeat(40);
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bot-group-api-"));
  dirs.push(dir);
  const store = new Store(dir);

  const service = standaloneBots(store, new AgentRuntime(join(dir, "agents")));

  const scheduler = standaloneScheduler(store.runtime, (a, p, r, s) =>
    service.dispatch(a, p, r, s),
  );

  const transcripts = new GroupTranscripts(join(dir, "groups"));

  const groupChats = standaloneGroupChats(service, transcripts);

  const app = createAPI(service, scheduler, token, undefined, { groupChats });

  const bots = ["Planner", "Researcher", "Critic"].map((name) =>
    store.createAgent({
      name,
      avatar: "bot",
      description: "",
      instructions: "Answer",
      provider: "openai",
      model: "gpt-4.1",
      // These tests cover the API; turns have their own tests.
      enabled: false,
      tools: [],
      skills: [],
      mcpServers: [],
      delegates: [],
    }),
  );

  return {
    app,
    service,
    transcripts,
    ids: bots.map((bot) => bot.id),
    close: async () => {
      await groupChats.close();
      await service.close();
    },
  };
}

const req = (
  app: ReturnType<typeof createAPI>,
  path: string,
  init: TestRequestInit = {},
) =>
  app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });

const post = (
  app: ReturnType<typeof createAPI>,
  path: string,
  body: Record<string, JsonValue>,
) => req(app, path, { method: "POST", body: JSON.stringify(body) });

describe("group chat API", () => {
  test("creates, lists, renames, and deletes group chats", async () => {
    const { app, ids, close } = setup();

    try {
      const tooSmall = await post(app, "/v1/group-chats", {
        name: "Solo",
        memberIds: [ids[0]!],
      });

      expect(tooSmall.status).toBe(400);

      const created = await post(app, "/v1/group-chats", {
        name: "Trip",
        memberIds: [ids[0]!, ids[1]!],
      });

      expect(created.status).toBe(201);
      const group = groupChatResponse.parse(await created.json());

      expect(group).toMatchObject({
        name: "Trip",
        memberIds: [ids[0], ids[1]],
      });
      expect(
        groupChatResponse
          .array()
          .parse(await (await req(app, "/v1/group-chats")).json()),
      ).toEqual([group]);

      const renamed = await req(app, `/v1/group-chats/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Holiday" }),
      });

      expect(groupChatResponse.parse(await renamed.json())).toMatchObject({
        name: "Holiday",
        memberIds: [ids[0], ids[1]],
      });

      const deleted = await req(app, `/v1/group-chats/${group.id}`, {
        method: "DELETE",
      });

      expect(deleted.status).toBe(204);
      expect((await req(app, `/v1/group-chats/${group.id}`)).status).toBe(404);
    } finally {
      await close();
    }
  });

  test("posts messages and serves history, snapshots, and events", async () => {
    const { app, ids, close } = setup();

    try {
      const group = groupChatResponse.parse(
        await (
          await post(app, "/v1/group-chats", {
            name: "Trip",
            memberIds: [ids[0]!, ids[1]!, ids[2]!],
          })
        ).json(),
      );

      const events: Response = await req(
        app,
        `/v1/group-chats/${group.id}/events`,
      );

      expect(events.headers.get("content-type")).toContain("text/event-stream");
      const reader = events.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);

      expect(first).toContain("event: snapshot");
      expect(first).toContain(`"id":"${group.id}"`);

      const requestId = crypto.randomUUID();

      const sent = await post(app, `/v1/group-chats/${group.id}/messages`, {
        content: "Where should we go?",
        requestId,
      });

      expect(sent.status).toBe(201);
      const receipt = groupMessageReceiptResponse.parse(await sent.json());

      expect(receipt.requestId).toBe(requestId);

      const update = new TextDecoder().decode((await reader.read()).value);

      expect(update).toContain("Where should we go?");
      await reader.cancel();

      const history = historyResponse.parse(
        await (await req(app, `/v1/group-chats/${group.id}/history`)).json(),
      );

      expect(history.messages).toMatchObject([
        {
          entryId: receipt.entryId,
          role: "user",
          content: "Where should we go?",
          origin: { kind: "owner" },
        },
      ]);

      const snapshot = groupChatSnapshotResponse.parse(
        await (
          await req(app, `/v1/group-chats/${group.id}/chat?limit=10`)
        ).json(),
      );

      expect(snapshot.groupChat.id).toBe(group.id);
      expect(snapshot.messages).toHaveLength(1);
    } finally {
      await close();
    }
  });

  test("stops a group, rejects foreign replies, and reports activity and reactions", async () => {
    const { app, ids, transcripts, close } = setup();

    try {
      const group = groupChatResponse.parse(
        await (
          await post(app, "/v1/group-chats", {
            name: "Trip",
            memberIds: [ids[0]!, ids[1]!],
          })
        ).json(),
      );

      const stopped = await req(app, `/v1/group-chats/${group.id}/stop`, {
        method: "POST",
      });

      expect(stopped.status).toBe(204);
      expect(
        (
          await req(app, `/v1/group-chats/${crypto.randomUUID()}/stop`, {
            method: "POST",
          })
        ).status,
      ).toBe(404);

      const foreign = await post(app, `/v1/group-chats/${group.id}/messages`, {
        content: "Me too",
        requestId: crypto.randomUUID(),
        replyTo: `${crypto.randomUUID()}:1`,
      });

      expect(foreign.status).toBe(400);

      const receipt = groupMessageReceiptResponse.parse(
        await (
          await post(app, `/v1/group-chats/${group.id}/messages`, {
            content: "Pack light",
            requestId: crypto.randomUUID(),
          })
        ).json(),
      );

      await transcripts.post(
        group.id,
        {
          text: "",
          sender: { kind: "bot", agentId: ids[0]!, name: "Planner" },
          reaction: "👍",
          replyTo: receipt.entryId,
        },
        "reaction-1",
      );

      const snapshot = groupChatSnapshotResponse.parse(
        await (await req(app, `/v1/group-chats/${group.id}/chat`)).json(),
      );

      expect(snapshot.activity).toEqual({
        paused: false,
        botTurns: 0,
        members: [
          { agentId: ids[0]!, status: "disabled", error: null },
          { agentId: ids[1]!, status: "disabled", error: null },
        ],
      });
      expect(snapshot.messages.at(-1)).toMatchObject({
        role: "toolResult",
        toolName: "react",
        toolDetails: { emoji: "👍" },
        replyTo: receipt.entryId,
        origin: { kind: "bot", agentId: ids[0] },
      });
    } finally {
      await close();
    }
  });

  test("accepts attachments and serves their bytes", async () => {
    const { app, ids, close } = setup();

    // A 1×1 PNG.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

    try {
      const group = groupChatResponse.parse(
        await (
          await post(app, "/v1/group-chats", {
            name: "Trip",
            memberIds: [ids[0]!, ids[1]!],
          })
        ).json(),
      );

      const sent = await post(app, `/v1/group-chats/${group.id}/messages`, {
        content: "",
        requestId: crypto.randomUUID(),
        attachments: [{ name: "map.png", mimeType: "image/png", data: png }],
      });

      expect(sent.status).toBe(201);
      const { entryId } = groupMessageReceiptResponse.parse(await sent.json());

      const file = await req(
        app,
        `/v1/group-chats/${group.id}/attachments/${entryId}/0`,
      );

      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(
        png,
      );
      expect(
        (await req(app, `/v1/group-chats/${group.id}/attachments/${entryId}/1`))
          .status,
      ).toBe(404);

      const empty = await post(app, `/v1/group-chats/${group.id}/messages`, {
        content: " ",
        requestId: crypto.randomUUID(),
      });

      expect(empty.status).toBe(400);
    } finally {
      await close();
    }
  });

  test("streams group answers as reply events", async () => {
    const { app, service, close } = setup();

    try {
      const events = await req(app, "/v1/events");
      const reader = events.body!.getReader();

      service.announce({
        type: "reply",
        executionId: "execution-1",
        agentId: "agent-1",
        agentName: "Planner",
        entryId: "group-1:3",
        origin: "group",
        preview: "Booked.",
        createdAt: new Date().toISOString(),
        groupId: "group-1",
        groupName: "Trip",
      });

      let text = "";

      while (!text.includes("Booked."))
        text += new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();

      const data = text
        .split("\n")
        .find((line) => line.startsWith("data: ") && line.includes("Booked."))
        ?.slice("data: ".length);

      expect(activityEvent.parse(JSON.parse(data!))).toMatchObject({
        type: "reply",
        groupId: "group-1",
        groupName: "Trip",
      });
    } finally {
      await close();
    }
  });
});
