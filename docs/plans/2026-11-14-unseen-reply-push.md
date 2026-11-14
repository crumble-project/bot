# Unseen-reply push implementation plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** suppress push notifications for replies already displayed or in a chat active on any client of the owner.

**Architecture:** separate account-owned attention state from push-device registration in each tenant's `push.sqlite`. Persist exact reply-surface associations before publication, and check presence and seen state immediately before delivery. Web reports attention through the shared API; native adoption follows separately.

**Source:** [reviewed specification](../designs/unseen-reply-push.md), [issue #130](https://github.com/crumble-project/bot/issues/130).

## Decisions

- Suppression is account-wide, but presence records are independent per tab or native window. One view cannot clear another.
- Chats use `{ kind: "bot" | "group"; id: string }`; group presence never means a member bot's private chat.
- Refresh active views every 30 seconds; presence expires after 120 seconds. Hidden or unfocused web views do not report attention.
- Seen acknowledgements are explicit, idempotent event-ID batches. Presence alone never marks a reply read.
- The exact rendered text or waiting card determines acknowledgement. Loading placeholders and offscreen rows do not count.
- Replies with `waitingFor` use the same suppression policy; mixed text/request replies acknowledge through the request card.
- New outbox entries wait a fixed three seconds. No setting, client-side delay, or additional retry grace.
- Suppressed destinations settle terminally. Already accepted provider notifications cannot be recalled.
- Preserve the existing pre-enqueue crash-loss window. Association persistence does not introduce notification replay.
- Ship server and web together. Remove the old device-presence API; native push registration remains, but attention reporting requires follow-ups.
- Add at most five automated tests total: four server integration tests and one web DOM test. Do not evade the cap with hidden suites.

## Constraints

- Read the applicable `AGENTS.md` files and `GLOSSARY.md` before implementation.
- Before writing any Effect code, first read `apps/server/node_modules/effect/AGENTS.md` completely, and follow the links when required.
- Reuse installed dependencies and existing fixtures. No new dependency is planned.
- No `any`, inline imports, or compatibility shims for outdated dependencies.
- Implement first; add only the five agreed tests. Demonstrate regression cases fail on the old behavior and pass on the new behavior.
- CI unit-test jobs that run on push or pull requests must finish in at most two minutes.
- Nothing that needs a simulator or emulator runs in CI, in any workflow.
- Full verification: `bun run check`. Update matching docs and run `bun run check` in `apps/docs` when implementation changes documented behavior.
- Never commit, stage, push, switch branches, or create public follow-up issues without explicit permission.

## Out of scope

Native implementation, synchronized unread badges or browser notifications, notification recall, notification preferences, new notification producers, general queue durability repairs, and unrelated refactoring.

## Review focus

Keep these checks inside the five allocated tests; do not add separate tests:

1. Held-action publication before card commit: test 2 must observe no publication before a successful commit or after a failed commit.
2. Text plus an asynchronous request card: test 5 must acknowledge only the resolved, visible request surface, not text or a placeholder.
3. An acknowledgement arriving before outbox enqueue: test 2 must preserve suppression after enqueue and restart.
4. Mixed valid/invalid batches and repeated registration: test 4 must prove atomic rejection and immutable event ownership.
5. Chat deletion during delayed enqueue: test 3 must prove stale queued replies cannot send or regain valid ownership.

## Files

Existing files with established responsibilities:

- `apps/server/src/push/schema.ts`: attention, association, and seen-state tables alongside durable deliveries.
- `apps/server/src/push/push-repository.ts`: persistence and delayed delivery eligibility.
- `apps/server/src/push/push.ts`: pre-send suppression and queue/shutdown checks.
- `apps/server/src/push/push-api.ts`: account-authenticated attention handlers.
- `apps/server/src/contract/push.ts`: replace device presence with shared attention schemas and routes.
- `apps/server/src/contract/api-responses.ts`: transcript reply-surface references.
- `apps/server/src/transcript/transcript.ts`: preserve selected reply/waiting surface identities.
- `apps/server/src/bots/bots-announcements.ts`: ordinary bot publication.
- `apps/server/src/bots/bots-notifications.ts`: job-answer publication and shared event dispatch.
- `apps/server/src/bot-desktop/desktop-intent.ts`, `held-actions.ts`, `held-action-notices.ts`: defer held-action notification until card commit.
- `apps/server/src/group-chats/group-turn-engine.ts`: associate posted group replies with group transcript surfaces.
- `apps/server/src/app/tenant.ts`: account-scoped service composition.
- `apps/server/src/push/push.test.ts`: four new integration tests.
- `apps/server/src/push/push-lifecycle.test.ts`: adapt existing shutdown expectations to due-time semantics.
- `apps/web/features/bot-secrets/secret-request.tsx`: request-card readiness, not placeholder visibility.
- `CHANGELOG.md`: user-visible behavior and native migration limitation.

New files created by this plan:

- `apps/server/src/push/chat-attention.ts`: attention queries and account-validation service; canonical contract types live in `contract/push.ts`.
- `apps/web/lib/chat-attention.ts`: per-view presence lifecycle and batched seen acknowledgements.
- `apps/web/lib/chat-attention.dom.test.tsx`: the single new DOM test.
- `apps/web/features/chat/reply-attention.tsx`: nonvisual boundary for visibility and exact-surface readiness.

Additional files and verified wiring:

- `apps/server/src/app/api.ts:152`: existing `registerPushRoutes` registration and its service environment.
- `apps/server/src/bots/bots.ts`, `bots-context.ts`, and `bots-service.ts`: attention injection and any changed bot-service effect error types.
- `apps/server/src/bots/bots-reads.ts:21`: enrich bot snapshots and history before return, including streamed snapshots. `bots/chat-api.ts:24` delegates to these reads; no parallel enrichment at route level.
- `apps/server/src/group-chats/group-chats.ts`, `group-chat-context.ts`, and `group-chat-service.ts:13`: attention injection, group snapshot/history enrichment, and deletion cleanup.
- `apps/server/src/bot-store/agent-repository.ts:28` and `group-chats/group-chat-repository.ts:72`: existing account-local `get` operations for live-chat validation. Depend on these repositories, not on `Bots` or `GroupChats`, to avoid a service cycle.
- `apps/server/src/bots/bots-lifecycle.ts:63`: bot deletion cleanup after the existing library/deletion operation succeeds. Group cleanup belongs in `group-chat-service.ts`'s `remove` operation after group deletion.
- `apps/server/src/app/job-wiring.ts:25`: job-answer callback execution must permit the new persistence effect; do not retain `Effect.runSync` if it suspends.
- `apps/server/src/jobs/jobs.ts:717`: `announceCheckpoint` selects `model[0]`; preserve its stable event identity and selection.
- `apps/web/features/chat/conversation.tsx:114`, `conversation-target.ts`, and `chat-stream.ts`: selected chat lifecycle and snapshot invalidation.
- `apps/web/features/chat/message-card.tsx:19` and `transcript.tsx`: exact message/card rendering boundary; preserve visual appearance and copy.
- `apps/web/features/bot-desktop/held-action.tsx` and `features/call-requests/call-request-card.tsx`: loaded/settled readiness for their matching cards.
- `apps/web/components/request-card.tsx:32`: reuse `useFreshRequest`'s trusted-state distinction, without treating its `Loading…` or `Unavailable` output as displayed content.
- `apps/web/lib/api.ts:130` and `lib/session.ts:3`: existing typed `send` requests and `onSessionReset` cleanup.
- `apps/server/drizzle/push/`: generated migration and snapshot files; the generator determines filenames. `apps/server/drizzle.push.config.ts:7` sets this output directory.
- `openapi/openapi.json`, `chat-snapshot.schema.json`, and `group-chat-snapshot.schema.json`: generated route and snapshot contracts. Include other artifacts only if regeneration actually changes them.
- `apps/docs/content/self-hosting/configuration.md:110`, `clients/web.md`'s Notifications section, and `contributing/index.md`: user behavior and contributor API/migration instructions.

The paths in this section inherit their server/web directory prefix when abbreviated. No other production files are planned. If wiring requires another file, record it in Deviations before editing.

### Task 1: Persist account-owned attention and expose its API

**Files:** create `apps/server/src/push/chat-attention.ts`; modify `schema.ts`, `push-repository.ts`, `contract/push.ts`, `push-api.ts`, tenant composition, registration, and deletion paths listed in Files; generate a push migration.

**Interfaces:**

Define canonical Zod schemas and their inferred exported types in `contract/push.ts`. Import the types into `chat-attention.ts`; do not define a second runtime contract. The proposed shapes are:

```ts
type ChatReference = { kind: "bot" | "group"; id: string };
type ReplySurface =
  | { kind: "text" }
  | { kind: "tool-card"; toolCallId: string }
  | { kind: "held-action"; actionId: string };
type ReplyReference = { eventId: string; surface: ReplySurface };
type ReplyAssociation = {
  eventId: string;
  chat: ChatReference;
  messageId: string;
  entryId: string;
  surface: ReplySurface;
};
```

Create the account-scoped `ChatAttention` Effect service with:

- `exists(chat: ChatReference): Effect.Effect<boolean>`.
- `view(viewId: string, chat: ChatReference | null): Effect.Effect<void, NotFound>`.
- `seen(chat: ChatReference, eventIds: ReadonlyArray<string>): Effect.Effect<void, NotFound>`.
- `register(association: ReplyAssociation): Effect.Effect<void, NotFound | Conflict>`.
- `references(chat: ChatReference, messageIds: ReadonlyArray<string>): Effect.Effect<ReadonlyMap<string, ReadonlyArray<ReplyReference>>, NotFound>`.
- `isSuppressed(chat: ChatReference, eventId: string): Effect.Effect<boolean, NotFound>`.
- `removeChat(chat: ChatReference): Effect.Effect<void>`.
- `cleanup: Effect.Effect<void>`.

`NotFound` and `Conflict` use the existing errors in `apps/server/src/shared/errors.ts`. Missing chats fail closed for registration/acknowledgement and cause callers to discard obsolete deliveries. References for existing chats with no association are empty.

- [x] Define tables keyed by view ID and event ID. Keep seen state and associations independent of outbox/device rows. Reject a conflicting association; identical registration preserves seen state.
- [x] Use server time for presence and atomic all-or-nothing seen batches. Validate 1-100 distinct event IDs at the contract boundary.
- [x] Introduce `PUT /v1/chat-attention/views/{viewId}` and `POST /v1/chat-attention/seen`; remove the old presence route. Retain internal device-presence methods only until Task 3 removes their remaining delivery callers. Keep push registration/removal unchanged.
- [ ] Revalidate live chat ownership for registration, reports, acknowledgements, delayed enqueue, and final sends. Purge deleted-chat records during deletion and cleanup; stale physical rows must never authorize delivery.
- [x] Implement attention queries directly in `chat-attention.ts` against `PushDatabase`. Its dependencies are `PushDatabase`, `AgentRepository`, and `GroupChatRepository`, never `Bots` or `GroupChats`. Keep `PushRepository` responsible for devices/outbox/deliveries, not duplicate attention wrappers.
- [x] Wire one attention instance per tenant. Share one `PushDatabase.layer(dataDir)` value between `ChatAttention.layer` and `PushRepository.layerNoDeps` in `tenant.ts`. Do not reopen `push.sqlite` through a second `Push.layer(dataDir)`.
- [x] Generate the push migration with `bun run --cwd apps/server db:generate:push --name chat_attention`; regenerate contracts with `bun run openapi:generate`. Sources: `apps/server/package.json:12`, root `package.json:30`, and `CONTRIBUTING.md:176`.
- [x] Reserve existing presence-test adaptation and all four new server tests for Task 3, after producer and delivery interfaces exist. This intermediate checkpoint is not releasable: old API assertions intentionally await migration.
- [x] Run `bun run typecheck` and `bun run openapi:check`. Expected: pass. The push regression suite runs after integration in Task 3; do not claim it passes here.

### Task 2: Associate every eligible reply with its exact rendered surface

**Files:** modify producer files, transcript normalization/response contracts, bot/group snapshot and history paths, and held-action readiness paths listed in Files.

**Interfaces:** consumes `ChatAttention.register` and `ChatAttention.references` from Task 1, plus `ReplyReference` from `contract/push.ts`. Produces `replyReferences: ReplyReference[]` on every transcript response message, empty when unassociated. These response references enrich normalized messages; they are not written into the model's transcript or context.

Extend the held-action boundary with these proposed interfaces:

- `GateCall.postCard(...existing arguments): Promise<{ entryId: string; messageId: string }>` returns the committed normalized card identity.
- `HeldActions.cardPosted(action: HeldAction, surface: { entryId: string; messageId: string }): Effect.Effect<void>` notifies readiness listeners after commit; `hold()` only creates the hold.
- `HeldActions.onHeld` passes the action and committed surface to its listener. Update `HeldActionsAccess` to expose the new operation through the existing access wrapper.

Retain the existing public reply-event payload; internal association metadata does not become push preview content.

- [ ] Preserve the selected waiting result's message ID and tool-call ID in `latestReply()`. Retain existing preview and `waitingFor` semantics.
- [ ] Ordinary bot replies register their exact normalized text message, or their selected request card when `waitingFor` is set, before emission.
- [ ] Group replies register the posted group message, never a private member transcript. Enrich bot/group history and snapshots by normalized message ID, not by entry ID alone.
- [ ] Job answers preserve `answer.eventId`. Their surface is model index zero of the formatted answer entry: `formatMessageId(formatEntryId(answer.agentId, Number(answer.entryId)), 0)`. Register before `announceJobAnswer()` emits.
- [ ] Separate held creation from notification readiness. Make `postCard()` expose the committed card identity, register it, then notify. On card-write failure expire the hold and propagate failure without publication.
- [ ] Preserve the existing job-question path. `jobs.ts` posts `JOB_QUESTION_ENTRY`; `app/job-wiring.ts:40` calls `BotMessaging.relayQuestion`, which sends delegated questions as bot inputs (`bot-messaging.ts:514`). This is not a standalone reply-notification producer. Do not invent a question event ID or a new notification category; replies generated by existing producers use their normal mapping.
- [ ] Update `app/job-wiring.ts`'s job-answer callback to run the persistence-capable effect asynchronously with logged failures. Keep its existing listener lifecycle; do not run a suspending association write through `Effect.runSync`.
- [ ] Do not fabricate a surface for an event with no displayable content. Associations must exist before publication, allowing seen acknowledgements before asynchronous enqueue.
- [ ] Update existing response fixtures to include empty references where appropriate, without adding test declarations. Register before emission, then notify existing snapshot listeners so mounted chats can receive the new references.
- [ ] Run `bun run openapi:generate`, `bun run openapi:check`, and `bun run typecheck`. Expected: pass. Task 3 owns the new producer-to-transport regression test and updates the existing presence suite.

### Task 3: Apply account-wide suppression and fixed durable eligibility

**Files:** modify `push-repository.ts`, `push.ts`, attention service integration, `push.test.ts`, and existing `push-lifecycle.test.ts` expectations.

**Interfaces:** consumes `ChatAttention.isSuppressed(chat, eventId)` and cleanup from Task 1. `Push.enqueue` and the transport interface keep their existing public signatures.

- [ ] First insertion sets delivery eligibility to enqueue time plus 3,000 milliseconds. Duplicate enqueue preserves recorded eligibility and terminal delivery state. Keep pre-existing outbox due times.
- [ ] Before every provider send resolve group-or-bot identity, verify the chat still exists, and check seen state plus fresh views across the account. Settle suppressed destinations without marking the event seen.
- [ ] Preserve retry backoff, provider rejection/token rotation semantics, origin filtering, expiry, and serialized drains. Remove the special exclusion for group replies and all remaining installation-bound presence methods/table code. If Task 1's migration left the old table until this caller migration, generate the corresponding final schema migration now.
- [ ] At shutdown persist remaining in-memory replies only for live chats. Drain due deliveries without advancing the clock or bypassing eligibility. Do not replay association records on startup.
- [ ] Implement allocated test 1, `suppresses matching chats across views and destination devices`. Assert zero sends to two devices for matching web/native-style views, correct bot/group isolation, a waiting reply, independent-view clearing, and sends after the last clear or TTL expiry.
- [ ] Implement allocated test 2, `acknowledges exact reply surfaces before enqueue and after restart`. Use a bounded text/tool-card/held-action table through real producers and history responses. Assert card-commit ordering, no notice after failed card commit, idempotent acknowledgements, persisted suppression, and delivery of a different event. Include the job-answer mapping in the text-surface assertions, not in another test.
- [ ] Implement allocated test 3, `respects grace retry and deletion boundaries`. Assert zero sends at 2,999 milliseconds and a send when eligible; seen-during-retry suppresses the retry; restart/shutdown preserve due time; a deleted chat's queued event never sends.
- [ ] Implement allocated test 4, `keeps chat attention ownership atomic and account-scoped`, through authenticated APIs and real SQLite. Assert cross-account `404`, zero partial writes for `[validEventId, foreignEventId]`, unchanged ownership after conflict, and actual delivery to the unaffected account.
- [ ] Adjust existing push tests only where the new delay and removed presence API change their setup or expectations. Do not add a sixth test or erase unrelated coverage.
- [ ] Demonstrate the new regression assertions fail with old per-device suppression/immediate eligibility and pass with the implementation. Use a reversible patch or test harness against the old behavior, never reset user work.
- [ ] Run `bun test apps/server/src/push/push.test.ts apps/server/src/push/push-lifecycle.test.ts` and `bun run check`. Expected: all existing and four new server tests pass; document any other failures.

### Task 4: Report active web views and acknowledge rendered surfaces

**Files:** create `apps/web/lib/chat-attention.ts`, `apps/web/lib/chat-attention.dom.test.tsx`, and `apps/web/features/chat/reply-attention.tsx`; modify verified web lifecycle, transcript, and request-card files listed in Files.

**Interfaces:** consumes Task 1 endpoints and Task 2 transcript `replyReferences`.

Create one controller per tab/account lifetime with these proposed operations:

- `setChat(chat: ChatReference | null): void`.
- `displayed(reference: ReplyReference): void`.
- `dispose(): void`.

Export `createChatAttention(): ChatAttentionController` from `lib/chat-attention.ts`. `ChatAttentionController` has the three operations listed in this Interfaces block. It uses existing typed `send` calls (`lib/api.ts:130`) and `onSessionReset` (`lib/session.ts:3`), and owns its random view ID, serialized report queue, heartbeat, and acknowledgement batching.

Its caller invokes `displayed` only for the exact ready surface within the active viewport. `setChat` fixes the acknowledgement chat; flush or cancel a batch before switching targets, never retarget old event IDs.

Use happy-dom's `Window`, React `act`, and a controllable `IntersectionObserver`, following `features/chat/conversation.dom.test.tsx:72`. The DOM test controls scheduled heartbeat callbacks rather than sleeping 30 seconds. Do not add a timer dependency.

Create `apps/web/features/chat/reply-attention.tsx` as a nonvisual surface boundary. It receives the current controller, matching references, readiness, and observed element. Mount it at exact text/card surfaces, not around every row by default. Extend `MessageCard`'s context only to carry attention references and readiness plumbing; preserve unrelated card APIs.

- [ ] Derive the chat kind and ID from `ConversationTarget.key`'s established `bot:`/`group:` identity, not from URL suffix matching. Report attention only when that chat is displayed, `visibilityState` is `visible`, and the document has focus. Start/stop heartbeats with that condition.
- [ ] Clear only this view on blur, hide, route leave, logout, or account switch. Discard obsolete pending refreshes and never retry an old account's acknowledgements after reset.
- [ ] Batch 1-100 distinct event IDs per chat and retry failures while the account remains active. Do not acknowledge a live event merely because it arrived.
- [ ] Enrich rendering with exact-surface readiness signals. Text must be in the viewport; a request card must finish loading and display its matching pending or confirmed settled content. Collapsed summaries and placeholders do not count.
- [ ] Refresh the relevant snapshot when a live event races ahead of its history references. Reuse existing query invalidation rather than introducing a separate event cache.
- [ ] Implement allocated test 5, `reports only active views and ready visible reply surfaces`, using the existing DOM approach and a recording API. Assert focus/blur/hide/route behavior, heartbeat cancellation, no loading/offscreen/inactive acknowledgement, and the exact ID when the card becomes ready and visible.
- [ ] Run `bun test apps/web/lib/chat-attention.dom.test.tsx` and `bun run check`. Expected: the new DOM test and all existing checks pass.

### Task 5: Document, verify, and hand off native adoption

**Files:** modify `CHANGELOG.md`, matching user/contributor documentation, and generated OpenAPI artifacts from the earlier tasks. No native code or public issue creation.

**Interfaces:** the implemented shared contract is the source for native handoff; no additional API is introduced.

- [ ] Update `apps/docs/content/self-hosting/configuration.md`'s push section and `clients/web.md`'s Notifications section for account-wide bot/group suppression, explicit seen acknowledgements, and the fixed delay. Preserve the distinction from unchanged browser notifications. Update `contributing/index.md` for the shared attention API and native migration. Add the user-visible change and temporary native limitation under `CHANGELOG.md`'s Unreleased section.
- [ ] Record Apple/Android follow-up requirements locally: independent view identity, foreground lifecycle, `replyReferences` readiness, and acknowledgement batching. Do not claim native adoption was tested.
- [ ] Run `bun run check` from the repository and `bun run check` from `apps/docs`. Inspect actual test declarations and confirm exactly four new server tests and one new DOM test.
- [ ] If CI jobs changed, check their measured duration is at most two minutes. If CI was not run, report its duration as unverified.
- [ ] Arrange a fresh-context `vet` review against the spec and this plan's Deviations. Resolve concrete defects without broadening scope or exceeding the test cap.
- [ ] Report applicable checks, failures, skipped verification, native follow-ups, and any remaining `needs decision` entries. No commits or publication without permission.

## Deviations

Task 1: `core-layer.ts` provides the shared push database and attention service so standalone bot and API fixtures use the same tenant wiring, rather than constructing the shared layer in `tenant.ts`. Existing fixture service types and the migration schema expectation are adapted; no new tests are declared. Cleanup runs from the tenant. Delivery-side ownership revalidation remains incomplete and belongs with the Task 3 delivery integration; until then this checkpoint can send stale queued replies and is not releasable.

During implementation, record deviations without rewriting the tasks:

- Task N, step M · planned: … · did: … · why: …
- **needs decision** · Task N · conflicts with: … · chose: … · alternative: … · why: …
