# Push notifications for unseen replies

Status: draft for review.

Issue: [crumble-project/bot#130](https://github.com/crumble-project/bot/issues/130).

## Goal

Send a push only when the owner has not seen the reply and no active client shows its chat.

Presence and seen acknowledgements belong to the authenticated account. Push registration remains a separate concern.

## Scope

This change implements the server contract and web reporting. Apple and Android clients adopt the same contract in follow-up changes.

The server supports bot chats, group chats, and replies with `waitingFor`. Native reporting is not complete until those follow-ups ship.

Out of scope:

- Synchronizing unread badges or browser notifications across clients.
- Recalling notifications already accepted by APNs or FCM.
- Changing which reply origins qualify for notifications.
- Notification preferences or a configurable delay.
- Repairing the existing crash-loss window between reply publication and asynchronous outbox enqueue.

## Current behavior

`apps/server/src/push/push-repository.ts` stores presence against a registered push installation. Presence identifies a bot chat and expires after two minutes.

`apps/server/src/push/push.ts` checks only the destination installation's presence. It excludes group replies and makes new deliveries immediately eligible.

`apps/web/lib/notifications.ts` tracks unread replies in memory. Its `markSeen()` does not persist read state on the server.

`ReplyEvent.eventId` is the activity's `executionId`, not its transcript `entryId`. Held-action notices use the action ID as their event ID. Their `entryId` is null.

History responses do not currently expose the association between displayed replies and notification event IDs. This change must add that association.

## Decisions

### Independent views, account-wide suppression

Each browser tab or native window gets its own random `viewId`. It is independent of push registration and notification permission.

A presence report replaces only that view's state. A report from one view must not overwrite another view's state.

The server suppresses delivery when any fresh view in the authenticated account shows the matching chat.

### Temporary presence and durable seen state

Presence means the chat is currently displayed in an active client. It does not mark individual replies read.

A seen acknowledgement means the client displayed the reply's content or associated waiting card. Receiving an event or fetching history is insufficient.

Seen state is shared by all clients of the account and survives server restarts. Acknowledging one event does not acknowledge adjacent replies.

### Fixed three-second delay

The first delivery becomes eligible three seconds after the reply first enters the durable outbox. There is no server setting.

Store the due time rather than sleeping inside enqueue or delivery. Restarts and duplicate enqueue calls must not reset or bypass the delay.

The worker can send on its first pass after the due time. Three seconds is a minimum, not an exact delivery deadline.

Retries keep their existing backoff. They must recheck presence and seen state without adding another three-second grace delay.

## Shared client contract

The following endpoints and fields are proposed additions, not existing APIs. Schemas belong in `apps/server/src/contract/` and generate the published artifacts in `openapi/`.

All endpoints use ordinary account authentication. Clients never submit an account ID. Bot and group identifiers must resolve within that account.

### Chat identity

```ts
type ChatReference = {
  kind: "bot" | "group";
  id: string;
};
```

For a reply event, `groupId` identifies the group chat when present. Otherwise, `agentId` identifies the bot chat.

Bot and group identifiers occupy separate namespaces. A group's member bot chat is not the group chat.

### Presence

`PUT /v1/chat-attention/views/{viewId}` accepts:

```ts
type ViewPresence = {
  chat: ChatReference | null;
};
```

A successful report returns `204`. An unknown or inaccessible chat returns `404` without changing presence. Invalid input returns `400`.

- Send a report when a chat becomes active or changes.
- Refresh active presence every 30 seconds.
- Send `chat: null` when the view loses attention or leaves the chat.
- The server timestamps reports using its own clock.
- Presence is fresh for at most 120 seconds after the last active report.
- A new process or tab lifetime uses a new `viewId`.
- Clients serialize reports per view and discard obsolete pending refreshes. A delayed refresh must not follow a clear.
- On logout or account switching, clear presence where possible and discard the view identity.

Failure to clear is not fatal. The TTL bounds suppression after a crash, lost connection, or terminated tab.

The new API replaces `/v1/push/devices/{installationId}/presence`. Push-device registration and removal remain unchanged.

### Seen acknowledgements

`POST /v1/chat-attention/seen` accepts:

```ts
type SeenReplies = {
  chat: ChatReference;
  eventIds: string[];
};
```

Accept batches of 1-100 distinct event IDs. Duplicate acknowledgements are idempotent and return `204`.

Every event must belong to the specified chat and authenticated account. Reject an unknown or mismatched event with `404`; write no partial batch.

Clients batch acknowledgements and retry failures while the same account remains signed in. A client must not acknowledge content it has not displayed.

Acknowledgements can arrive before the asynchronous push consumer enqueues the event. They must still prevent delivery.

### Reply identity on reopened chats

Add `replyReferences: ReplyReference[]` to transcript messages returned through bot and group history and snapshot contracts. An empty list means no associated notification reply.

Each reference identifies the exact surface whose display permits acknowledgement:

```ts
type ReplyReference = {
  eventId: string;
  surface:
    | { kind: "text" }
    | { kind: "tool-card"; toolCallId: string }
    | { kind: "held-action"; actionId: string };
};
```

The containing transcript message's `id` identifies the normalized message, not merely its entry. One entry can contain several messages.

The server persists each event's chat ownership and surface association before publishing the event. Several events can associate with one surface.

#### Producer mappings

- **Ordinary bot reply:** `bots-announcements.ts` associates the event with the exact message returned as `latestReply().reply`, including its `id` and `entryId`.
- **Group reply:** `group-turn-engine.ts` associates the event with the exact posted group message, not the member bot's private transcript.
- **Job-report answer:** `bots-notifications.ts` publishes coding and desktop job answers through `announceJobAnswer()`, outside the ordinary announcement path. Preserve `answer.eventId`, produced by `jobReportRequest()` in `jobs.ts`. `announceCheckpoint()` selects `model[0]` from the committed answer entry. Its exact normalized message ID is `formatMessageId(formatEntryId(answer.agentId, Number(answer.entryId)), 0)`. Persist that bot-chat ownership and text-surface association before emission. History enrichment attaches the reference only to that matching normalized message, never another message in the same entry.
- **Credential, login, and call requests:** extend `latestReply()` to retain the selected waiting result's message ID and tool-call identity. It currently reduces that identity to `waitingFor`. Associate with the corresponding request card, not an unrelated text reply.
- **Held desktop action:** `desktop-intent.ts` currently calls `hold()` before `postCard()`, and `hold()` immediately notifies listeners. Separate hold creation from notification readiness. Notify `held-action-notices.ts` only after `postCard()` commits. Persist the surface association using the committed card's message identity and `heldAction.id`, then publish. If card creation fails, expire the hold, propagate the tool failure, and publish no held-action reply.
- **Job questions:** associate any existing eligible reply event with its displayed question message. This change does not introduce a new notification producer.

For an event with both text and `waitingFor`, the waiting card is the acknowledgement surface. Displaying text alone does not acknowledge the request.

A reply without a displayable surface remains unacknowledged. Never substitute an unrelated latest message. Preserve existing event IDs; do not derive IDs from timestamps or previews.

The association must survive outbox cleanup and server restarts. It must not depend on the client having received the live event.

#### Rendering requirements

Acknowledge a text reference after its actual reply content is rendered within the viewport of an active view.

Acknowledge a card reference only after the matching card's content is rendered within that viewport. A mounted row, collapsed tool summary, loading placeholder, or query error is insufficient.

Credential and login cards load request state separately in `features/bot-secrets/secret-request.tsx`. Their renderer must signal readiness after that query resolves. A confirmed settled outcome also counts as displayed; a temporary placeholder does not.

Use the same readiness rule for held-action and call-request cards. Scrolled-off content is not automatically seen.

A live event is not proof that its content has rendered. If history arrived before the event association, refresh the relevant snapshot before acknowledging.

The implementation plan must trace these mappings through their actual response and renderer paths. It must not leave surface identity to an implementation guess.

## Client lifecycle

| Client          | Active view requirement                                                 | Clear presence when                                |
| --------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| Web             | Matching chat is displayed, document is visible, and document has focus | Blur, hidden document, route change, or logout     |
| iOS and Android | Matching chat is displayed in a foreground-active app                   | Backgrounding, leaving the chat, or logout         |
| macOS           | Matching chat is displayed in an active window                          | Window loses activity, leaving the chat, or logout |

Send presence immediately when attention returns. Continue heartbeats only while the active requirements hold.

Web focus handling must be shared by presence and acknowledgement logic. A visible but unfocused tab must do neither.

Presence reporting must not depend on browser notification permission or native push registration.

Native follow-ups must verify their platform lifecycle behavior and their ability to display and acknowledge waiting cards.

## Delivery policy

Before every provider send, including retries:

1. Apply existing expiry, device, and transport checks. Discard deliveries whose chat no longer exists in the account.
2. Resolve the reply's bot or group chat.
3. Check account-wide seen state for the event ID.
4. Check fresh presence across all account views for that chat.
5. If seen or present, settle that destination without contacting the provider.
6. Otherwise, send through the existing transport.

Suppressed deliveries are terminal for that destination. Clearing presence later must not revive a suppressed notification.

Suppression must not write seen state. The UI remains responsible for acknowledging displayed replies.

Apply the same rules when `waitingFor` is set. No approval, credential, login, or job-question exception bypasses suppression.

There is an unavoidable race after the final check and before provider acceptance. Acknowledgements cannot recall an already accepted push.

Shutdown must not bypass the grace delay. Persist replies still in memory for existing chats, leave not-yet-due deliveries queued, and resume them after restart.

The current listener dispatch and in-memory queue can lose an event on abrupt process death before outbox enqueue. This change explicitly retains that limitation. A durable association alone does not guarantee delivery, and startup must not replay associations as new notifications. Once an event reaches the outbox, existing durable recovery applies.

## Persistence and ownership

Keep attention state in the account's `push.sqlite`, already provided by the per-account tenant runtime.

Replace device-linked presence with independent view records containing the view ID, chat kind, chat ID, and server refresh time.

Persist reply associations and seen state independently of outbox and destination rows. Deleting a device must not erase account-wide seen state.

Persist event ownership and associations before publishing events, so validation does not race the asynchronous push queue.

Use an idempotent association write keyed by event ID. Repeated publication must not change chat ownership or erase an acknowledgement.

Expired view records can be removed during cleanup. Account deletion removes all attention state.

Chat deletion invalidates its attention records immediately. Presence and acknowledgement APIs must resolve the live chat before accepting writes, even when an old association exists.

Revalidate chat existence before association registration, delayed enqueue, and each final send check. Discard stale queued replies instead of recreating valid notification state. These checks also apply during shutdown.

Remove deleted-chat records and pending deliveries during deletion and subsequent cleanup passes. Revalidate cleanup against the account's current chats, because a write racing deletion can leave physical rows behind. Such rows must never count as valid ownership or authorize a send. No cross-database foreign key is assumed.

As with seen state, deletion after the final provider-send check cannot recall an in-flight push.

Generate a push database migration through the repository's Drizzle workflow. No migration infers historical seen state from existing presence or web counters.

Replies already in the outbox retain their recorded delivery eligibility. New enqueues use the fixed delay. Old replies without an association remain unseen unless fresh presence suppresses them.

## Rollout

The server and web changes ship together. Older native clients still register devices and receive pushes, but their removed presence endpoint no longer updates attention state.

Do not claim cross-native suppression until Apple and Android adopt the new protocol. Track those changes as follow-up work; creating public issues requires separate permission.

The native follow-ups must consume `replyReferences`, implement independent view presence, and acknowledge the specified rendered surface. No client-side suppression rule replaces the server policy.

Update relevant user and contributor documentation and `CHANGELOG.md` with the implementation. Document the fixed delay and the temporary native-client limitation.

## Verification

Add no more than five automated tests across server and web for this change. Preserve existing coverage; update expectations affected by the new delay and presence contract.

Use real temporary SQLite databases, a recording transport, and Effect's test clock, following `apps/server/src/push/push.test.ts`.

Use four server integration tests and one web DOM test. Reuse the separate server and DOM harnesses; do not build a combined browser/server fixture.

Use small scenario tables where only chat kind or surface kind differs. Do not hide an unbounded generated suite inside the five tests.

1. **Account-wide presence:** report views without push registration and register two destination devices. Matching bot and group presence suppresses both devices, including a `waitingFor` reply. An unrelated chat still sends. Clearing one of two views retains suppression; clearing the last or expiring its TTL permits sends.
2. **Reply surface identity and seen persistence:** create reply references through the real producer paths, including a held action and credential/login request surfaces. Verify no held-action publication precedes card commit, and a failed card write publishes nothing. Fetch references through history, acknowledge before enqueue, and restart the repository. Duplicate acknowledgements preserve suppression; another event still sends. Use a bounded surface table for text, tool card, and held-action identity.
3. **Delivery lifecycle:** advance the test clock across the three-second boundary and record sends. Then acknowledge a reply during a provider retry and verify no further send. Restart and shutdown retain due times. A queued reply for a deleted chat cannot send or regain valid ownership.
4. **Ownership validation:** use two authenticated accounts. Cross-account references fail without affecting the other's delivery. A batch containing one valid and one invalid event writes nothing. Repeated event registration cannot change chat ownership or erase seen state.
5. **Web attention lifecycle:** use the existing DOM harness with a recording API. Exercise focus, blur, hidden state, route changes, and heartbeat cancellation. Render a referenced waiting card through loading and resolved states. Assert no acknowledgement while loading, offscreen, or inactive, then the exact event ID after the matching surface becomes visible and ready.

The server tests prove API and transport behavior. The DOM test proves the client emits that contract. They do not claim a full browser-to-provider integration test.

If these scenarios cannot remain readable within five tests, stop and narrow the proposed automated coverage with the owner. Do not add tests or bury independent suites to evade the cap.

Server assertions must inspect recorded provider sends, not only repository booleans. Client assertions must inspect reports and rendered-content acknowledgements, not merely helper return values.

Demonstrate the relevant regression cases fail before the behavior change and pass afterward. No tests use real provider tokens, paid APIs, or network services.

Run `bun run check` in the repository and `bun run check` in `apps/docs` when its documentation changes. CI unit-test jobs must remain within two minutes.

Run local cross-client smoke checks after native updates: foreground web, blurred web, foreground native client, and group chat. No simulator, emulator, or native UI checks run in CI.

## Acceptance criteria

- A focused web chat suppresses pushes to every device of its owner.
- A native client using the new contract suppresses the owner's other devices.
- Group chats and `waitingFor` replies follow the same suppression policy.
- A reply acknowledged before the final delivery check causes no provider send.
- Reopening a chat exposes stable event IDs associated with the exact text or waiting-card surface.
- Held-action replies publish only after their cards commit; loading placeholders never acknowledge requests.
- A hidden or unfocused web tab neither refreshes active presence nor acknowledges replies.
- Expired presence fails toward sending; independent views do not clear each other.
- New deliveries wait at least three seconds, without a configurable setting.
- Restart, cleanup, and device removal preserve durable seen state.
- Five or fewer new automated tests cover the agreed server and web behavior.
