# Group chats, milestone 1: group store and owner API — Implementation Plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** The owner can create, rename, change, and delete group chats and post messages into a shared group transcript over the HTTP API, with live updates. Bots do not answer yet.
**Architecture:** Group metadata and membership live in the product database (`Store`). Each group's transcript is its own Pi Durable store of data entries (`GroupTranscripts`), read with the existing transcript reader. A `GroupChats` module validates requests, notifies listeners, and serves the API. See [ADR 0002](../adr/0002-group-chats.md) and [feature 0001](https://github.com/crumble-project/spec/blob/main/features/0001-group-chats.md).
**Tech stack:** Bun 1.4, `bun:sqlite`, `@earendil-works/pi-durable` 1.3.0, `@earendil-works/pi-ai` 1.3.0, Hono with `@hono/zod-openapi`, Zod 4.

## Global constraints

- Work on branch `feat/0001-group-chats` in `bot`. Commit only when the owner asks for commits; stage explicit paths only.
- A group has two to six bots, each listed once (feature 0001, "Two to six bots").
- Group transcripts never call a model. Use an empty `createModels()` catalog and an empty registry.
- Do not add an event schema file to `src/openapi.ts` `eventSchemas`. The release tooling requires every release to carry the same event schema files (ADR 0002, Consequences). The group snapshot is an HTTP response component instead.
- Every contract change needs a contract version increase: this milestone moves `1.0.0` to `1.1.0`.
- No `any`. Type SQLite rows with `bun:sqlite` query generics. Type assertions need a `// SAFETY:` comment (lint rule `anti-slop/require-safety-comment-for-type-assertion`).
- Done means `bun run check` passes (lint, format check, typecheck, OpenAPI drift check, tests).

## File map

| File | Change | Responsibility |
| --- | --- | --- |
| `src/domain.ts` | Modify | `groupChatInput` schema, `GroupChat` type, member limits |
| `src/store.ts` | Modify | `group_chats` and `group_members` tables; group CRUD |
| `src/transcript.ts` | Modify | `crumble.group-message` entries: schema, kind, normalization |
| `src/group-transcripts.ts` | Create | One Pi store per group: post, history, delete, close |
| `src/group-chats.ts` | Create | Validation, membership checks, listeners, snapshots |
| `src/api-responses.ts` | Modify | `GroupChat`, `GroupChatSnapshot`, `GroupMessageReceipt` schemas |
| `src/api-contract.ts` | Modify | Nine group chat routes; contract version 1.1.0 |
| `src/api.ts` | Modify | Handlers for the group chat routes |
| `src/server.ts` | Modify | Construct and close `GroupChats` |
| `openapi/openapi.json` | Regenerate | Generated contract |
| `test/store.test.ts` | Modify | Store group tests |
| `test/group-transcripts.test.ts` | Create | Transcript store tests against real Pi |
| `test/group-chats.test.ts` | Create | Module tests |
| `test/group-chats-api.test.ts` | Create | HTTP tests |
| `test/server.test.ts` | Modify | Wiring test |
| `docs/architecture.md`, `CHANGELOG.md` | Modify | Documentation and contract changelog |

## Task 1: Store group chats and members

**Files:** modify `src/domain.ts` (append after the `Skill` type, before `conversationReference`), modify `src/store.ts` (imports at lines 12-22, `migrate()` table block at lines 80-89, new methods after `deleteSkill`), test `test/store.test.ts`.

**Interfaces produced:**
- `groupChatInput: z.ZodObject` with `name` and `memberIds`; `type GroupChatInput = { name: string; memberIds: string[] }`
- `type GroupChat = GroupChatInput & { id: string; createdAt: string; updatedAt: string }`
- `MIN_GROUP_MEMBERS = 2`, `MAX_GROUP_MEMBERS = 6`
- `Store.listGroupChats(): GroupChat[]`, `Store.getGroupChat(groupId: string): GroupChat | null`, `Store.createGroupChat(input: GroupChatInput, groupId?: string): GroupChat`, `Store.updateGroupChat(groupId: string, input: GroupChatInput): GroupChat | null`, `Store.deleteGroupChat(groupId: string): boolean`

- [ ] **Step 1: Write the failing test.** Append to `test/store.test.ts`:

```ts
describe("Store group chats", () => {
  test("keeps members in join order, replaces them, and survives reopen", () => {
    const dir = make();
    const first = new Store(dir);
    const a = first.createAgent({ ...input, name: "A" });
    const b = first.createAgent({ ...input, name: "B" });
    const c = first.createAgent({ ...input, name: "C" });

    const group = first.createGroupChat({
      name: "Trip",
      memberIds: [b.id, a.id],
    });

    expect(group).toMatchObject({ name: "Trip", memberIds: [b.id, a.id] });

    const updated = first.updateGroupChat(group.id, {
      name: "Holiday",
      memberIds: [a.id, c.id],
    });

    expect(updated).toMatchObject({
      id: group.id,
      name: "Holiday",
      memberIds: [a.id, c.id],
    });
    expect(first.updateGroupChat(crypto.randomUUID(), group)).toBeNull();
    first.close();

    const second = new Store(dir);
    expect(second.listGroupChats()).toEqual([updated!]);
    second.close();
  });

  test("drops a deleted bot from its groups and deletes members with the group", () => {
    const dir = make();
    const store = new Store(dir);
    const a = store.createAgent({ ...input, name: "A" });
    const b = store.createAgent({ ...input, name: "B" });
    const c = store.createAgent({ ...input, name: "C" });

    const group = store.createGroupChat({
      name: "Trip",
      memberIds: [a.id, b.id, c.id],
    });

    store.deleteAgent(b.id);
    expect(store.getGroupChat(group.id)?.memberIds).toEqual([a.id, c.id]);
    expect(store.deleteGroupChat(group.id)).toBe(true);
    expect(store.getGroupChat(group.id)).toBeNull();
    expect(store.listGroupChats()).toEqual([]);
    store.close();

    const db = new Database(join(dir, "store.sqlite"));

    expect(
      db.query("SELECT COUNT(*) AS n FROM group_members").get(),
    ).toEqual({ n: 0 });
    db.close();
  });
});
```

- [ ] **Step 2: Run it.** `bun test test/store.test.ts`. Expected: both new tests fail with `TypeError: first.createGroupChat is not a function` (and `store.createGroupChat`).

- [ ] **Step 3: Implement.** In `src/domain.ts`, append before `conversationReference`:

```ts
export const MIN_GROUP_MEMBERS = 2;
export const MAX_GROUP_MEMBERS = 6;

export const groupChatInput = z.object({
  name: z.string().trim().min(1).max(80),
  /** Member bots in the order they joined. */
  memberIds: z
    .array(z.string().uuid())
    .min(MIN_GROUP_MEMBERS)
    .max(MAX_GROUP_MEMBERS)
    .refine((ids) => new Set(ids).size === ids.length, "List each bot once"),
});

export type GroupChatInput = z.infer<typeof groupChatInput>;

/** A conversation between the owner and several bots, with one shared transcript. */
export type GroupChat = GroupChatInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
```

In `src/store.ts`, add `GroupChat` and `GroupChatInput` to the type import from `./domain`, and add these row types after `type KeyRow`:

```ts
type GroupChatRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

type GroupMemberRow = { agent_id: string };
```

Append two tables to the `CREATE TABLE IF NOT EXISTS` block in `migrate()`, after the `mcp_servers` line and inside the same template string:

```sql
      CREATE TABLE IF NOT EXISTS group_chats (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, joined_at TEXT NOT NULL, PRIMARY KEY (group_id, agent_id));
```

Add these methods after `deleteSkill`:

```ts
  private groupChat(r: GroupChatRow): GroupChat {
    const members = this.db
      .query<GroupMemberRow, [string]>(
        "SELECT agent_id FROM group_members WHERE group_id=? ORDER BY joined_at, rowid",
      )
      .all(r.id);

    return {
      id: r.id,
      name: r.name,
      memberIds: members.map((member) => member.agent_id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  listGroupChats() {
    return this.db
      .query<GroupChatRow, []>(
        "SELECT * FROM group_chats ORDER BY created_at, rowid",
      )
      .all()
      .map((r) => this.groupChat(r));
  }
  getGroupChat(groupId: Id) {
    const r = this.db
      .query<GroupChatRow, [string]>("SELECT * FROM group_chats WHERE id=?")
      .get(groupId);

    return r ? this.groupChat(r) : null;
  }
  createGroupChat(input: GroupChatInput, groupId: string = id()) {
    const t = now();

    this.db.transaction(() => {
      this.db
        .query(
          "INSERT INTO group_chats (id,name,created_at,updated_at) VALUES (?,?,?,?)",
        )
        .run(groupId, input.name, t, t);
      this.insertGroupMembers(groupId, input.memberIds, t);
    })();

    return this.getGroupChat(groupId)!;
  }
  /** Replaces name and members; members that stay keep their place in the join order. */
  updateGroupChat(groupId: Id, input: GroupChatInput) {
    const current = this.getGroupChat(groupId);

    if (!current) return null;
    const t = now();
    const kept = new Set(input.memberIds);

    this.db.transaction(() => {
      this.db
        .query("UPDATE group_chats SET name=?,updated_at=? WHERE id=?")
        .run(input.name, t, groupId);

      for (const agentId of current.memberIds)
        if (!kept.has(agentId))
          this.db
            .query("DELETE FROM group_members WHERE group_id=? AND agent_id=?")
            .run(groupId, agentId);

      this.insertGroupMembers(
        groupId,
        input.memberIds.filter((agentId) => !current.memberIds.includes(agentId)),
        t,
      );
    })();

    return this.getGroupChat(groupId);
  }
  private insertGroupMembers(groupId: Id, agentIds: Id[], joinedAt: string) {
    const insert = this.db.query(
      "INSERT INTO group_members (group_id,agent_id,joined_at) VALUES (?,?,?)",
    );

    for (const agentId of agentIds) insert.run(groupId, agentId, joinedAt);
  }
  deleteGroupChat(groupId: Id) {
    return (
      this.db.query("DELETE FROM group_chats WHERE id=?").run(groupId)
        .changes > 0
    );
  }
```

- [ ] **Step 4: Run it.** `bun test test/store.test.ts`. Expected: all tests pass. Then `bun run typecheck`, expected no errors.

- [ ] **Step 5: Commit.** `git add src/domain.ts src/store.ts test/store.test.ts && git commit -m "feat(groups): store group chats and their members"`

## Task 2: Group transcript store

**Files:** modify `src/transcript.ts` (schemas near line 40, `normalize()` after the `crumble.bot-message` branch near line 290), create `src/group-transcripts.ts`, test `test/group-transcripts.test.ts`.

**Interfaces consumed:** `readTranscript(harness, prefix, options)` and `TranscriptPage` from `src/transcript.ts`; `AppError` from `src/domain.ts`.

**Interfaces produced:**
- `GROUP_MESSAGE_KIND = "crumble.group-message"`, `groupMessageData` (Zod), `type GroupMessageData = { text: string; sender: MessageOrigin; requestId: string; timestamp: number }`
- `class GroupTranscripts { constructor(dataDir: string); post(groupId: string, message: { text: string; sender: MessageOrigin }, requestId: string): Promise<string>; history(groupId: string, options?: { before?: string; limit?: number }): Promise<TranscriptPage>; delete(groupId: string): Promise<void>; close(): Promise<void> }`. `post` resolves to the entry reference `<groupId>:<entry number>`.
- In a group transcript, owner messages have role `user` and origin `{ kind: "owner" }`; bot messages have role `assistant` and origin `{ kind: "bot", agentId, name }`.

- [ ] **Step 1: Write the failing test.** Create `test/group-transcripts.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupTranscripts } from "../src/group-transcripts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const make = () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-groups-"));
  dirs.push(dir);

  return dir;
};

const groupId = "00000000-0000-4000-8000-000000000001";
const owner = { kind: "owner" };

describe("GroupTranscripts", () => {
  test("pages messages in order with their sender", async () => {
    const transcripts = new GroupTranscripts(make());

    try {
      const first = await transcripts.post(
        groupId,
        { text: "Plan the trip", sender: owner },
        "r-1",
      );

      await transcripts.post(
        groupId,
        {
          text: "Budget first",
          sender: { kind: "bot", agentId: "a-1", name: "Planner" },
        },
        "r-2",
      );

      const page = await transcripts.history(groupId);

      expect(
        page.messages.map((message) => [
          message.role,
          message.content,
          message.origin?.kind,
          message.requestId,
        ]),
      ).toEqual([
        ["user", "Plan the trip", "owner", "r-1"],
        ["assistant", "Budget first", "bot", "r-2"],
      ]);
      expect(page.messages[1]!.origin).toEqual({
        kind: "bot",
        agentId: "a-1",
        name: "Planner",
      });
      expect(first.startsWith(`${groupId}:`)).toBe(true);
      expect(page.messages[0]!.entryId).toBe(first);
      expect(
        (await transcripts.history(groupId, { before: first })).messages,
      ).toEqual([]);
    } finally {
      await transcripts.close();
    }
  });

  test("writes a retried request once and rejects a different message under its ID", async () => {
    const transcripts = new GroupTranscripts(make());

    try {
      const message = { text: "Hello", sender: owner };
      const first = await transcripts.post(groupId, message, "r-1");

      expect(await transcripts.post(groupId, message, "r-1")).toBe(first);
      expect((await transcripts.history(groupId)).messages).toHaveLength(1);
      await expect(
        transcripts.post(groupId, { text: "Other", sender: owner }, "r-1"),
      ).rejects.toThrow("Request ID already used for a different message");
    } finally {
      await transcripts.close();
    }
  });

  test("keeps messages across reopen and deletes the store", async () => {
    const dir = make();
    const first = new GroupTranscripts(dir);

    await first.post(groupId, { text: "Kept", sender: owner }, "r-1");
    await first.close();

    const second = new GroupTranscripts(dir);

    try {
      expect(
        (await second.history(groupId)).messages.map((m) => m.content),
      ).toEqual(["Kept"]);
      await second.delete(groupId);
      expect(existsSync(join(dir, `${groupId}.sqlite`))).toBe(false);
    } finally {
      await second.close();
    }
  });
});
```

- [ ] **Step 2: Run it.** `bun test test/group-transcripts.test.ts`. Expected: fails with `Cannot find module '../src/group-transcripts'`.

- [ ] **Step 3: Implement.** In `src/transcript.ts`, after the `botMessage` schema, add:

```ts
export const GROUP_MESSAGE_KIND = "crumble.group-message";

/** A group chat message: the owner's or a bot's words, written once under its request ID. */
export const groupMessageData = z.object({
  text: z.string(),
  sender: messageOrigin,
  requestId: z.string(),
  timestamp: z.number(),
});

export type GroupMessageData = z.infer<typeof groupMessageData>;
```

In `normalize()`, directly after the `if (entry.kind === "crumble.bot-message") { ... }` block, add:

```ts
  if (entry.kind === GROUP_MESSAGE_KIND) {
    const parsed = groupMessageData.safeParse(entry.data);

    if (!parsed.success) return [];
    const { text, sender, requestId, timestamp } = parsed.data;

    return [
      {
        id: `${entryId}:0`,
        entryId,
        requestId,
        role: sender.kind === "owner" ? "user" : "assistant",
        content: text,
        timestamp,
        kind: entry.kind,
        origin: sender,
      },
    ];
  }
```

Create `src/group-transcripts.ts`:

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "./domain";
import {
  GROUP_MESSAGE_KIND,
  groupMessageData,
  readTranscript,
  type GroupMessageData,
  type MessageOrigin,
  type TranscriptPage,
} from "./transcript";

/** Each group chat's shared transcript: a Pi store of data entries that never calls a model. */
export class GroupTranscripts {
  private readonly harnesses = new Map<string, Promise<Harness>>();
  private closed = false;

  constructor(private readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
  }

  private path(groupId: string) {
    return join(this.dataDir, `${groupId}.sqlite`);
  }

  private async open(groupId: string): Promise<Harness> {
    if (this.closed) throw new Error("Group transcripts are closed");
    const existing = this.harnesses.get(groupId);

    if (existing) return existing;
    const opening = this.openHarness(groupId);
    this.harnesses.set(groupId, opening);

    try {
      return await opening;
    } catch (error) {
      this.harnesses.delete(groupId);
      throw error;
    }
  }

  private async openHarness(groupId: string): Promise<Harness> {
    const storage = await openNodeSqliteStorage(this.path(groupId));

    try {
      return await Harness.open(
        storage,
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
    } catch (error) {
      await storage.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  /** Appends one message; a retried request ID returns the entry it already wrote. */
  async post(
    groupId: string,
    message: { text: string; sender: MessageOrigin },
    requestId: string,
  ): Promise<string> {
    const root = await (await this.open(groupId)).root(BACKGROUND_CONTEXT);

    const data: GroupMessageData = {
      text: message.text,
      sender: message.sender,
      requestId,
      timestamp: Date.now(),
    };

    const submission = await root.submit(
      { type: "write", requestId, entry: { kind: GROUP_MESSAGE_KIND, data } },
      BACKGROUND_CONTEXT,
    );

    const settled = await submission.wait(BACKGROUND_CONTEXT);

    if (settled.type !== "write" || settled.status !== "done")
      throw new Error("The group message was not written");

    // Pi returns the earlier submission for a reused request ID without comparing its content.
    const page = await root.entries(
      {
        order: "ascending",
        minEntryId: settled.entry,
        maxEntryId: settled.entry,
      },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    );

    const written = groupMessageData.safeParse(page.items[0]?.data);

    if (
      !written.success ||
      written.data.text !== message.text ||
      written.data.sender.kind !== message.sender.kind ||
      written.data.sender.agentId !== message.sender.agentId
    )
      throw new AppError(
        409,
        "Request ID already used for a different message",
      );

    return `${groupId}:${Number(settled.entry)}`;
  }

  async history(
    groupId: string,
    options: { before?: string; limit?: number } = {},
  ): Promise<TranscriptPage> {
    try {
      return await readTranscript(await this.open(groupId), groupId, options);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        400,
        error instanceof Error ? error.message : "Invalid history cursor",
      );
    }
  }

  async delete(groupId: string) {
    const pending = this.harnesses.get(groupId);
    this.harnesses.delete(groupId);

    if (pending) await (await pending).close(BACKGROUND_CONTEXT);

    for (const suffix of ["", "-wal", "-shm"])
      await rm(`${this.path(groupId)}${suffix}`, { force: true });
  }

  async close() {
    this.closed = true;
    const harnesses = await Promise.allSettled(this.harnesses.values());
    await Promise.all(
      harnesses
        .filter((harness) => harness.status === "fulfilled")
        .map((harness) => harness.value.close(BACKGROUND_CONTEXT)),
    );
    this.harnesses.clear();
  }
}
```

If `bun run lint` reports `anti-slop/no-array-filter-map` on `close()`, replace the `filter(...).map(...)` chain with a `for` loop that pushes each fulfilled harness's `close(BACKGROUND_CONTEXT)` promise into an array, then `await Promise.all(...)` on it. `AgentRuntime.close()` uses the same chain today, so the rule may already allow it.

- [ ] **Step 4: Run it.** `bun test test/group-transcripts.test.ts test/transcript.test.ts test/chat.test.ts`. Expected: all pass. Then `bun run typecheck`.

- [ ] **Step 5: Commit.** `git add src/transcript.ts src/group-transcripts.ts test/group-transcripts.test.ts && git commit -m "feat(groups): keep each group transcript in its own Pi store"`

## Task 3: GroupChats module

**Files:** create `src/group-chats.ts`, test `test/group-chats.test.ts`.

**Interfaces consumed:** `Store` group methods (Task 1), `GroupTranscripts` (Task 2), `GroupChat`, `GroupChatInput`, `AppError` from `src/domain.ts`.

**Interfaces produced:**
- `type GroupChatSnapshot = TranscriptPage & { groupChat: GroupChat; updatedAt: number }`
- `type GroupMessageReceipt = { requestId: string; entryId: string }`
- `class GroupChats { constructor(store: Store, transcripts: GroupTranscripts); list(): GroupChat[]; get(groupId: string): GroupChat; create(input: GroupChatInput): GroupChat; update(groupId: string, input: GroupChatInput): GroupChat; delete(groupId: string): Promise<void>; post(groupId: string, content: string, requestId: string): Promise<GroupMessageReceipt>; history(groupId: string, options: { before?: string; limit?: number }): Promise<TranscriptPage>; snapshot(groupId: string, options: { limit?: number }): Promise<GroupChatSnapshot>; subscribe(groupId: string, callback: () => void): () => void; close(): Promise<void> }`

- [ ] **Step 1: Write the failing test.** Create `test/group-chats.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupChats } from "../src/group-chats";
import { GroupTranscripts } from "../src/group-transcripts";
import { Store } from "../src/store";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const agent = (name: string) => ({
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
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bot-group-chats-"));
  dirs.push(dir);
  const store = new Store(dir);

  const groups = new GroupChats(
    store,
    new GroupTranscripts(join(dir, "groups")),
  );

  const a = store.createAgent(agent("Planner"));
  const b = store.createAgent(agent("Researcher"));

  return {
    store,
    groups,
    a,
    b,
    close: async () => {
      await groups.close();
      store.close();
    },
  };
}

describe("GroupChats", () => {
  test("rejects members that are not bots", async () => {
    const { groups, a, close } = setup();

    try {
      expect(() =>
        groups.create({
          name: "Trip",
          memberIds: [a.id, crypto.randomUUID()],
        }),
      ).toThrow("Choose existing bots as members");
    } finally {
      await close();
    }
  });

  test("posts owner messages, notifies subscribers, and serves snapshots", async () => {
    const { groups, a, b, close } = setup();

    try {
      const group = groups.create({ name: "Trip", memberIds: [a.id, b.id] });
      let calls = 0;
      const unsubscribe = groups.subscribe(group.id, () => calls++);
      const receipt = await groups.post(group.id, "Plan it", "r-1");

      expect(receipt.requestId).toBe("r-1");
      expect(receipt.entryId.startsWith(`${group.id}:`)).toBe(true);
      expect(calls).toBe(1);

      const snapshot = await groups.snapshot(group.id, {});

      expect(snapshot.groupChat).toEqual(group);
      expect(snapshot.hasMore).toBe(false);
      expect(snapshot.messages.map((message) => message.content)).toEqual([
        "Plan it",
      ]);

      unsubscribe();
      await groups.post(group.id, "Again", "r-2");
      expect(calls).toBe(1);
    } finally {
      await close();
    }
  });

  test("renames, notifies, and deletes a group with its transcript", async () => {
    const { groups, a, b, close } = setup();

    try {
      const group = groups.create({ name: "Trip", memberIds: [a.id, b.id] });
      let calls = 0;
      groups.subscribe(group.id, () => calls++);

      expect(
        groups.update(group.id, { name: "Holiday", memberIds: [b.id, a.id] }),
      ).toMatchObject({ name: "Holiday", memberIds: [a.id, b.id] });
      expect(calls).toBe(1);

      await groups.post(group.id, "Hello", "r-1");
      await groups.delete(group.id);
      expect(calls).toBe(3);
      expect(() => groups.get(group.id)).toThrow("Group chat not found");
      await expect(groups.post(group.id, "Late", "r-2")).rejects.toThrow(
        "Group chat not found",
      );
    } finally {
      await close();
    }
  });
});
```

`[b.id, a.id]` as the new member list keeps both members, so they keep their join order `[a.id, b.id]` (Task 1, `updateGroupChat`).

- [ ] **Step 2: Run it.** `bun test test/group-chats.test.ts`. Expected: fails with `Cannot find module '../src/group-chats'`.

- [ ] **Step 3: Implement.** Create `src/group-chats.ts`:

```ts
import { AppError, type GroupChat, type GroupChatInput } from "./domain";
import type { GroupTranscripts } from "./group-transcripts";
import type { Store } from "./store";
import type { TranscriptPage } from "./transcript";

export type GroupChatSnapshot = TranscriptPage & {
  groupChat: GroupChat;
  updatedAt: number;
};

export type GroupMessageReceipt = { requestId: string; entryId: string };

/** Group chats between the owner and several bots: membership, the shared transcript, and change notifications. */
export class GroupChats {
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly store: Store,
    private readonly transcripts: GroupTranscripts,
  ) {}

  list() {
    return this.store.listGroupChats();
  }

  get(groupId: string): GroupChat {
    const group = this.store.getGroupChat(groupId);

    if (!group) throw new AppError(404, "Group chat not found");

    return group;
  }

  create(input: GroupChatInput) {
    this.checkMembers(input.memberIds);

    return this.store.createGroupChat(input);
  }

  update(groupId: string, input: GroupChatInput) {
    this.get(groupId);
    this.checkMembers(input.memberIds);
    const group = this.store.updateGroupChat(groupId, input)!;
    this.changed(groupId);

    return group;
  }

  async delete(groupId: string) {
    this.get(groupId);
    // Remove the transcript first: a failure then leaves a group with an empty transcript, not an orphaned file.
    await this.transcripts.delete(groupId);
    this.store.deleteGroupChat(groupId);
    this.changed(groupId);
  }

  async post(
    groupId: string,
    content: string,
    requestId: string,
  ): Promise<GroupMessageReceipt> {
    this.get(groupId);

    const entryId = await this.transcripts.post(
      groupId,
      { text: content, sender: { kind: "owner" } },
      requestId,
    );

    this.changed(groupId);

    return { requestId, entryId };
  }

  history(groupId: string, options: { before?: string; limit?: number }) {
    this.get(groupId);

    return this.transcripts.history(groupId, options);
  }

  async snapshot(
    groupId: string,
    options: { limit?: number },
  ): Promise<GroupChatSnapshot> {
    const groupChat = this.get(groupId);
    const page = await this.transcripts.history(groupId, options);

    return { ...page, groupChat, updatedAt: Date.now() };
  }

  subscribe(groupId: string, callback: () => void) {
    const listeners = this.listeners.get(groupId) ?? new Set();
    listeners.add(callback);
    this.listeners.set(groupId, listeners);

    return () => {
      listeners.delete(callback);

      if (!listeners.size) this.listeners.delete(groupId);
    };
  }

  close() {
    return this.transcripts.close();
  }

  private checkMembers(memberIds: string[]) {
    for (const agentId of memberIds)
      if (!this.store.getAgent(agentId))
        throw new AppError(400, "Choose existing bots as members");
  }

  private changed(groupId: string) {
    for (const listener of this.listeners.get(groupId) ?? []) listener();
  }
}
```

- [ ] **Step 4: Run it.** `bun test test/group-chats.test.ts`. Expected: all pass. Then `bun run typecheck`.

- [ ] **Step 5: Commit.** `git add src/group-chats.ts test/group-chats.test.ts && git commit -m "feat(groups): validate group chats and notify their listeners"`

## Task 4: HTTP API and contract 1.1.0

**Files:** modify `src/api-responses.ts` (after `chatSnapshotResponse`, near line 171), modify `src/api-contract.ts` (imports line 7, inputs after `messageInput`, routes before `agentMemories`, `info.version` at line 618), modify `src/api.ts` (imports, `createAPI` options at lines 66-71, handlers after `routes.events`), regenerate `openapi/openapi.json`, modify `CHANGELOG.md`, test `test/group-chats-api.test.ts`.

**Interfaces consumed:** `GroupChats`, `GroupChatSnapshot`, `GroupMessageReceipt` (Task 3); `groupChatInput` (Task 1).

**Interfaces produced:** routes `listGroupChats`, `createGroupChat`, `getGroupChat`, `updateGroupChat`, `deleteGroupChat`, `getGroupChatSnapshot`, `getGroupChatHistory`, `sendGroupMessage`, `streamGroupChatEvents`; `createAPI(..., options: { commonSkills?, coding?, groupChats?: GroupChats }, push?)`.

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| GET | `/v1/group-chats` | | 200 `GroupChat[]` |
| POST | `/v1/group-chats` | `{ name, memberIds }` | 201 `GroupChat` |
| GET | `/v1/group-chats/{id}` | | 200 `GroupChat` |
| PATCH | `/v1/group-chats/{id}` | `{ name?, memberIds? }` | 200 `GroupChat` |
| DELETE | `/v1/group-chats/{id}` | | 204 |
| GET | `/v1/group-chats/{id}/chat?limit` | | 200 `GroupChatSnapshot` |
| GET | `/v1/group-chats/{id}/history?before&limit` | | 200 `TranscriptPage` |
| POST | `/v1/group-chats/{id}/messages` | `{ content, requestId }` | 201 `GroupMessageReceipt` |
| GET | `/v1/group-chats/{id}/events?limit` | | SSE: `snapshot` with `GroupChatSnapshot`, `heartbeat` |

- [ ] **Step 1: Write the failing test.** Create `test/group-chats-api.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAPI } from "../src/api";
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
  const service = new CrumbleService(store, new AgentRuntime(join(dir, "agents")));

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
      const group = await created.json();

      expect(group).toMatchObject({ name: "Trip", memberIds: [ids[0], ids[1]] });
      expect(await (await req(app, "/v1/group-chats")).json()).toEqual([group]);

      const renamed = await req(app, `/v1/group-chats/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Holiday" }),
      });

      expect(await renamed.json()).toMatchObject({
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
      const group = await (
        await post(app, "/v1/group-chats", {
          name: "Trip",
          memberIds: [ids[0]!, ids[1]!, ids[2]!],
        })
      ).json();

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
      const receipt = await sent.json();

      expect(receipt.requestId).toBe(requestId);

      const update = new TextDecoder().decode((await reader.read()).value);

      expect(update).toContain("Where should we go?");
      await reader.cancel();

      const history = await (
        await req(app, `/v1/group-chats/${group.id}/history`)
      ).json();

      expect(history.messages).toMatchObject([
        {
          entryId: receipt.entryId,
          role: "user",
          content: "Where should we go?",
          origin: { kind: "owner" },
        },
      ]);

      const snapshot = await (
        await req(app, `/v1/group-chats/${group.id}/chat?limit=10`)
      ).json();

      expect(snapshot.groupChat.id).toBe(group.id);
      expect(snapshot.messages).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run it.** `bun test test/group-chats-api.test.ts`. Expected: both tests fail; `POST /v1/group-chats` returns 404 because no route exists.

- [ ] **Step 3: Implement.**

In `src/api-responses.ts`, after `chatSnapshotResponse`:

```ts
export const groupChatResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    memberIds: strings.openapi({
      description: "Member bots in the order they joined.",
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("GroupChat");

export const groupChatSnapshotResponse = historyResponse
  .extend({ groupChat: groupChatResponse, updatedAt: z.number() })
  .openapi("GroupChatSnapshot");

export const groupMessageReceiptResponse = z
  .object({ requestId: z.string(), entryId: z.string() })
  .openapi("GroupMessageReceipt");
```

In `src/api-contract.ts`, change the domain import to `import { agentInput, groupChatInput, scheduleInput, skillInput } from "./domain";`, and add after `messageInput`:

```ts
export const groupMessageInput = z.object({
  content: z.string().trim().min(1).max(32000),
  requestId: z.string().uuid(),
});
```

Add these routes inside `routes`, before `agentMemories`:

```ts
  listGroupChats: define({
    method: "get",
    path: "/v1/group-chats",
    operationId: "listGroupChats",
    responses: { 200: json(z.array(response.groupChatResponse)) },
  }),
  createGroupChat: define({
    method: "post",
    path: "/v1/group-chats",
    operationId: "createGroupChat",
    request: { body: body(groupChatInput) },
    responses: { 201: json(response.groupChatResponse) },
  }),
  getGroupChat: define({
    method: "get",
    path: "/v1/group-chats/{id}",
    operationId: "getGroupChat",
    request: { params: id },
    responses: { 200: json(response.groupChatResponse) },
  }),
  updateGroupChat: define({
    method: "patch",
    path: "/v1/group-chats/{id}",
    operationId: "updateGroupChat",
    request: { params: id, body: body(patchInput(groupChatInput)) },
    responses: { 200: json(response.groupChatResponse) },
  }),
  deleteGroupChat: define({
    method: "delete",
    path: "/v1/group-chats/{id}",
    operationId: "deleteGroupChat",
    request: { params: id },
    responses: { 204: empty },
  }),
  groupChatSnapshot: define({
    method: "get",
    path: "/v1/group-chats/{id}/chat",
    operationId: "getGroupChatSnapshot",
    request: { params: id, query: snapshotInput },
    responses: { 200: json(response.groupChatSnapshotResponse) },
  }),
  groupChatHistory: define({
    method: "get",
    path: "/v1/group-chats/{id}/history",
    operationId: "getGroupChatHistory",
    request: { params: id, query: historyInput },
    responses: { 200: json(response.historyResponse) },
  }),
  sendGroupMessage: define({
    method: "post",
    path: "/v1/group-chats/{id}/messages",
    operationId: "sendGroupMessage",
    request: { params: id, body: body(groupMessageInput) },
    responses: { 201: json(response.groupMessageReceiptResponse) },
  }),
  groupChatEvents: define({
    method: "get",
    path: "/v1/group-chats/{id}/events",
    operationId: "streamGroupChatEvents",
    "x-sse-events": {
      snapshot: { $ref: "#/components/schemas/GroupChatSnapshot" },
      heartbeat: { $ref: "#/components/schemas/HeartbeatEvent" },
    },
    description:
      "Server-sent events. Each snapshot event carries a GroupChatSnapshot JSON object in data, sent on connection and after every change. Heartbeat events carry {} every 15 seconds. Authenticate with the Authorization header. Reconnect by fetching the current snapshot; there is no Last-Event-ID replay.",
    request: { params: id, query: snapshotInput },
    responses: {
      200: {
        description: "SSE stream, not a JSON array",
        content: { "text/event-stream": { schema: z.string() } },
      },
    },
  }),
```

In `openAPIDocument()`, change `version: "1.0.0"` to `version: "1.1.0"`.

In `src/api.ts`, add `groupMessageInput` to the `./api-contract` import, `groupChatInput` to the `./domain` import, and `import type { GroupChats } from "./group-chats";`. Add `groupChats?: GroupChats;` to the `options` type of `createAPI`, after `coding`:

```ts
    /** Group chats; their routes answer 503 without it. */
    groupChats?: GroupChats;
```

Add these handlers after the `register(routes.events, ...)` block:

```ts
  const groupChats = () => {
    if (!options.groupChats)
      throw new AppError(503, "Group chats are unavailable");

    return options.groupChats;
  };

  register(routes.listGroupChats, (c) => c.json(groupChats().list(), 200));
  register(routes.createGroupChat, async (c) =>
    c.json(groupChats().create(groupChatInput.parse(await c.req.json())), 201),
  );
  register(routes.getGroupChat, (c) =>
    c.json(groupChats().get(c.req.param("id")), 200),
  );
  register(routes.updateGroupChat, async (c) => {
    const current = groupChats().get(c.req.param("id"));

    // Merge before validation, as agent updates do.
    const input = groupChatInput.parse({
      name: current.name,
      memberIds: current.memberIds,
      ...(await c.req.json()),
    });

    return c.json(groupChats().update(current.id, input), 200);
  });
  register(routes.deleteGroupChat, async (c) => {
    await groupChats().delete(c.req.param("id"));

    return c.body(null, 204);
  });
  register(routes.groupChatSnapshot, async (c) =>
    c.json(await groupChats().snapshot(c.req.param("id"), snapshotQuery(c)), 200),
  );
  register(routes.groupChatHistory, async (c) =>
    c.json(
      await groupChats().history(
        c.req.param("id"),
        historyInput.parse(c.req.query()),
      ),
      200,
    ),
  );
  register(routes.sendGroupMessage, async (c) => {
    const input = groupMessageInput.parse(await c.req.json());

    return c.json(
      await groupChats().post(c.req.param("id"), input.content, input.requestId),
      201,
    );
  });
  register(routes.groupChatEvents, async (c) => {
    const query = snapshotQuery(c);
    const groups = groupChats();
    const groupId = groups.get(c.req.param("id")).id;

    return streamSSE(c, async (stream) => {
      let finish!: () => void;

      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });

      stream.onAbort(finish);

      const sendSnapshot = async () => {
        if (!stream.aborted)
          await stream.writeSSE({
            event: "snapshot",
            data: JSON.stringify(await groups.snapshot(groupId, query)),
          });
      };

      // A deleted group fails its next snapshot, which ends the stream.
      const unsubscribe = groups.subscribe(groupId, () => {
        void sendSnapshot().catch(finish);
      });

      const timer = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(finish);
      }, 15000);

      try {
        await sendSnapshot();
        await finished;
      } finally {
        clearInterval(timer);
        unsubscribe();
      }
    });
  });
```

Regenerate the contract: `bun run openapi:generate`.

In `CHANGELOG.md`, add under `## Unreleased`:

```md
- Add group chats: the owner can create, rename, change, and delete group chats of two to six bots, and post messages into a shared transcript that keeps each message's sender. Each group's transcript is its own Pi store. Bots do not answer in group chats yet.
```

and add this section directly above `## Contract 1.0.0`:

```md
## Contract 1.1.0

- Add group chat endpoints under `/v1/group-chats`: list, create, read, update, and delete groups; read a `GroupChatSnapshot` and paged history; post owner messages, which return a `GroupMessageReceipt`; and stream `GroupChatSnapshot` events.
```

- [ ] **Step 4: Run it.** `bun test test/group-chats-api.test.ts test/api.test.ts test/openapi.test.ts`. Expected: all pass. Then `bun run openapi:check` and `bun run typecheck`, expected no drift and no errors.

- [ ] **Step 5: Commit.** `git add src/api-responses.ts src/api-contract.ts src/api.ts openapi/openapi.json CHANGELOG.md test/group-chats-api.test.ts && git commit -m "feat(groups): add the group chat API as contract 1.1.0"`

## Task 5: Server wiring and documentation

**Files:** modify `src/server.ts` (imports, after `schedules = new BotSchedules(...)` near line 202, `createAPI` options near line 212, `close()` near line 238), modify `docs/architecture.md` (new section before `## Verifiable milestones`), test `test/server.test.ts`.

**Interfaces consumed:** `GroupChats`, `GroupTranscripts`, `createAPI` option `groupChats`.

- [ ] **Step 1: Write the failing test.** Append to `test/server.test.ts`:

```ts
test.serial("serves group chats and keeps them across restarts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "crumble-server-groups-"));
  const port = 20000 + Math.floor(Math.random() * 1000);
  const token = "g".repeat(40);
  const headers = { authorization: `Bearer ${token}` };

  try {
    const running = await startServer({ dataDir, port, token });
    const bots = [];

    for (const name of ["Planner", "Researcher"]) {
      const response = await fetch(new URL("/v1/agents", running.server.url), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });

      bots.push(await response.json());
    }

    const created = await fetch(new URL("/v1/group-chats", running.server.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Trip",
        memberIds: bots.map((bot) => bot.id),
      }),
    });

    const group = await created.json();

    await fetch(
      new URL(`/v1/group-chats/${group.id}/messages`, running.server.url),
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          content: "Hello",
          requestId: crypto.randomUUID(),
        }),
      },
    );
    await running.close();

    const reopened = await startServer({ dataDir, port, token });

    const history = await fetch(
      new URL(`/v1/group-chats/${group.id}/history`, reopened.server.url),
      { headers },
    );

    expect((await history.json()).messages).toMatchObject([
      { content: "Hello" },
    ]);
    await reopened.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it.** `bun test test/server.test.ts`. Expected: the new test fails; creating the group returns 503 `Group chats are unavailable`, so `group.id` is undefined.

- [ ] **Step 3: Implement.** In `src/server.ts`, add:

```ts
import { GroupChats } from "./group-chats";
import { GroupTranscripts } from "./group-transcripts";
```

After `schedules = new BotSchedules(store, scheduler);`:

```ts
    const groupChats = new GroupChats(
      store,
      new GroupTranscripts(join(dataDir, "groups")),
    );
```

Pass it to `createAPI` by changing the options object to:

```ts
      {
        commonSkills,
        coding: workspaces !== undefined,
        groupChats,
      },
```

In the returned `close()`, add `await groupChats.close();` directly after `await server.stop(true);`, so group stores close before `service.close()` closes the product database.

In `docs/architecture.md`, add before `## Verifiable milestones`:

```md
## Group chats

`GroupChats` (`group-chats.ts`) owns group chats between the owner and two to six bots: validation, membership, and change notifications for the event stream. Groups and their members are rows in the product database; deleting a bot removes it from its groups. Each group's shared transcript is its own Pi Durable store, `groups/<group id>.sqlite`, managed by `GroupTranscripts`. The store holds only `crumble.group-message` data entries and never calls a model. Each entry records its sender, so the transcript reader shows the owner's messages as `user` and a bot's as `assistant`, with `origin` naming the bot. Writes carry the client's request ID, which Pi deduplicates; a reused ID with different content is rejected. Group snapshots are an HTTP response component, not an exported event schema file, until the contract release tooling accepts added event schemas. Bots do not take turns in group chats yet. See [ADR 0002](adr/0002-group-chats.md) for the design.
```

- [ ] **Step 4: Run it.** `bun test test/server.test.ts`, expected pass. Then the full gate: `bun run format && bun run check`. Expected: lint, format check, typecheck, OpenAPI check, and every test pass.

- [ ] **Step 5: Commit.** `git add src/server.ts docs/architecture.md test/server.test.ts && git commit -m "feat(groups): serve group chats from the server"`

## Later milestones

Each gets its own plan once the previous milestone is merged.

2. **Turns.** A task-owned group conversation per member in its own Pi store; turns as executions with request IDs derived from the execution; mention routing; one turn per bot per group; the eight-turn budget and the paused state; stopping a group; the `pass` tool; no delegation from group turns; replies count as mentions; disabled members are skipped.
3. **Members, memory, and notifications.** A summary for joining members; removed members stop, including queued turns; memory source recorded on every memory; group memories saved only to the bot's own memory; the group lookup tool for bot chats (overlaps with spec#5); notifications for mentions of the owner and the first answer to each owner message.
4. **Contract release.** Teach `src/contract-release.ts` to accept event schemas added since the baseline release (`validateContract`, `verifyBundle`, `projectEvents`, and the changed-file comparison all require today's schema list in the baseline), export a group snapshot event schema, and publish `contract-v1.1.0`. Then apfelkern and desktop follow their own plans.
