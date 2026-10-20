import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAPI } from "../src/api";
import {
  groupChatResponse,
  groupChatSnapshotResponse,
  groupMessageReceiptResponse,
  historyResponse,
} from "../src/api-responses";
import { GroupChats } from "../src/group-chats";
import { GroupTranscripts } from "../src/group-transcripts";
import { AgentRuntime } from "../src/runtime";
import { Scheduler } from "../src/scheduler";
import { CrumbleService } from "../src/service";
import { Store } from "../src/store";

const token = "t".repeat(40);
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bot-group-api-"));
  dirs.push(dir);
  const store = new Store(dir);

  const service = new CrumbleService(
    store,
    new AgentRuntime(join(dir, "agents")),
  );

  const scheduler = new Scheduler(store, (a, p, r, s) =>
    service.dispatch(a, p, r, s),
  );

  const groupChats = new GroupChats(
    store,
    new GroupTranscripts(join(dir, "groups")),
  );

  const app = createAPI(service, scheduler, token, undefined, { groupChats });

  const bots = ["Planner", "Researcher", "Critic"].map((name) =>
    store.createAgent({
      name,
      avatar: "bot",
      description: "",
      instructions: "Answer",
      provider: "openai",
      model: "gpt-4.1",
      enabled: true,
      tools: [],
      skills: [],
      mcpServers: [],
      delegates: [],
    }),
  );

  return {
    app,
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
  init: RequestInit = {},
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
  body: Record<string, string | string[]>,
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
});
