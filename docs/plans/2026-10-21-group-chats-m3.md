# Group chats milestone 3: joining, notifications, and attachments

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** A bot that joins a group gets a summary of the earlier conversation, the owner is notified for exactly the group events the specification names, and group messages carry attachments as bot chat messages do.

**Architecture:** Builds on [milestone 2](2026-10-21-group-chats-m2.md). A member added after a group's first message gets a summary on its first turn, written once by its own model and stored with its membership, so a retried turn sends the same input. Group notifications reuse the reply activity event and push delivery, with a new optional `groupId`. Owner attachments are stored in the group transcript entry and passed to every member turn that includes that message.

**Tech stack:** Bun, `bun:sqlite`, Pi Durable 1.3.0, pi-ai `Models.completeSimple`, Hono with `@hono/zod-openapi`, Zod 4.

## Global constraints

- [Feature 0001](https://github.com/crumble-project/spec/blob/main/features/0001-group-chats.md) is the source of behavior. Terms follow `spec/GLOSSARY.md`.
- Merging a contract change into main publishes it, so milestones 3 to 5 release together as contract 1.3.0: they are built locally and merged at once. Run `bun run openapi:generate` and commit `openapi/openapi.json` and the event schemas.
- Changes to `openapi/activity-event.schema.json` must stay compatible: add optional fields only.
- Tests fake only the model provider and push transports, as the existing tests do.

## Milestone split

The milestone 2 plan grouped memory with this work. Memory needs its own design (where a source comes from in a scheduled task, and the group lookup tool overlapping [spec#5](https://github.com/crumble-project/spec/issues/5)), so it moves to milestone 4:

3. **This plan.** Joining summaries, notifications, attachments.
4. **Memory and lookup.** Every memory records its source; group turns save only to the bot's own memory; bot chats can look up their recent group chats.
5. **Group snapshot event schema.** Teach the release tooling to accept added event schemas and export one for group snapshots.

## Behavior decisions

- **Summary.** Only a member added after the group's first message gets one: its cursor is above 0 when its first turn since joining starts, so a member that leaves and rejoins gets one too. It is written outside the group's queue with a 60-second timeout, and the member waits as queued. The summary covers the messages up to its cursor, newest first until 40,000 characters, written by the bot's own model, under 200 words. It is stored on the membership and prefixed to that first turn's input. If the model call fails, the turn starts with a note that the earlier conversation could not be summarized; the summary is not retried.
- **Owner mentions.** Bots mention the owner as `@owner`, case-insensitively, at a word boundary. Mentioning the owner wakes no bot. The group instructions say so.
- **First answer.** Each owner message remembers the bots it woke, until one of them answers it. The first bot text message from one of those bots in a turn that saw the message, not a reaction, notifies and clears it. A retried post does not re-arm it. One notification covers a message that is both the first answer and an owner mention.
- **Event shape.** Group notifications are `reply` activity events with `origin: "group"`, `groupId`, the group's name as `groupName`, the bot as `agentId` and `agentName`, the group entry as `entryId`, and the turn's execution as `executionId`. Push payloads carry `groupId` when present, so clients open the group instead of the bot chat.
- **Attachments.** Only the owner attaches files. They are validated as in bot chats and stored in the transcript entry's data. A turn sends the attachments of its unseen messages, newest messages first, up to the eight-attachment limit. A member whose model cannot read images gets their names in the text instead.

## File map

| File | Responsibility |
| --- | --- |
| `src/store.ts`, `src/domain.ts` | `group_members.summary`, `group_chats.awaiting_answer` |
| `src/runtime.ts` | `summarize(agent, transcript)`, `acceptsImages(agent)` |
| `src/group-mentions.ts` | `mentionsOwner(text)` |
| `src/group-turns.ts` | Group instructions mention `@owner` |
| `src/group-chats.ts` | Summaries on first turn, notifications, attachments in turns |
| `src/group-transcripts.ts`, `src/transcript.ts` | Attachments in group entries; reading them back |
| `src/service.ts` | `announce(event)` for group reply activity |
| `src/push.ts` | `groupId` and `groupName` in push events and payloads |
| `src/api-contract.ts`, `src/api-responses.ts`, `src/api.ts` | Contract 1.3.0: `attachments` on group messages, `GET /v1/group-chats/{id}/attachments/{entryId}/{index}`, `groupId` and `groupName` on `ReplyEvent` |
| `openapi/`, `CHANGELOG.md`, `docs/architecture.md` | Contract and docs |

## Tasks

### Task 1: Summaries for joining members

**Files:** `src/store.ts`, `src/domain.ts`, `src/runtime.ts`, `src/group-chats.ts`, tests in `test/store.test.ts`, `test/group-chats.test.ts`.

```ts
// GroupMember gains
summary: string | null;
// AgentRuntime
summarize(agent: Agent, transcript: string): Promise<string>   // completeSimple with the bot's model and inference options
```

`startTurn` checks `member.cursor > 0 && member.summary === null && member.conversationId === null`. In that case it builds the transcript text from entries `1..cursor`, stores `summarize()`'s result or the failure note, and prefixes `Summary of the conversation before you joined:` to the input.

**Tests:**
- A member added after two messages gets one summary call. Its first turn input starts with the summary, and a later turn has none.
- A founding member gets no summary.
- A failing summary call still starts the turn, with the note.
- The summary survives a reopen.

### Task 2: Owner notifications

**Files:** `src/group-mentions.ts`, `src/group-turns.ts`, `src/store.ts`, `src/service.ts`, `src/group-chats.ts`, `src/push.ts`, tests in `test/group-mentions.test.ts`, `test/group-chats.test.ts`, `test/push.test.ts`.

```ts
export function mentionsOwner(text: string): boolean
// Store
groupActivity(groupId) gains awaitingAnswer: number   // owner entry number, 0 when none
// CrumbleService
announce(event: ReplyActivity): void                  // ReplyActivity gains optional groupId and groupName
```

**Tests:**
- An owner message with two bot answers notifies once, for the first. A reaction before the first answer does not count.
- A bot's `@owner` notifies, even when it is not the first answer.
- Bot-to-bot messages and pauses don't notify.
- `PushManager` enqueues group events, and both transports include `groupId`.

### Task 3: Attachments on group messages

**Files:** `src/transcript.ts`, `src/group-transcripts.ts`, `src/group-chats.ts`, `src/runtime.ts`, tests in `test/group-chats.test.ts`.

```ts
// groupMessageData gains
attachments?: AttachmentInput[]          // normalized to AttachmentInfo; bytes never leave in pages
// GroupChats.post options gain
attachments?: AttachmentInput[]
// GroupTranscripts
attachment(groupId, entryId, index): Promise<{ mimeType: string; data: Buffer }>
// AgentRuntime
acceptsImages(agent: Agent): Promise<boolean>
```

**Tests:**
- An owner image reaches each member's model as an image block, and the snapshot shows `AttachmentInfo` without bytes.
- A text-only model gets the image's name in its input.
- Nine attachments across coalesced messages send the newest eight.
- An invalid attachment is a 400 and writes nothing.

### Task 4: API, contract 1.3.0, and docs

**Files:** `src/api-contract.ts`, `src/api-responses.ts`, `src/api.ts`, `openapi/`, `CHANGELOG.md`, `docs/architecture.md`, `test/group-chats-api.test.ts`.

- `sendGroupMessage` accepts `attachments`, like `sendChat`, within the same body size limit, and allows empty content when there is an attachment.
- `getGroupAttachment`: `GET /v1/group-chats/{id}/attachments/{entryId}/{index}` returns the bytes with their content type.
- `ReplyEvent` gains optional `groupId` and `groupName`; the regenerated `activity-event.schema.json` stays compatible.
- CHANGELOG: `## Contract 1.3.0` section and an Unreleased entry.

**Tests:**
- Posting with an image returns 201, and the attachment endpoint returns its bytes.
- An unknown index is a 404.
- The activity SSE stream carries a group reply event that validates against `ActivityEvent`.

## Verification

`bun run check` passes, and CI's contract compatibility check passes against `contract-v1.2.0`. A manual run with real models is optional and reported as run or not run.
