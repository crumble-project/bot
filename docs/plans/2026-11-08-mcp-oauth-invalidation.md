# MCP OAuth invalidation implementation plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** Prevent older OAuth work from undoing MCP sign-out or client-configuration invalidation.
**Architecture:** Store a non-reused generation with OAuth state and bind providers to that generation before asynchronous work. Guard loads, saves, and completion cleanup; coordinate configuration publication with authorization admission without locking remote requests.
**Source:** [Reviewed specification](../designs/mcp-oauth-invalidation.md), including both resolved review findings; [F02](../state-machine-correctness-review.md#finding-f02).

## Decisions

- Persist identity in encrypted OAuth state, not an adapter-local counter, because independent adapters must share invalidation.
- Capture before client-secret lookup; every awaited boundary can overlap invalidation.
- Fence provider loads and every save, not only tokens, because stale providers must not mutate newer state.
- Fence completion cleanup and the successful return, so old work cannot consume a newer callback or report success.
- Use fresh identity after invalidation; absence never permits an old provider to recreate authorization.
- Upgrade legacy records synchronously while retaining credentials; do not force existing owners to sign in again.
- Coordinate client configuration with admission, including stale server snapshots and starts during disconnect.
- Keep sign-out independent of remote OAuth responses; reject locks spanning network requests.
- Preserve PKCE, state, issuer validation, connection disconnects, and local-only sign-out semantics.

## Constraints

- Read applicable `AGENTS.md`, `GLOSSARY.md`, and `CONTRIBUTING.md`.
- Read `apps/server/node_modules/effect/AGENTS.md` completely before writing Effect code.
- No new dependencies, database migrations, public API changes, real credentials, paid APIs, or external services.
- Tests may use the existing loopback OAuth server and temporary encrypted store.
- No staging, commits, pushes, or branch changes without explicit permission.
- Root verification: `CRUMBLE_VM_TESTS=0 CRUMBLE_RAILWAY_TESTS=0 bun run check`.
- User-doc verification: `bun run check` from `apps/docs`.

## Out of scope

Remote grant revocation; F03 and F21; exactly-once token exchange; serializing all competing sign-ins; multi-process database writers; connection-manager redesign.

## Execution evidence

- Before Task 1 production changes, the focused suite had five failures: stale exchange, registration, newer sign-in, client-secret lookup, and missing legacy generation. Five existing tests passed. Refresh and persistence-fault cases were added after the fix, so their pre-fix outcomes were not observed.
- Before Task 2 production changes, a real update test admitted and completed old-client sign-in while disconnect was blocked; its final token assertion failed. After reordering publication, the test checks that old snapshots are rejected and the published client can sign in during disconnect. A second test gates secret mutation and verifies that an authorization admitted during publication is invalidated.
- A later admission regression failed before adding persisted client and server identity checks, and passes afterward. The implementer's root check passed with 1,078 tests passed and 118 skipped. Focused suites now pass all 20 tests with 64 assertions after adding successful stale-refresh coverage, independently rerun by the reviewer. `bun run check` in `apps/docs` and diff checks pass. Fresh review and follow-up review found no meaningful issues; the spec is implemented. The final root-check repeat passed: 1,080 tests passed, 118 skipped, 0 failed. Two earlier repeats stopped on spacing lint errors in the added refresh cases; those were corrected before the passing run. The loopback tests do not establish crash durability or remote revocation.

## Review focus

1. Sign-out during startup, exchange, or refresh: older work cannot persist any state or report authorization success.
2. Client configuration changes during disconnect or after snapshot capture: superseded configuration cannot retain a valid generation.
3. New sign-in succeeds before old completion: old loads, writes, invalidation, and cleanup leave new credentials and callback state untouched.
4. Storage faults: invalidation, provider saves, and cleanup reject without an unguarded fallback.
5. Legacy records and separate adapters: preserve valid credentials while sharing durable generation identity.

## Files

- `apps/server/src/integrations/mcp-oauth.ts`: persisted generation, guarded provider storage, stale errors, legacy upgrade, and completion fencing.
- `apps/server/src/integrations/mcp-servers.ts`: configuration/admission coordination using the same persisted fence.
- `apps/server/src/integrations/integrations.ts`: supply the repository service required by the storage adapter's current-server check.
- `apps/server/src/integrations/mcp-oauth.test.ts`: gated OAuth and persistence-failure regressions.
- Create `apps/server/src/integrations/mcp-oauth-test-support.ts`: extract the existing loopback authorization-server fixture for reuse by both suites, with caller-owned cleanup and explicit response gates.
- Create `apps/server/src/integrations/mcp-servers.test.ts`: service-level regressions using existing `mcpServersOver` from `integrations-test-support.ts:40` and the temporary `Store` runtime from `test/support/store.ts:10`. Supply a controlled `McpIntegrations` service with a gated `disconnect`; retain real repositories and secrets.
- `apps/docs/content/concepts/schedules-and-integrations.md`: document local sign-out and stale-operation protection.
- `CHANGELOG.md`: Unreleased fix entry.
- `docs/state-machine-correctness-review.md`: F02 remediation and verification note, preserving historical findings.
- `docs/designs/mcp-oauth-invalidation.md`: implemented status only after verification and fresh review.

### Task 1: Fence delayed OAuth mutations

**Files:** Modify `mcp-oauth.ts` and `mcp-oauth.test.ts`; create `mcp-oauth-test-support.ts` in the integrations directory.
**Interfaces:**
- Preserve `SecretStorage.get(key: string): string | undefined`, `set(key: string, value: string): void`, `delete(key: string): void`, and `clientSecret(serverId: string): Promise<string | undefined>` (`mcp-oauth.ts:96`).
- Add internal `SecretStorage.currentServer(serverId: string): MCPServer | null`, backed by synchronous `McpServerRepository.get` through the existing runner. Include `McpServerRepository` in `secretStorage`'s required runner services. The repository exposes `get` in `mcp-server-repository.ts:37`; the test Store provides its core services.
- Preserve existing `startAuthorization`, `finishAuthorization`, `connectionAuth`, and `signOut` entry points.
- Add a `generation: string` field to the existing `SavedOAuth` record. Generate opaque, non-reused identities with `crypto.randomUUID()`. Synchronously upgrade a valid legacy record before capturing it, preserving its payload. Sign-out can retain its existing deletion: old operations require a present record with their exact identity, and a new start creates a fresh identity.
- Bind each provider to the captured generation, normalized server URL, and OAuth client ID. Admission and every guarded load/save must also compare the supplied server snapshot against `currentServer`; reject missing servers or mismatched configuration. Existing `SavedOAuth` already retains redirect URL, server URL, and client ID (`mcp-oauth.ts:23`).
- Capture before awaiting `ownerSecret`; after that await, verify the same identity/configuration rather than creating or adopting another generation. A stale start must never run a record-reset path after an await.
- Task 2 consumes the unchanged synchronous `signOut(storage: SecretStorage, serverId: string): void` and the current-server checks. It needs no new network-spanning lock or exported generation helper.

- [x] Extract the existing `fakeAuthorizationServer` fixture into `mcp-oauth-test-support.ts` and import it from both suites. Expose caller-owned cleanup instead of coupling it to one test file's cleanup array. Extend it with explicit request/response gates for code exchange, refresh, and registration/discovery. Do not use sleeps.
- [x] Add sign-out-during-exchange regression: wait for token request; sign out through a different storage adapter; assert `hasOAuthTokens(...) === false`; release response; assert completion rejects and tokens remain absent.
- [x] Add sign-out-during-refresh and startup regressions. Assert no restored tokens or other OAuth state; stale operations reject, and sign-out does not await response release.
- [x] Add fresh-sign-in-after-sign-out regression. Complete the new sign-in before releasing the old response; assert old work rejects without changing the new token or consuming its callback state. Also exercise stale provider credential invalidation against the new generation.
- [x] Add invalidation-during-client-secret-lookup coverage using a deferred `clientSecret` implementation; old startup, completion, and connection-provider acquisition cannot adopt the new generation.
- [x] Add legacy-record upgrade coverage and separate-adapter visibility coverage. Assert legacy tokens remain usable and old identities are not reused after deletion/recreation.
- [x] Add a delegating storage wrapper injecting failures at invalidation, provider save, and completion cleanup. Assert rejection, no successful acknowledgment, and no subsequent unguarded fallback write.
- [x] Run `bun test apps/server/src/integrations/mcp-oauth.test.ts` before production changes. Record which new security regressions fail; compatibility and fault tests may already pass.
- [x] Implement synchronous legacy upgrade, non-reused generation capture, and guarded load/save/cleanup. A registration reset for changed URL, redirect URL, or client ID must create a fresh identity rather than reuse the replaced record's generation. Use the existing expired-sign-in error category; check generation again before returning authorization success. Keep all guard/read/write boundaries free of awaits.
- [x] Run the same focused command; expect all OAuth tests to pass, including existing issuer, replay, PKCE, refresh-failure, and OAuth-precedence coverage.
- [x] Checkpoint: inspect only Task 1's diff; do not stage or commit.

### Task 2: Coordinate client publication with OAuth admission

**Files:** Modify `mcp-servers.ts`, extend `mcp-oauth.ts` only through Task 1's interface, and add the service regression at the verified test path.
**Interfaces:** Consumes Task 1's persisted fence and configuration identity boundary. Preserve public `McpServers.update`, `startSignIn`, `finishSignIn`, and `signOut` service contracts.

- [x] Add a regression through real `McpServers.update`: hold disconnect, start sign-in using old configuration, finish the update, then release OAuth work. Assert superseded credentials cannot remain authorized.
- [x] Add stale-snapshot coverage: capture the old server configuration before publication and resume admission afterward. Assert rejection rather than a new valid generation for the old client.
- [x] Cover client-ID and client-secret changes, existing sign-out cleanup, and server removal. Assert an old provider cannot recreate removed authorization.
- [x] Run `bun test apps/server/src/integrations/mcp-servers.test.ts` before Task 2's production changes and record failures.
- [x] For updates that change OAuth client ID or supply a client-secret mutation, invalidate before the first awaited secret mutation. After successful configuration publication, invalidate again before awaiting disconnect. The final invalidation fences starts admitted during publication; Task 1's current-server checks reject operations holding old client-ID or URL snapshots after publication. Preserve token-only updates and existing disconnect behavior. Do not hold a lock across OAuth requests.
- [x] Assert a fresh sign-in using the published configuration succeeds after update, including when disconnect is still pending. If an update fails, do not acknowledge success or restore previous credentials; propagate the existing failure.
- [x] Run `bun test apps/server/src/integrations/mcp-oauth.test.ts apps/server/src/integrations/mcp-servers.test.ts`; expect all enabled cases to pass.
- [x] Checkpoint: inspect Task 2's diff against the configuration invariant; do not stage or commit.

### Task 3: Document and verify F02 remediation

**Files:** Modify the documentation, changelog, overview, and spec listed in Files.
**Interfaces:** No new code interfaces.

- [x] Update MCP integration documentation to explain immediate local invalidation and distinguish it from remote grant revocation.
- [x] Add an Unreleased changelog entry and F02 remediation note. Keep historical audit counts and original reproduction intact; link the spec from the remediation overview.
- [x] Run both focused suites, then `CRUMBLE_VM_TESTS=0 CRUMBLE_RAILWAY_TESTS=0 bun run check`. Record exact results, skipped tests, and any blockers.
- [x] Run `bun run check` from `apps/docs` and `git diff --check` from the root. Expect success.
- [x] Request fresh-context `vet` using `@reviewer` against `docs/designs/mcp-oauth-invalidation.md`, not this plan. Resolve concrete findings and rerun affected checks.
- [x] Set the spec status to implemented only when verification and review support it. Record local-fixture limitations without claiming crash durability or remote revocation.
- [x] Checkpoint: review the final changed-file list. Suggested commit, only with approval: `fix(mcp): fence OAuth writes after authorization invalidation`.
