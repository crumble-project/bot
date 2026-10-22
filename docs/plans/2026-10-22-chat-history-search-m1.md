# Chat history search milestone 1: server tools

**Issue:** [bot#21](https://github.com/crumble-project/bot/issues/21), a sub-issue of [spec#5](https://github.com/crumble-project/spec/issues/5).

**Goal:** Implement accepted [feature 0003](https://github.com/crumble-project/spec/blob/main/features/0003-chat-history-search.md) in bot without client or public API changes.

**Architecture:** A history retrieval module owns text filtering, matching, bounded results, authenticated continuation tokens, and the shared search cutoff. A model-tool extension supplies current calling context and adapters to existing bot and group transcript readers. Existing group lookup remains unchanged.

**Tech stack:** Existing Bun, TypeScript, Pi Durable, and Zod dependencies. No new dependencies or index.

## Constraints

- Follow the accepted specification and canonical glossary in the adjacent spec repository.
- Bot chat scope is the bot's own messages and current groups; group scope is only its shared group messages.
- Recheck access on every request. Never use possession of a cursor as authorization.
- Search message bodies only, excluding generated hints, tool results, compaction events, coordination events, reactions, and private group-turn records.
- Freeze chats and message cutoffs at search start; reads reuse them. No separate read cutoff or coverage-change report.
- Preserve existing transcript and group lookup behavior. Indexing and latency guarantees are deferred.
- No commits, pushes, dependency additions, or CI changes. Use existing checks and temporary verification scripts; add permanent tests only when needed to verify a bug fix.

## File map and ownership

- `src/history-search.ts`: retrieval engine, exported source interfaces, text filtering, cursor validation, and bounded search/read results. Retrieval agent owns this file.
- `src/history-tools.ts`: model tool definitions and context-aware transcript adapters. Integration agent owns this file.
- `src/server.ts`: install the history extension. Integration agent owns this file.
- `docs/architecture.md`, `CHANGELOG.md`, and this plan: parent owns documentation and verification tracking.
- `test/history-tools.test.ts`: parent-owned regression test for committed assistant visibility during active turns.
- Existing transcript/runtime/group modules remain unchanged unless integration establishes a necessary gap and ownership is explicitly reassigned.

## Shared interface

The retrieval engine exports `HistorySearch`, constructed with a `HistorySource`, and these types:

```ts
export type HistoryContext = { agentId: string; groupId: string | null };
export type HistoryChat = { id: string; kind: "bot" | "group"; name: string };
export type HistorySource = {
  chats(context: HistoryContext): Promise<HistoryChat[]>;
  page(context: HistoryContext, chat: HistoryChat, before?: string): Promise<TranscriptPage>;
};
```

`TranscriptPage` is imported from `src/transcript.ts`. `chats` returns only currently authorized chats. `page` enforces membership again for groups and scopes bot history to the caller. The engine exposes:

```ts
search(context: HistoryContext, args: { query?: string; chatId?: string; cursor?: string }): Promise<HistorySearchResult>;
read(context: HistoryContext, args: { match?: string; cursor?: string; direction?: "before" | "after" }): Promise<HistoryReadResult>;
```

The engine defines and exports result types; the extension serializes results as JSON text. Each match includes an opaque `match` token for reading its context. Search continuation uses only `cursor`; read continuation uses `cursor` and, where applicable, direction. Tokens are bound to caller and calling scope. Invalid tokens fail explicitly. Expired tokens after server restart must fail explicitly; new searches work from retained data.

## Tasks

- [x] Retrieval agent implements the engine, filters actual message bodies, and bounds query/results by Unicode code points. Preserve message identities and support long-message continuation and both read directions.
- [x] Integration agent implements `history_search` and `history_read`, derives group context through `GroupConversation`, and installs the extension alongside `group_chats`. Use existing `AgentRuntime.history`, `GroupChats.forMember`, and `GroupChats.readAsMember` adapters. Do not expose private group-turn history.
- [x] Parent reviews integration, updates architecture/changelog, and runs `bun run check`.
- [x] An independent reviewer checks authorization, cursor tampering, cutoff behavior, content filtering, and compatibility against the accepted specification.
- [x] Parent resolves review findings and verifies requirements using existing tests and temporary local scripts with fake model boundaries only.

## Verification

Run `bun run check` from bot. It includes lint, formatting, type checks, OpenAPI consistency, and the existing unit suite. Verify search/read behavior against actual temporary transcript stores without network or paid model calls. No simulator, emulator, or CI workflow changes.

Verification completed:

- `bun run check`: 246 passed, 53 skipped; lint, formatting, types, and OpenAPI checks passed.
- A temporary real-store script verified search/read cutoffs, pagination, Unicode limits, long-message continuation, scope isolation, membership changes, deletion, cursor tampering, restart retention, and model-tool invocation from bot and group turns.
- Independent review found that the UI history projection hides committed assistant messages during active turns. The adapter now requests the committed transcript with `includeActiveAssistant: true`. `test/history-tools.test.ts` reproduced the omission before the fix and passed afterwards.
- Process-local token keys expire old cursors after restart. New searches continue to use retained history. Missing timestamps remain `null` rather than invented.
