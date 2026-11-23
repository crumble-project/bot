# Server feature decisions

- Status: Accepted
- Scope: decisions surfaced while removing inline comments from server feature code. This records the behavior present in the implementation; it does not introduce a behavior change.

## OAuth connections to MCP servers

OAuth state and tokens are kept as encrypted server secrets. A connection is bound to the registration identity and redirect URI that obtained its credentials. Generation checks prevent an in-flight registration, callback, or refresh from restoring credentials after sign-out or replacing a newer sign-in. Authorization state is single-use, PKCE is required, and an issuer returned by the authorization server is checked. An expired refresh cannot open an owner-facing browser, so the connection fails and asks the owner to sign in again rather than silently retrying. The GitHub token exchange sends the client secret in the request body, as GitHub documents, rather than using the library's HTTP Basic default. These constraints are exercised in `apps/server/src/integrations/mcp-oauth.test.ts` and implemented in `mcp-oauth.ts`.

## Event delivery is atomic with durable storage

Storing a relay event and handing it to consumers happen in one database transaction. A duplicate event ID is a no-op, so a relay redelivery cannot create a second set of consumer runs. Event records do not depend on the continued existence of their source; deleting a source must not erase the event identity needed for deduplication. The implementation is in `apps/server/src/event-sources/event-repository.ts` and `schema.ts`.

## Transcript origin and trust boundaries

Input origins written by this server are typed, while stored and wire `kind` values remain strings so newer or older clients can encounter unknown values without invalidating the record. Origin is also a trust boundary: text from a callee or script output is not automatically treated as the owner's request. An event's stored text is its prompt, while its payload is separately passed to the model. Keep these distinctions when adding origins or changing transcript framing; see `apps/server/src/transcript/origins.ts` and `learning-review.ts`.

## Skills retain provenance without source ownership

A copied skill must remain usable if its source is deleted. The source reference is therefore not a foreign key that cascades into copies. Replacing or restoring a skill preserves its identity and usage where the repository contract requires it; reverts record their own learned-change event rather than recording a second event for the low-level restore. See `apps/server/src/skills/schema.ts` and `skill-repository.ts`.

## Model-written charts are data, not executable client content

Chart code runs in a QuickJS sandbox without I/O. The server validates the resulting layouts, stores them as JSON, and clients receive compiled layout data rather than model-authored code. Keep the sandbox export surface deliberate and cover authoring imports in `charts.test.ts`; the server-side contract is `chartLayout`. See `apps/server/src/display/chart-runtime.ts`, `charts.ts`, and `display.ts`.

## Durable messages and delivery boundaries

Transcript cursors are entry-boundary cursors, and admission IDs are copied from durable input metadata so retries reconcile against the same input. Image bytes stay outside transcript snapshots and pages; clients fetch them by attachment index. Preserve these wire and paging semantics when changing transcript storage. See `apps/server/src/transcript/transcript.ts`.

Event payloads are serialized into one JSON line so payload text cannot escape its data field and become relay instructions. A byte-order mark is retained as payload text. See `apps/server/src/event-sources/event-payload.ts`.

Push delivery remains durable and at-least-once across uncertain sends: a token that rotates during delivery gets another attempt, and a provider success does not prove that a device displayed the notification. Stable collapse identifiers replace duplicate notifications for the same answer. Shutdown makes a final pass only after queued replies reach the outbox; an in-progress send is allowed to finish so its outcome is not lost. The app renders the answer from FCM string data. See `apps/server/src/push/push.ts` and `push-transports.ts`.

Message adapters receive stable chunk identifiers across retries and translate them to platform formats. Typing indicators are best effort; Discord refreshes its indicator before expiry. Disconnecting an adapter stops its workers before publishing replacement settings, preventing a stale connection from continuing with old credentials. See `apps/server/src/message-gateway/adapter.ts`, `gateway-connections.ts`, and `discord/adapter.ts`.

## Feature and platform contracts

A history search pushes one result per match because a transcript can exceed the search engine's argument limit. Reply-context normalization preserves owner metadata. See `apps/server/src/history/history-search.ts`.

MCP side-effect calls are bounded even when a client ignores cancellation. Their timeout reports the outcome as uncertain and does not replay the remote call. Credentials do not follow cross-host redirects. See `apps/server/src/integrations/integrations.ts`.

Review conversations are kept separate from the bot's chat transcript, and the review budget is checked before sending each model request. Callee-authored text does not enter a conversation that can write memory or skills. See `apps/server/src/learning/review-kind.ts` and `learning-review.ts`.

Skill copies are independent of their upstream source. Shared skills link into a bot while personal skills are copied; installing a batch is all-or-none when a target would exceed its limit. Active-skill edits count as activity, while stale-skill transitions use last-use time. See `apps/server/src/skills/owner-skills.ts`, `skill-installer.ts`, and `skill-curator.ts`.

Desktop chart layouts are compiled before clients receive them. The chart authoring API is a deliberate sandbox surface, and unsupported widths are dropped so clients can scale another layout. See `apps/server/src/display/chart-runtime.ts` and `charts.ts`.

The vision path does not silently erase an image the model was meant to see. Usage is recorded by provider and model in conversation usage data; optional provider counters are omitted to retain strict JSON documents. See `apps/server/src/vision/vision.ts`.

## Other feature contracts

- **History and activity:** Normalize reply context without dropping owner metadata. Search returns one result per match to avoid the engine's argument limit. The activity feed skips bots without durable history instead of initializing empty conversations, and its cursor resumes at an unconsumed transcript page. These choices preserve a read-only feed and bounded search requests. See `apps/server/src/history/history-search.ts` and `activity-api.ts`.
- **Memory and learned changes:** Shared memory uses the null owner scope. A revert restores a record without emitting another learned-change event; reverts own their event. Queries preserve their documented ownership and ordering. See `apps/server/src/memory/memory-repository.ts` and `learned-change-repository.ts`.
- **MCP connections:** Credentials never follow a cross-host redirect. A remote tool call is bounded even if its client ignores cancellation; a deadline does not replay a side-effecting call. OAuth connections use their provider's refresh path, and a disconnect during connection setup invalidates that attempt. See `apps/server/src/integrations/integrations.ts`.
- **Guest and workspace images:** The server's guest-image descriptor is the shared contract for server setup and Railway recipes; the guest-image test detects drift from the Dockerfile and startup scripts. The credential proxy authority is installed into the guest's trust bundle. Preserve these image-level setup requirements when changing guest recipes. See `apps/server/workspace-image/guest.ts`.
- **Vision and model use:** Dynamic catalogs expose refreshed models, not stale model lists. Image content is not silently dropped when the model is expected to see it. Usage is keyed by provider and model, and absent optional counters are omitted from strict JSON documents. See `apps/server/src/vision/vision.ts`.
- **Evaluation and test fixtures:** The intent evaluation makes paid model calls and runs locally, not in CI. Its test timeout exceeds Bun's default because the tested jobs settle through fixed sleeps. The Claude CLI and RFB fixtures model the external stream-json and noVNC message shapes they exercise; they use loopback or in-process peers rather than account credentials or external inference. See `apps/server/tools/intent-eval.ts`, `test/support/jobs.ts`, `test/fixtures/fake-claude.ts`, and `test/fixtures/rfb-client.ts`.

## Existing decisions

The fixed/runtime plugin boundary and persistent plugin identifiers remain documented in [ADR 0004](0004-plugin-interfaces.md). Compiled-in plugin settings remain documented in [ADR 0009](0009-plugin-settings.md).
