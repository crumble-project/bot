# MCP OAuth invalidation

**Status:** implemented

## Problem

Signing out of an MCP integration can be undone by an OAuth operation already in flight. The operation validates its state, awaits a token response, and then writes credentials after sign-out deleted them.

[F02 in the state-machine correctness review](../state-machine-correctness-review.md#finding-f02) reproduces this local invalidation failure. MCP sign-out does not revoke the remote grant. The problem is restored local authorization, not proof that remote revocation failed.

Changing an OAuth client also invalidates local authorization. Connection refreshes use the same provider storage and can perform delayed writes, so protecting callback completion alone is insufficient.

## Solution

Associate persisted authorization with a generation. Each OAuth operation captures its generation before asynchronous work. Sign-out invalidates it immediately; delayed operations cannot write or report successful authorization under an invalidated generation.

A fresh sign-in can proceed without waiting for an older network request. Older work cannot overwrite, delete, or consume the fresh sign-in's state.

## Behavior

1. **Sign-out overlaps callback completion.** Hold the token response, complete local sign-out, then release the response. The old completion fails as expired or stale. No OAuth credentials are restored.
2. **Sign-out overlaps authorization startup or connection refresh.** The older operation cannot recreate authorization, save registration or discovery state, or invalidate newer credentials. A refresh fails rather than restoring signed-in status.
3. **Client configuration invalidates authorization.** A successful client-ID or client-secret update fences all work using superseded configuration, including sign-in started while the update awaits connection disconnect. Such work cannot retain a valid generation merely because it started after the initial invalidation. Its delayed writes cannot restore old authorization.
4. **A fresh sign-in follows sign-out.** It receives a valid new generation and can complete while the old request remains outstanding. Releasing the old response cannot change the new credentials or consume the new callback state.
5. **Sign-out is repeated or no authorization exists.** The server remains locally signed out. No remote OAuth request is required to invalidate local authorization.
6. **Authorization completes normally.** Existing PKCE, state, issuer validation, client registration, token refresh, and one-use callback cleanup continue to work.
7. **Existing persisted authorization is loaded.** Existing credentials remain usable. Internal generation metadata must not force all owners to sign in again.
8. **Persistence fails.** A failed invalidation cannot return a successful sign-out acknowledgment. A failed guarded write cannot report successful authorization. Do not fall back to unguarded writes.

## Decisions

- Persist generation identity because storage, not an individual provider object, owns authorization validity.
- Capture the generation before the first asynchronous boundary, including client-secret lookup, because sign-out can occur during any awaited work.
- Guard every provider save, including token, registration, discovery, verifier, and credential-invalidation mutations, because they share the same writable state store.
- Guard callback completion and its state/verifier cleanup because stale cleanup must not modify a newer sign-in.
- Validate the captured generation when loading provider state so stale providers cannot adopt a newer authorization implicitly.
- Keep invalidation independent of remote requests because sign-out must not wait for an authorization server. Preserve existing connection-disconnect behavior; this is not a new latency guarantee for connection teardown.
- Coordinate configuration publication with authorization admission and invalidation because the current update invalidates before awaiting disconnect and publishing the client ID. Reordering invalidation alone is insufficient if an operation already holds an old server snapshot. A successful update must leave no valid generation attached to superseded configuration.
- Reject a lock held across OAuth network requests because it delays local invalidation behind potentially stalled requests.
- Reject a check only after token exchange because the provider may already have persisted credentials.
- Reuse the existing encrypted per-account secret storage rather than introduce a database table or dependency.
- Preserve existing public interfaces and error categories. Stale completion uses the existing expired-sign-in behavior rather than a new API error contract.
- Retain local-only sign-out semantics; remote grant revocation is a separate feature.

## Interfaces and data

The internal persisted OAuth representation gains generation identity. Public APIs, tool schemas, configuration, and database schemas do not change.

Generation identity must not be reused after invalidation. A deleted record followed by a new sign-in must not recreate an identity accepted by an old operation. An absent record never authorizes an old provider to recreate itself. The exact representation is an implementation choice, provided these rules hold.

Read/check/write operations at the authorization boundary must not yield between checking the stored generation and writing. `SecretStorage.get`, `set`, and `delete` are currently synchronous. Independent storage adapters created for the same account must observe the same persisted generation; an adapter-local counter is insufficient.

Legacy records without generation metadata require a synchronous upgrade before an operation captures its generation. Preserve their existing state and tokens. A callback attempt and a connection refresh capture the current identity, while creation or replacement of authorization after invalidation establishes a fresh identity.

Existing callback-state validation remains required. A generation fences invalidation; it does not replace PKCE, issuer validation, or the one-use state check.

Client configuration and generation validity must agree at authorization admission and at guarded writes. An operation holding a superseded server snapshot cannot establish or retain a valid authorization generation after the update succeeds. The implementation may coordinate admission or validate persisted configuration identity, but must not hold a lock across remote OAuth requests.

## Affected code

- `apps/server/src/integrations/mcp-oauth.ts`: own generation capture, persisted identity, guarded provider storage, local invalidation, and guarded completion cleanup. Keep `startAuthorization`, `finishAuthorization`, `connectionAuth`, and `signOut` as the existing entry points.
- `apps/server/src/integrations/mcp-servers.ts`: coordinate changed-client publication, authorization admission, and invalidation so old configuration cannot acquire a surviving generation during update. Preserve sign-out and server cleanup through `forget`, using the same durable fence.
- Service-level regression coverage for `McpServers.update`: use the existing service test setup where available; otherwise add a colocated test file. Exercise the actual update caller rather than simulating configuration changes with a direct `signOut` call.
- `apps/server/src/integrations/integrations.ts`: preserve connection-disconnect generations and OAuth selection. Its existing generation check rejects stale connection acquisition, but does not protect persisted OAuth writes; use it as lifecycle prior art, not as the storage fence.
- `apps/server/src/secrets/server-secrets.ts`: reuse the existing encrypted synchronous storage adapter without changing its public service contract.
- `apps/server/src/integrations/mcp-oauth.test.ts`: extend the existing local authorization-server fixture and temporary encrypted store to test delayed writes through real OAuth code.
- `apps/docs/content/concepts/schedules-and-integrations.md`: clarify local sign-out behavior and that older sign-in work cannot restore authorization.
- `CHANGELOG.md`: describe the local invalidation fix.
- `docs/state-machine-correctness-review.md`: add F02 remediation and verification evidence while preserving the historical finding.

The installed `@earendil-works/pi-mcp` provider routes its mutations through the injected `McpOAuthStateStore`. Guard that application-owned boundary; do not modify dependency internals.

## Testing

The agreed primary seam is the existing OAuth functions in `apps/server/src/integrations/mcp-oauth.test.ts`, using the real provider, a temporary encrypted store, and a gated loopback authorization server. Use separate `secretStorage` adapters over the same store where appropriate to rule out adapter-local coordination.

Cover sign-out during code exchange, changed-client invalidation during code exchange, sign-out during refresh, and a fresh sign-in completing before the stale response is released. Assert stored authorization and operation outcomes, not merely connection closure. Explicitly verify that stale completion leaves newer credentials and callback state untouched.

The agreed additional seam is the real `McpServers.update` service. Hold its connection disconnect, start authorization during the update window, complete the update, and then release OAuth work. Assert that credentials for superseded configuration do not remain valid. Include work that captured the old server snapshot before publication, so the test does not merely verify a moved invalidation call.

Inject storage failures for invalidation, provider save, and completion cleanup. Each failure must prevent the corresponding successful acknowledgment. Assert that no retry or fallback bypasses the generation guard. A delegating `SecretStorage` wrapper can throw at selected operations while retaining real encrypted storage and OAuth exchange elsewhere; no public testing-only API is needed.

Use explicit response gates, not sleeps. Sign-out must finish before releasing the blocked response. Demonstrate the F02 regression failing before the fix and passing afterward. Preserve the existing successful sign-in, state-replay rejection, issuer validation, failed-refresh, and OAuth-precedence tests.

Also cover invalidation during client-secret lookup, persisted legacy records, and generation visibility across storage adapters. Observe registration or discovery writes when testing startup invalidation, since token-only assertions cannot establish that every save is fenced.

A stale provider must not be able to load a new generation and then mutate it, including through credential invalidation. Test this through the real provider/authentication boundary without adding public testing-only APIs.

The existing fixture supports real local HTTP exchange and encrypted storage. No real accounts, credentials, remote providers, or paid APIs are required. Do not claim crash durability or remote grant revocation from these tests.

## Out of scope

- Remote OAuth grant revocation.
- F03 GitHub owner authorization and F21 competing connection ownership.
- Serializing all simultaneous sign-in attempts or providing exactly-once token exchange.
- Redesigning MCP connection ownership, public API contracts, or secret storage.
- Multi-process writers sharing one account database; synchronous fencing relies on the existing single-process ownership model.

## Open questions

None. The persisted identity representation remains an implementation choice bounded by the invariants in Interfaces and data.
