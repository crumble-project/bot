# GitHub owner authorization invalidation

**Status:** implemented

## Problem

A delayed GitHub owner-token refresh can restore signed-out state. Refresh captures the owner row, awaits GitHub, and then upserts the captured identity and new tokens. If sign-out deleted the row during that wait, the upsert recreates it.

[F03 in the state-machine correctness review](../state-machine-correctness-review.md#finding-f03) reproduces this with encrypted SQLite. The restored row makes Crumble show the owner as signed in and choose owner credentials instead of installation credentials. Continued token validity after successful remote revocation is not established or required to prove this local failure.

There are related writers at the same boundary: sign-in completion can create an owner row, and sign-out currently deletes the row only after awaiting remote revocation. Protecting refresh alone would leave older sign-in completion able to restore authorization, or late sign-out cleanup able to delete a newer sign-in.

## Solution

Give owner authorization a persisted, non-reused identity scoped to one GitHub App. Sign-out invalidates earlier work and removes the local owner before attempting remote revocation. Delayed refresh or sign-in completion cannot restore authorization after that invalidation or overwrite a newer sign-in.

Refresh updates only the exact owner authorization it started from. It never inserts a missing owner row. Once signed out, subsequent credential requests follow the existing installation-token path.

## Behavior

1. **Sign-out overlaps successful refresh.** Hold the refresh response, sign out, then release a successful response. The owner remains absent, the stale refresh fails without returning its token, and later credential requests use installation credentials.
2. **A newer sign-in replaces the owner during refresh.** The older refresh cannot overwrite the newer owner identity or tokens, even if the GitHub user is the same. It fails rather than returning a token from the superseded authorization.
3. **Sign-out overlaps sign-in completion.** Earlier sign-in work cannot create an owner row after invalidation. This includes completion waiting for a client secret, token exchange, or the `/user` lookup.
4. **Sign-out occurs with only a pending sign-in.** Even without an owner row, sign-out invalidates earlier pending sign-ins. Their callbacks fail as stale. A newly requested sign-in can still complete.
5. **Remote revocation is delayed or fails.** Local authorization is already absent while the revocation request is pending. Revocation remains best-effort and bounded by the existing timeout. The sign-out endpoint may continue waiting for that attempt; no new response-latency guarantee is introduced.
6. **A new sign-in occurs during old sign-out revocation.** Late local cleanup from the old sign-out cannot delete the new owner row. The old revocation still uses its captured credentials. GitHub might revoke a grant used by the new sign-in; preserving its remote validity is not promised.
7. **Refresh succeeds without invalidation.** Preserve token rotation and existing serialization so concurrent token requests do not independently consume the same refresh token. The owner identity remains unchanged.
8. **Existing persisted credentials are loaded.** Preserve usable credentials without requiring every owner to sign in again. Any internal identity upgrade must retain encrypted tokens and expiry information.
9. **Persistence fails.** Failed local invalidation cannot acknowledge successful sign-out. A failed refresh or completion write cannot return a successfully persisted token or sign-in result. No fallback may bypass identity checks.
10. **The App is removed.** Delayed owner work cannot recreate authorization for a removed App. Preserve existing database cascade behavior.

The guarantee is about local authorization state and token acquisition. It does not retract tokens already returned to callers before invalidation, cancel already admitted external requests, or prove remote token validity.

## Decisions

- Fence refresh, sign-in completion, and sign-out at one authorization boundary because each can change the same owner's identity or credentials.
- Persist non-reused authorization identity because deleting and recreating an owner row, including for the same GitHub user, must not make old work current again.
- Associate pending sign-ins with the invalidation identity because sign-out must invalidate callbacks even when no owner row exists.
- Capture identity before asynchronous credential lookup or GitHub calls because invalidation can occur during any wait.
- Refresh must conditionally update its captured authorization, never upsert, because a missing row means it no longer owns the authorization.
- Successful sign-in establishes a new owner-authorization incarnation because an older refresh must not overwrite newly signed-in credentials. Invalidation identity and owner incarnation may use distinct persisted identifiers if needed.
- Guard sign-in admission and pending-state persistence as well as completion because a delayed authorization start must not create a valid pre-sign-out attempt after invalidation.
- Invalidate and remove local authorization before remote revocation because a remote request must not keep local owner state active.
- Capture revocation inputs before local removal and never perform an unconditional owner deletion afterward because late cleanup could delete a newer sign-in.
- Preserve best-effort remote revocation because this fix corrects local invalidation rather than removing the existing remote safety measure.
- Preserve refresh serialization because GitHub rotates refresh tokens. Reject a new lock held across remote revocation or sign-in requests as the invalidation mechanism.
- Reject an owner-exists check followed by an unguarded write because sign-out or a newer sign-in can occur between them. The persistence boundary must atomically enforce the captured identity.
- Reject a refresh-only fix because pending completion and late sign-out deletion can violate the same invariant.
- Reuse existing encrypted account persistence and repository transaction patterns. No new dependency or public API is needed.

## Interfaces and data

Keep the public `GitHubAppUsers` and `GitHubApps` service contracts, API responses, and configured GitHub App credentials unchanged. Stale refresh uses the existing `GitHubUnavailable` category; stale callback completion uses `InvalidInput`.

Persist enough identity to distinguish local invalidation from a later sign-in and to distinguish the current owner incarnation from the one captured by refresh. Signed-out state must still fence pending sign-ins; absence of an owner row alone is insufficient. Exact representation is an implementation choice, bounded by these invariants.

Generation checks and owner mutations must be atomic with respect to competing local mutations. Across awaited Effect operations, do not rely on a separate read check remaining true until a later write. Use the repository's database transaction or conditional-write boundary as appropriate.

Existing owner rows require a compatible identity upgrade. Legacy pending sign-ins lacking identity may be rejected as stale rather than silently attached to current authorization. Owners with such a pending flow can start again; existing signed-in owners retain credentials.

No changes to remote endpoints, scopes, callback URLs, expiry margins, settings, or permissions are required. Any persistent format change must be documented, and a database schema change requires following `CONTRIBUTING.md`.

## Affected code

- `apps/server/src/github-apps/github-app-users.ts`: own pending-flow invalidation, owner incarnation, guarded completion and refresh writes, and local-first sign-out. Preserve successful refresh serialization and credential encryption.
- `apps/server/src/github-apps/github-apps.ts`: preserve existing owner-versus-installation credential selection; verify it through the public token service rather than replacing its routing policy.
- `apps/server/src/github-apps/github-api.ts`: preserve existing token exchange, user lookup, and best-effort bounded grant revocation. Intercept these HTTP boundaries in tests instead of using a real account.
- `apps/server/src/github-apps/github-apps-api.ts`: preserve the sign-out and completion handlers and their existing error mapping.
- `apps/server/src/github-apps/schema.ts`: existing owner and App records define the storage boundary. Change only if the selected identity representation requires a migration.
- `apps/server/src/secrets/server-secrets.ts`: existing `PendingStates` provides encrypted, expiring callback state; include authorization identity in the saved callback payload rather than inventing a separate callback mechanism.
- `apps/server/src/integrations/mcp-oauth.ts`: prior art from F02 for durable non-reused identities, capture before awaited secret lookup, and rejection of stale writers. Reuse the principle, not its synchronous adapter assumptions in Effect code.
- `apps/server/src/providers/provider-auth.ts`: existing credential-mutation coordination is lifecycle prior art; it does not replace durable fencing for GitHub owner state.
- `apps/server/src/github-apps/github-app-users.test.ts` (new): real owner-service regressions and fault coverage using encrypted SQLite.
- `apps/server/src/github-apps/github-apps.test.ts` (new): credential-routing regression through the real `GitHubApps.token` service.
- `apps/docs/content/concepts/credentials.mdx`: document local invalidation and preserve the distinction from remote grant revocation.
- `CHANGELOG.md`: describe the signed-out owner-state fix.
- `docs/state-machine-correctness-review.md`: append F03 remediation and observed verification evidence without rewriting the historical finding.

## Testing

The agreed primary seam is the real `GitHubAppUsers` service with temporary encrypted SQLite and intercepted GitHub HTTP responses. Cover delayed successful refresh after sign-out, refresh overlapping a newer sign-in, stale completion at secret lookup/token exchange/user lookup, pending-only sign-out, and old sign-out revocation overlapping a fresh sign-in.

A second agreed seam is the real `GitHubApps.token` service. After the stale-refresh sequence, assert owner absence and an installation-token request and result, rather than only asserting which branch source code would select. Preserve existing machine-account and App-selection policies.

Use explicit promise gates, not sleeps. Verify local owner removal while revocation remains blocked, then release the old response and verify persisted state again. For a newer sign-in, assert both its identity and its credentials remain unchanged after old work settles. Include the same-user case to detect implementations that compare only GitHub user IDs.

Also verify normal refresh rotation, concurrent refresh serialization, existing credential compatibility, removed-App behavior, and failures of invalidation, refresh persistence, and completion persistence. Faults must reject without success or unguarded fallback. No new public testing-only API is required.

Model temporary-store setup on `apps/server/test/support/store.ts`; the core layer already supplies `GitHubAppUsers` and `GitHubApps`. Model explicit HTTP response gates on `apps/server/src/integrations/mcp-oauth-test-support.ts`. Keep HTTP interception scoped to fixtures and fail closed on unexpected requests; never pass through to real GitHub.

Demonstrate the F03 regression failing before the fix and passing afterward. Where expanded tests already pass, record that accurately rather than claiming every case reproduced a pre-existing defect. No real keys, remote accounts, paid services, simulators, or emulators are needed. Local fixture success does not prove remote revocation effects or crash durability.

## Out of scope

- F02 MCP OAuth and F25 GitHub manifest conversion.
- Guaranteeing that a newer sign-in's remote grant survives an older revocation request.
- Exactly-once callback exchange, serialization of all simultaneous sign-ins, or arbitrary crash recovery after remote token rotation.
- Changing client-secret replacement policy, credential-selection policy, permissions, token lifetimes, or sign-out API shape.
- Retracting previously returned credentials or cancelling already admitted GitHub actions.
- Multi-process writers sharing an account database.

## Open questions

None. The persisted identity representation remains an implementation choice within the stated atomicity and compatibility requirements.
