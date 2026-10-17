# Continuous chat and reply context research

Checked 2026-10-17 against the installed `@earendil-works/pi-durable@1.3.0` package and the current Pi documentation. This note covers the design change in which each Bot has one continuous visible chat, full history remains browsable after compaction, and replying to an old message gives the model bounded surrounding context.

## Durable transcript APIs

Pi Durable already owns transcript persistence. Do not add a second transcript table in Crumble.

`Harness.open()` reopens the SQLite storage, and `harness.resume()` resumes unfinished durable tasks. `harness.createConversation()` creates a durable conversation; `harness.conversation(id, context)` returns its handle.

The conversation handle exposes these relevant signatures:

```ts
conversation.entries(
  query: Omit<EntryQuery, "conversationId">,
  limit: number,
  cursor: Cursor | undefined,
  context: Context,
): Promise<Page<EntryRecord, Cursor>>

conversation.context(
  context: Context,
  options?: { at?: EntryId },
): Promise<ContextView>

conversation.submit(
  submission: SubmissionDraft,
  context: Context,
): Promise<Submission>
```

`Conversation.entries()` is the full fork-aware history API. Its query supports `order: "ascending" | "descending"` and inclusive `minEntryId` and `maxEntryId` bounds. Continue until `page.next` is absent. A full transcript reader must page in ascending order and retain every `EntryRecord`; `ContextView.entries` is not equivalent because it contains only the active context after the newest head marker.

`Conversation.context()` returns the active model context: `head`, raw active `entries`, per-entry `contributions`, and provider-ready `messages`. After compaction, old entries disappear from this active view by design. They remain available through `Conversation.entries()`.

The lower-level `Tx.scanEntries(query, limit, cursor?)` has the same pagination semantics inside `conversation.commit()`. A task runtime also exposes `runtime.context(conversationId, context, { at? })`, but that method derives active context and is not a full-history reader.

## Compaction and reset records

The installed package exports `CompactionEntry` and `ResetEntry` from `@earendil-works/pi-durable/entries`.

- `CompactionEntry` has kind `pi.compaction`. Its `model` is a user message containing the wrapped summary, and its `head` points at the first kept entry. Compaction tasks append this entry without deleting earlier records.
- `ResetEntry` has kind `pi.reset`, always uses `head: "self"`, and can carry a handoff user message. It starts a new active context while preserving prior entries in the durable history.
- `Conversation.compact(instructions, context)` returns `Promise<TaskId<CompactionResult>>`. It schedules the built-in `pi.compaction` task, which can run while the conversation continues and places the summary at a safe boundary.
- `Conversation.reset(handoff, context)` admits the reset. Passing `undefined` creates a plain reset; a string becomes the handoff user message.

The UI should render compaction summaries and reset boundaries as transcript events. Do not reconstruct or duplicate summaries in product storage. A full-history scan must include these records and preserve their `kind`, `head`, `data`, and `model` fields.

## One continuous Bot chat

Bot Mode can use one canonical durable conversation per agent. Keep the existing server identity boundary: `AgentRuntime` stores one Pi SQLite file per agent, and current public IDs use `agentId:localNumericConversationId`. The canonical chat can be the first conversation created for that agent and stored in the product metadata as its canonical reference. Existing numeric IDs remain valid for compatibility.

The visible transcript should be produced from `Conversation.entries()` rather than from a new Crumble message table:

1. Page all entries in ascending order.
2. Convert each entry's `model` messages and application `data` into a display row.
3. Keep `pi.compaction` and `pi.reset` rows as structural events.
4. Use `entry.id` as the stable row key and `entry.kind` to choose the renderer.
5. Refresh from the durable stream or re-scan after reconnect; do not append a second copy to product storage.

The current `AgentRuntime.snapshot()` calls `viewState()` and iterates `value.entries`, so it reports only the active context. That is correct for the model view but insufficient for a continuous transcript. Add a separate paginated history read for the UI and keep `viewState()` for live model/status state.

## Replying to an old message

Pi Durable supports application-defined input metadata. `SubmissionDraft` accepts:

```ts
await conversation.submit({
  type: "input",
  content: "Please expand this point.",
  entry: {
    kind: "chat.reply",
    data: {
      replyToEntryId: target.id,
      replyToMessageIndex: 0,
    },
  },
  requestId,
}, context)
```

The custom kind must be a non-empty string that does not start with `pi.`. The model still receives `content` as its user message. Pi does not interpret custom kinds; context derivation, compaction, events, and accounting use the `model` message and submission records.

For bounded surrounding context, resolve the target and neighbors before admission with `Conversation.entries()` using `minEntryId` and `maxEntryId` bounds, then select a small window by application policy. A practical default is the target entry plus two preceding and two following displayable model messages, capped by characters or tokens. If the target is a compaction summary, resolve its `head` and show the summary rather than trying to resurrect the compacted active context.

There is an important API boundary: `GenerationHooks.beforeRequest` receives only `{ messages }`, `HookApi`, and `Context`. `HookApi` exposes `taskId`, `conversationId`, models, memos, and document reads, but it does not expose `Conversation.entries()` or the current input entry's `data`. Therefore a hook cannot discover `replyToEntryId` from `chat.reply` metadata by itself.

Use one of these restart-safe approaches:

- Preferred for the current SDK: resolve and bound the quote before `submit()`, then include a clearly delimited `<reply_context>...</reply_context>` block in the submitted `content` while retaining the target IDs in `entry.data`. The UI renderer displays the original text and reply metadata separately, and can hide the delimiter block from the user-facing bubble. The durable model message remains self-contained after restart.
- If the runtime adds a request-preparation layer, it can read the pending custom entry from the durable history, append the bounded quote to the request's `messages`, and leave the persisted user content unchanged. This requires a change around generation preparation; `GenerationHooks.beforeRequest` alone cannot read entry metadata.

Do not keep an in-memory `conversationId → reply target` map as the only source. It fails after restart and can attach context to the wrong request. Keep target IDs and any display metadata in the durable input entry; use the `requestId` for admission idempotency.

## Request-time hooks and extensions

The installed durable package exports `GenerationTask` and `hook()`. `GenerationHooks.beforeRequest` runs before every provider attempt, including recovery:

```ts
hook(GenerationTask, {
  beforeRequest(request, api, context) {
    // Return { messages } to replace this attempt's messages.
    return { messages: request.messages };
  },
})
```

The returned messages apply to that request only; they do not create transcript entries. This is the correct place for a bounded, ephemeral reply quote once request preparation can supply the target metadata. Never write a second transcript copy from the hook.

`PromptSection` is suitable for stable system instructions, not per-message reply context. `HookApi.memo()` is durable task-local state and can carry a resolved quote between retries, but the memo must be derived from durable entry metadata and bounded before writing. `ToolHooks` affect tool calls and are unrelated to transcript reply context.

## Acceptance checks

- Restarting the server preserves one canonical conversation ID per agent.
- A full-history scan returns entries before and after compaction, including `pi.compaction` and `pi.reset` records, with no duplicates across pages.
- The active `Conversation.context()` is allowed to omit compacted entries while the UI history remains complete.
- Replying to an old entry stores a durable `chat.reply` kind and target IDs.
- The next model request receives only the bounded target window, exactly once.
- A retry or process restart reuses the same reply metadata and does not duplicate the quoted context.
- An invalid, deleted, or cross-agent target is rejected before admission.
- The UI renders the original user message and reply relationship without exposing internal delimiter text.

## Sources

- Local package types: `node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts`, `dist/types.d.ts`, `dist/entries.d.ts`, and `dist/harness/harness.js`.
- [Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
- [Pi Durable specification](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md)
- [Pi Durable generation task](https://github.com/earendil-works/pi/blob/main/packages/durable/src/harness/generation.ts)

