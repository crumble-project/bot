# Group chats milestone 2: turns

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** Members answer in group chats: owner and bot messages start turns by the routing rules, bounded by the turn budget and a stop control.

**Architecture:** Follows [ADR 0002](../adr/0002-group-chats.md). Each member gets one task-owned conversation per group in its own Pi store. A turn is an execution in that conversation whose input is every group message the member has not seen. When the execution settles, `GroupChats` posts the member's answer or reaction to the group transcript with the request ID `group-turn:<execution id>`, or posts nothing when the member passed. Routing, the queue, the budget, and the paused state live in the product database.

**Tech stack:** Bun, `bun:sqlite`, Pi Durable 1.3.0, Hono with `@hono/zod-openapi`, Zod 4.

## Global constraints

- [Feature 0001](https://github.com/crumble-project/spec/blob/main/features/0001-group-chats.md) is the source of behavior. Terms follow `spec/GLOSSARY.md`.
- Merging a contract change into main publishes it: `contract-v1.1.0` went out with milestone 1, so this milestone is contract 1.2.0. `bun run check` regenerates nothing: run `bun run openapi:generate` and commit `openapi/openapi.json`.
- No delegation and no coding jobs from a group turn.
- Group turns never send bot chat notifications or chat previews. Group notifications are milestone 3.
- Tests fake only the model provider, as the existing service tests do.

## Behavior decisions

These fill gaps the specification leaves to the implementation.

- **Mentions.** `@Name` matches a current member's name, case-insensitively after NFKC normalization, longest name first, and must end at a word boundary. Bots and the owner use the same syntax. A reply to a bot's message mentions that bot. A message never mentions its own sender.
- **What a turn sees.** Every group message after the member's cursor, oldest first, each labelled with its sender, and the group's name and members. Members present at creation start at the beginning; a member added later starts at the latest entry. Its summary is milestone 3.
- **Queueing.** One turn per member per group. A wake for a busy member sets a pending flag; when the turn settles, one new turn starts with everything unseen. Several wakes therefore coalesce into one turn.
- **Budget.** A bot-started turn is one woken only by bot messages. After eight since the owner's last message, the group pauses: further bot wakes are dropped, and the messages stay unseen, so the next turn includes them. Owner-started turns don't count. The owner's next message resets the count and unpauses.
- **Stop.** Aborts every running turn of the group and clears pending wakes. Aborted turns post nothing. Stop doesn't pause; the next message routes normally.
- **Output.** A final text answer becomes a group message from the bot. A `react` result becomes a reaction to the message the turn answered. The new `pass` tool ends the turn without output. An empty answer posts nothing.
- **Membership guards.** A disabled member is never woken. A member removed while its turn runs gets its turn aborted, and nothing is posted. Milestone 3 adds the rest of the membership rules.

## File map

| File | Responsibility |
| --- | --- |
| `src/domain.ts` | `GROUP_TURN_BUDGET = 8`, `GroupTurn`, `GroupMemberActivity` types |
| `src/store.ts` | `group_turns` table, member cursors and conversation IDs on `group_members`, group activity columns on `group_chats` |
| `src/group-mentions.ts` | Mention parsing against member names |
| `src/group-turns.ts` | Pi side of a member's group conversation: creation, configuration, the `pass` tool, and reading a settled turn's outcome |
| `src/runtime.ts` | Configure a conversation for a group turn: no coordination or coding extensions, group instructions, `pass` tool |
| `src/service.ts` | Execution settlement hook; no previews or reply activity for group turns |
| `src/group-chats.ts` | Routing, queue, budget, stop, posting turn outcomes, restart reconciliation |
| `src/transcript.ts` | Group message `replyTo`, group reactions |
| `src/group-transcripts.ts` | Post reactions; read entries after a cursor |
| `src/api-contract.ts`, `src/api-responses.ts`, `src/api.ts` | Contract 1.2.0: `replyTo` on group messages, `POST /v1/group-chats/{id}/stop`, activity in group snapshots |
| `openapi/openapi.json`, `CHANGELOG.md`, `docs/architecture.md` | Contract and docs |

## Tasks

### Task 1: Store turns, cursors, and group activity

**Files:** `src/domain.ts`, `src/store.ts`, `test/store.test.ts`.

**Interfaces produced:**

```ts
export const GROUP_TURN_BUDGET = 8;
export type GroupTurnStatus = "running" | "posting" | "settled";
export type GroupTurn = {
  executionId: string; groupId: string; agentId: string;
  /** Last group entry number the turn's input included. */
  through: number;
  botStarted: boolean; status: GroupTurnStatus; createdAt: string;
};
// Store
groupMember(groupId, agentId): { conversationId: string | null; cursor: number; pending: boolean; pendingBotStarted: boolean } | undefined
setGroupMember(groupId, agentId, change: Partial<{ conversationId: string; cursor: number; pending: boolean; pendingBotStarted: boolean }>): void
groupActivity(groupId): { botTurns: number; paused: boolean }
setGroupActivity(groupId, change: Partial<{ botTurns: number; paused: boolean }>): void
createGroupTurn(turn: Omit<GroupTurn, "createdAt">): GroupTurn
updateGroupTurn(executionId, change: { status: GroupTurnStatus }): void
activeGroupTurn(groupId, agentId): GroupTurn | undefined   // running or posting
listGroupTurns(filter: { groupId?: string; status?: GroupTurnStatus[] }): GroupTurn[]
```

Columns are added with `ALTER TABLE` behind the existing column checks, so M1 databases upgrade in place. `group_turns.execution_id` references `executions(id) ON DELETE CASCADE`.

**Tests:** an M1-shaped database upgrades and keeps its groups; cursors and pending flags persist across reopen; `activeGroupTurn` ignores settled turns; deleting a group deletes its turns.

### Task 2: Parse mentions

**Files:** `src/group-mentions.ts`, `test/group-mentions.test.ts`.

```ts
export function mentionedMembers(
  text: string,
  members: Array<{ id: string; name: string }>,
  senderId?: string,
): string[]  // member IDs in first-mention order, without duplicates or the sender
```

**Tests:** `@Ada` and `@ada` match; `@Ada Lovelace` prefers that member over `Ada`; `@Adam` does not match `Ada`; an email address mentions nobody; the sender's own name is ignored; punctuation after a name still matches.

### Task 3: Member conversations and turn outcomes in Pi

**Files:** `src/group-turns.ts`, `src/runtime.ts`, `src/server.ts`, `test/group-turns.test.ts`.

**Interfaces produced:**

```ts
export const PASS_TOOL_NAME = "pass";
export function groupTurnExtension(): Extension            // the `pass` tool and the anchor task
// AgentRuntime
openGroupConversation(agent: Agent, groupId: string): Promise<string>     // conversation reference
turnOutcome(agent: Agent, conversationId: string, submissionId: string):
  Promise<{ kind: "message"; text: string } | { kind: "reaction"; emoji: string } | { kind: "pass" }>
```

`openGroupConversation` commits on the bot's root conversation: it creates a background anchor task owned by that conversation and a conversation owned by the anchor, as `coding.ts` does, and marks it with a `crumble.group-turn` document holding the group ID. `configure()` reads that document. For a group conversation it leaves out the `coordination` and `coding` extensions, adds the group extension, and adds a group section to the instructions. That section covers the group's name and members, how to mention them, that the owner reads everything, and when to answer, react, pass, or mention another bot.

**Tests:** the group conversation stays out of `history()` and the bot chat snapshot; its tools include `pass` and `react` but not `delegate`, `ask_bot`, or `coding`; `turnOutcome` reports a text answer, a reaction, a pass, and an empty answer as a pass.

### Task 4: Settlement hook and quiet group executions

**Files:** `src/service.ts`, `test/service.test.ts`.

```ts
// CrumbleService
onSettled(callback: (execution: Execution) => void | Promise<void>): () => void
```

Executions whose request ID starts with `group-turn:` get the origin `{ kind: "group" }` and emit no chat preview and no reply activity. The hook runs after the status update for every settled execution, including executions recovered at startup.

**Tests:** a group execution produces no activity events; `onSettled` fires once for done, failed, and cancelled executions.

### Task 5: Routing, queue, budget, stop, and posting

**Files:** `src/group-chats.ts`, `src/group-transcripts.ts`, `src/transcript.ts`, `src/server.ts`, `test/group-chats.test.ts`.

**Interfaces produced:**

```ts
// GroupChats, constructed with the store, transcripts, service, and runtime
post(groupId, content, requestId, options?: { replyTo?: string }): Promise<GroupMessageReceipt>
stop(groupId): Promise<void>
activity(groupId): { paused: boolean; botTurns: number; members: Array<{ agentId: string; status: "idle" | "queued" | "running" | "disabled" }> }
recover(): Promise<void>
// GroupTranscripts
post(groupId, message: { text: string; sender: MessageOrigin; replyTo?: string }, requestId): Promise<string>
react(groupId, { emoji, sender, replyTo }, requestId): Promise<string>
after(groupId, cursor: number): Promise<Array<{ entry: number; entryId: string; text: string; sender: MessageOrigin; replyTo?: string }>>
```

Flow:

1. **A message is posted.** An owner post resets the budget and unpauses the group. It wakes the mentioned enabled members, or all enabled members when there is no mention. A bot post wakes only the members it mentions, as bot-started wakes.
2. **A member is woken.** A busy member gets the pending flag. A paused group drops bot-started wakes. Otherwise a turn starts: its input is the unseen messages, its request ID is `group-turn:<group id>:<agent id>:<through>`, and it counts against the budget when bot-started. Reaching the budget pauses the group.
3. **A turn settles.** The turn becomes `posting`. Unless the execution was cancelled or the member has left, its outcome goes to the transcript as `group-turn:<execution id>`. The turn becomes `settled`, the member's cursor advances to `through`, and a pending wake starts the next turn.
4. **Recovery.** `recover()` runs after `service.recover()`. It finishes `posting` turns and posts the outcome of settled executions whose turn is still `running`, then starts pending wakes.

A turn's request ID is derived from the cursor, so a retry after a crash reuses the execution instead of starting a second turn. Its post's request ID is derived from the execution, so the answer is written once.

**Tests**, with a faked model that answers per bot:

- An unmentioned owner message starts one turn per member. A mention starts only the mentioned member's turn, and a reply to a bot's message starts that bot's turn.
- A bot message without a mention starts no turn; one with a mention starts the mentioned bot's turn.
- A second mention during a running turn queues exactly one follow-up turn, which sees both messages.
- Two bots that keep mentioning each other pause after eight bot-started turns, and the owner's next message resumes the group.
- Stop aborts running turns, posts nothing for them, and starts no queued turn.
- A disabled member starts no turn and shows as disabled.
- A turn's input contains other members' messages but not their private working context.
- Restart: reopening during a running turn posts its answer once; reopening after the execution settled but before posting posts it once.
- Removing a member during its turn posts nothing.

### Task 6: API and contract

**Files:** `src/api-contract.ts`, `src/api-responses.ts`, `src/api.ts`, `openapi/openapi.json`, `CHANGELOG.md`, `docs/architecture.md`, `test/group-chats-api.test.ts`.

- `sendGroupMessage` accepts optional `replyTo`, an entry ID in the group.
- New `stopGroupChat`: `POST /v1/group-chats/{id}/stop`, answering `204`.
- `GroupChatSnapshot` gains `activity`, the shape of `GroupChats.activity`. Group messages may carry `replyTo` and `replyPreview`. Reactions appear as `toolResult` messages with `toolName: "react"`, `toolDetails: { emoji }`, `replyTo`, and the reacting bot as `origin`.
- The SSE stream sends a snapshot whenever turns start or settle.
- CHANGELOG: add a `## Contract 1.2.0` section and extend the Unreleased entry.

**Tests:** stop answers 204 and 404 for an unknown group; snapshots validate against `GroupChatSnapshot`, including activity and a reaction; a `replyTo` outside the group is a 400.

## Verification

`bun run check` passes. A manual run against a local server with two bots shows routing, a pause after eight bot turns, and stop. It needs a provider key; report whether it ran.

## Later milestones

3. **Members, memory, and notifications.** As planned in milestone 1, plus attachments on group messages, which no milestone covered yet.
4. **Group snapshot event schema.** Merging to main already publishes each contract version, so this milestone only teaches the release tooling to accept added event schemas and exports a group snapshot event schema.
