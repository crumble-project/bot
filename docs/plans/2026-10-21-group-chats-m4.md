# Group chats milestone 4: memory sources and group lookup

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** Every memory records where it came from, group turns write only to the bot's own memory, and a bot can look up its group chats from its bot chat.

**Architecture:** Follows the [milestone 3 split](2026-10-21-group-chats-m3.md#milestone-split). The memory tool learns where it runs from Pi: a group conversation is marked with its group, and any other conversation's active run names its input submissions. The server resolves those submissions to the executions behind them: a schedule's task, another bot's request, or the owner's chat. A new `group_chats` tool, offered only in bot chats, reads the groups the bot belongs to through `GroupChats`.

**Tech stack:** Bun, `bun:sqlite`, Pi Durable 1.3.0, Hono with `@hono/zod-openapi`, Zod 4.

## Global constraints

- [Feature 0001](https://github.com/crumble-project/spec/blob/main/features/0001-group-chats.md) is the source of behavior. Terms follow `spec/GLOSSARY.md`.
- Part of contract 1.3.0, which milestones 3 to 5 release together.
- Memories saved before this milestone have no source; the API reports `null`, never a guess.

## Behavior decisions

- **Source shape.** `{ kind: "chat" }` for the owner's bot chat, `{ kind: "task", scheduleId, name }` for a scheduled task, `{ kind: "bot", agentId, name }` for another bot's request, `{ kind: "group", groupId, name }` for a group turn, and `{ kind: "owner" }` for memories the owner writes through the API. A name is the one current when the memory was saved.
- **Resolving a chat run.** A run can answer several queued inputs. The memory takes the source of the newest one, because that is what the bot is answering.
- **Own memory only.** In a group turn, `create` with `shared: true` fails, and so do `update` and `delete` of a shared memory. The error tells the bot to save to its own memory. The memory tool's description and the group instructions say so.
- **Lookup.** The `group_chats` tool has two actions. `list` returns the groups the bot is a member of, with their members and newest message time. `read` takes a group ID and returns its newest messages, up to 30, oldest first, each with its sender, plus a `before` cursor for older ones. It reads only groups the bot is a member of, and it is not offered in group turns. Searching across a bot's own chats remains [spec#5](https://github.com/crumble-project/spec/issues/5).

## Tasks

### Task 1: Store memory sources

**Files:** `src/domain.ts`, `src/store.ts`, `test/store.test.ts`.

`memories.source` holds JSON or NULL; existing rows stay NULL. `Memory` gains `source: MemorySource | null`, and `createMemory` takes an optional source. The insert names its columns.

**Tests:** a memory keeps its source across reopen, and an older database upgrades with `source: null`.

### Task 2: Resolve the source in the memory tool

**Files:** `src/runtime.ts`, `src/server.ts`, `src/store.ts`, `test/runtime-behavior.test.ts` or a new `test/memory-source.test.ts`.

```ts
// RuntimeCallbacks: the memory callbacks gain where the tool runs
type MemoryContext = { groupId: string | null; submissionIds: string[] };
createMemory?(agentId, content, shared, context: MemoryContext)
updateMemory?(agentId, id, content, context: MemoryContext)
deleteMemory?(agentId, id, context: MemoryContext)
// Store
findExecutionBySubmission(agentId, submissionId): Execution | null
```

**Tests:**
- A memory saved from the bot chat has `chat` as its source; from a scheduled task, `task` with the schedule's name; from another bot's request, `bot`; from a group turn, `group`.
- A group turn cannot create, update, or delete a shared memory, and its own memory works.

### Task 3: The group lookup tool

**Files:** `src/group-lookup.ts`, `src/group-turns.ts`, `src/server.ts`, `test/group-lookup.test.ts`.

```ts
export function groupLookupExtension(agent: Pick<Agent, "id">, groups: GroupChats): Extension   // name "group-lookup"
```

**Tests:**
- `list` shows only the bot's groups.
- `read` returns the newest messages oldest first with senders, and pages with `before`.
- A group the bot is not in reads as not found.
- The tool is offered in the bot chat and not in a group turn.

### Task 4: API, contract, and docs

- `Memory` gains `source`, a nullable `MemorySource` union. Owner-created memories through `POST /v1/agents/{id}/memories` and `POST /v1/memories` record `{ kind: "owner" }`.
- The `## Contract 1.3.0` CHANGELOG section and an Unreleased entry; `docs/architecture.md`.

**Tests:** memory responses validate with each source kind, including `null`.

## Verification

`bun run check` passes; CI's compatibility check runs when the work is pushed.
