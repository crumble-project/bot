# GitHub owner authorization invalidation implementation plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** Prevent delayed GitHub owner refresh and sign-in completion from restoring signed-out state or overwriting a newer sign-in.
**Architecture:** Persist an App-scoped invalidation epoch and owner incarnation in existing encrypted account storage. Atomically fence owner mutations with those identities; refresh updates an existing row only. Sign-out commits local invalidation and removal before remote revocation.
**Source:** [Reviewed F03 specification](../designs/github-owner-authorization-invalidation.md) and [F03 audit evidence](../state-machine-correctness-review.md#finding-f03).

## Decisions

- Fence authorization start, completion, refresh, and sign-out together because they share owner state.
- Persist distinct invalidation and owner identities: sign-out must fence pending-only flows, and a new login by the same user must fence older refreshes.
- Capture before credential lookup or remote waits; validate at atomic persistence boundaries, not with a check separated from a write.
- Refresh never inserts an owner row and never returns a stale token after a rejected write.
- Invalidate locally before remote revocation; retain captured revocation credentials and never delete a newer row afterward.
- Preserve refresh serialization and best-effort bounded remote revocation. Do not hold a new mutation lock across network calls.
- Preserve existing credentials through lazy identity initialization. Reject legacy pending callbacks lacking identity as stale.
- Keep public contracts, token routing policy, client-secret replacement policy, and remote endpoints unchanged.

## Constraints

- Read applicable `AGENTS.md`, `GLOSSARY.md`, and `CONTRIBUTING.md`.
- Read `apps/server/node_modules/effect/AGENTS.md` completely before writing Effect code.
- No new dependency, public API change, or real network/provider use in tests.
- Use temporary encrypted SQLite and explicitly gated, fail-closed HTTP interception.
- No staging, commits, pushes, or branch changes without permission.
- Root checks: `CRUMBLE_VM_TESTS=0 CRUMBLE_RAILWAY_TESTS=0 bun run check`.
- Documentation checks: `bun run check` from `apps/docs`.

## Out of scope

Remote validity after revocation; F02 and F25; exactly-once callback exchange; serializing every competing sign-in; arbitrary crash recovery after remote rotation; changing refresh lifetimes or credential selection; multi-process writers; retracting already-returned tokens.

## Execution evidence

- Before production changes, both focused suites reported 17 failed and 2 passed. The routing regression returned `access-refresh-1` instead of `installation-fixture`; the owner remained present while revocation was blocked. Normal refresh serialization and failed-refresh persistence already passed.
- An initial fixture run used an incorrect trigger table name; corrected it from `secrets` to the actual `credentials` table before recording the baseline above.
- After the atomic fencing change, both focused suites passed all 19 tests with 71 assertions. Initial lint found spacing issues, chained test ternaries, and an unnecessary iterable spread; those were corrected. Fresh review found no meaningful issues and independently passed the 19-test suite. Two additional assertions now verify revocation uses the original token and an older callback cannot adopt a completed newer sign-in; focused suites now pass 20 tests with 76 assertions. Docs checks passed, including strict link validation. The first root check stopped on the fetch fixture's missing Bun `preconnect` member; the fixture was corrected without a cast or network fallback. A subsequent repeat stopped on a test-spacing lint error, also corrected. The final root check passed with 1,100 passed, 118 skipped, and 0 failed; all enabled lint, formatting, types, OpenAPI, and test checks passed. The spec is implemented.

## Review focus

1. Successful delayed refresh after sign-out cannot restore owner state or return its token; subsequent requests mint installation credentials.
2. Old refresh/completion cannot overwrite a fresh sign-in, including the same GitHub user.
3. Pending-only sign-out and delayed authorization admission cannot publish a usable stale callback.
4. Local invalidation commits before remote revocation; its late completion cannot remove a newer owner.
5. Storage faults, lazy legacy upgrade, and App removal preserve atomicity and fail closed.

## Files

- `apps/server/src/github-apps/github-app-users.ts`: identity capture, guarded mutations, compatible initialization, and local-first sign-out.
- Create `apps/server/src/github-apps/github-app-users.test.ts`: owner-service regression and fault tests.
- Create `apps/server/src/github-apps/github-apps.test.ts`: real installation-token routing regression.
- Create `apps/server/src/github-apps/github-app-users-test-support.ts`: shared encrypted-store setup, typed fixture data, request gates, and scoped GitHub interception.
- `apps/docs/content/concepts/credentials.mdx`: local sign-out behavior and remote-revocation limits.
- `CHANGELOG.md`: Unreleased F03 fix entry.
- `docs/state-machine-correctness-review.md`: remediation overview and F03 verification evidence.
- `docs/designs/github-owner-authorization-invalidation.md`: implemented status only after checks and review.

### Task 1: Fence owner-service mutations

**Files:** Modify `github-app-users.ts`; create the owner-service test and shared support files listed in Files.
**Interfaces:**
- Preserve `GitHubAppUsers.of`, `authorize`, `complete`, `signOut`, `setClientSecret`, and `token` contracts.
- Persist private metadata `{ epoch: string, owner: string | null }` under `secretKey("github-app-user-auth", appId)` using existing encrypted storage. Both identities are opaque `crypto.randomUUID()` values. Do not add a schema migration.
- Add `epoch` to the private pending sign-in payload; legacy callbacks without it fail with the existing stale-sign-in `InvalidInput`.
- Consume `atomic(db)(effect)` from `shared/product-database.ts:12`, using the same `ProductDatabase` instance as `SecretRepository` and `PendingStates`. Inject existing `ServerSecrets` for metadata `get`/`set` operations; it delegates to the encrypted `SecretRepository` (`secrets/secret-repository.ts:56–104`). Execute repository effects directly inside the transaction fiber; do not escape through a separate runner.
- Decode the private metadata through an existing schema library, distinguishing absence from malformed data. Only absent metadata allows legacy initialization; malformed metadata fails closed instead of resetting identity.
- Snapshot the current metadata and owner row inside `atomic(db)` for both cached-token acquisition and refresh admission. The snapshot is the cached-token admission boundary; already admitted token returns are not revoked retroactively. Before a refresh persists, revalidate epoch, owner incarnation, and row presence in a fresh transaction.
- Preserve database-fault behavior as an Effect defect rather than widening public error contracts; `atomic` converts SQL transaction errors to defects and existing owner queries use `Effect.orDie`. For stale authorization admission use the existing `Conflict` channel; stale completion uses `InvalidInput`, and stale refresh uses `GitHubUnavailable` (`github-app-users.ts:60–80`). Use failure exits in fault tests, not assertions limited to typed errors.

- [x] Build fixture setup using the real core/store runtime. Insert synthetic App and owner rows through actual schema/database access and encrypt tokens with `SecretBox`; close runtimes before deleting temporary directories.
- [x] Scope GitHub fetch interception to expected OAuth exchange, `/user`, revocation, and installation-token requests. Reject every unexpected request; restore interception in cleanup. Provide explicit reached/release gates, not sleeps.
- [x] Add the primary regression: near-expiry owner token, gated successful refresh, sign-out, released refresh. Assert owner absent while revocation is blocked, stale refresh rejects with `GitHubUnavailable`, and persisted owner remains absent after all old work settles.
- [x] Add refresh versus fresh sign-in for both a different user and the same user. Assert the new encrypted token pair, expiry fields, and owner identity remain unchanged after the old refresh responds.
- [x] Add stale completion cases at client-secret lookup, exchange, and `/user` lookup; sign out before release and assert stale `InvalidInput` plus no owner creation.
- [x] Add delayed authorize admission and pending-only sign-out cases. Old work must not publish a usable callback; a newly authorized flow must complete.
- [x] Add sign-out revocation versus fresh sign-in. Hold old revocation, verify local owner absence, complete fresh sign-in, release revocation, and assert the new local row survives.
- [x] Add compatible initialization for existing owner rows, legacy pending rejection, removed-App rejection, normal refresh rotation, and concurrent refresh serialization.
- [x] Inject faults during local invalidation, refresh persistence, and completion persistence. Assert failure, no successful token/sign-in result, no unguarded retry, and rollback of partial local mutation.
- [x] Run `bun test apps/server/src/github-apps/github-app-users.test.ts` before production changes. Record actual failures for F03 and related schedules; compatibility tests may already pass.
- [x] Implement atomic lazy metadata initialization. A legacy owner gets an owner incarnation without changing its encrypted tokens or expiry; signed-out state gets a durable epoch with `owner: null`. Never recreate metadata for a removed App.
- [x] Capture epoch before authorization awaits, and transactionally verify it when publishing pending state and completing sign-in. Completion checks App existence and creates a fresh owner incarnation with its owner upsert in one local transaction.
- [x] Capture epoch and owner incarnation with the refresh row. Persist successful refresh through an update-only operation guarded by both identities and row presence in the same transaction; reject stale work rather than return the response token.
- [x] Resolve any client secret needed for revocation outside the transaction. Then atomically capture the current App/client ID and owner token, rotate epoch, set `owner: null`, and delete the owner. The transaction is sign-out's local invalidation boundary, so re-read current owner state there rather than deleting based on a snapshot taken before secret lookup. Only afterward attempt best-effort remote revocation using captured inputs. Perform no owner deletion after remote waits. Pending-only sign-out must rotate identity too; a removed App must not gain newly initialized metadata.
- [x] Keep the existing refresh semaphore. Ensure the cached-token fast path obtains its row/identity coherently without pretending to retract tokens already returned before invalidation.
- [x] Run the owner-service suite. Expect all cases to pass and capture exact results.
- [x] Checkpoint: inspect the Task 1 diff; no staging or commits.

### Task 2: Prove installation-token routing after stale refresh

**Files:** Create `github-apps.test.ts`; extend `github-app-users-test-support.ts` only for shared fixture needs.
**Interfaces:** Consumes Task 1's real service behavior and metadata; invokes existing `GitHubApps.token(agentId, target)` without changing routing policy.
- Use existing `Store.createAgent(input, agentId?)` (`test/support/store-bots.ts:34`) for a bot and insert its `githubAppBots` assignment with `appId`, `agentId`, and `assignedAt`. Insert an App with `account: "fixture-owner"`, `installationId: 42`, and an encrypted throwaway RSA private key generated locally in fixture setup; this is not a production credential. These fields are defined in `github-apps/schema.ts`.
- Invoke `GitHubApps.token(bot.id, { host: "api.github.com", path: "/repos/fixture-owner/project" })`. Intercept `POST https://api.github.com/app/installations/42/access_tokens` with `{ token: "installation-fixture", expires_at: FUTURE_ISO_TIME }`, using a future fixture timestamp. Assert `Redacted.value(result) === "installation-fixture"` and exactly one mint request. The real `mint` and routing paths are in `github-apps.ts:532–581`.

- [x] Add a real `GitHubApps.token` regression after the stale-refresh/sign-out sequence. Assign an installed App to a bot, use an owner-matching GitHub target, and assert the next token request reaches the installation-token endpoint and returns the fixture installation token rather than the stale owner token.
- [x] Demonstrate the routing assertion failing against the original refresh behavior using the same regression before the Task 1 fix or a temporary reversible copy. Do not stage or leave mutation changes behind.
- [x] Assert no owner row is recreated and preserve machine-account/App selection rules without changing production routing.
- [x] Run `bun test apps/server/src/github-apps/github-app-users.test.ts apps/server/src/github-apps/github-apps.test.ts`. Expect success.
- [x] Checkpoint: inspect Task 2's test seam and assertions; no staging or commits.

### Task 3: Document and verify F03 remediation

**Files:** Documentation, changelog, overview, and specification listed in Files.
**Interfaces:** No new code interfaces.

- [x] Update the GitHub App section of `credentials.mdx`: local state is invalidated before revocation; stale refresh/completion cannot restore it. Preserve the statement that revocation is attempted and avoid promising a newer remote grant survives it.
- [x] Add an Unreleased entry and F03 remediation overview/evidence. Preserve original audit evidence and historical counts.
- [x] Run focused suites, then `CRUMBLE_VM_TESTS=0 CRUMBLE_RAILWAY_TESTS=0 bun run check`. Run long commands in the background; record failures, skips, and exact final results.
- [x] Run `bun run check` from `apps/docs` and `git diff --check` from the root. Expect success.
- [x] Obtain fresh-context `vet` via `@reviewer` against the specification and this plan's Deviations, not merely the checklist. Resolve findings and rerun affected checks.
- [x] Mark the spec implemented only after verification and review, with local-fixture and remote-revocation limitations intact.
- [x] Checkpoint: inspect final changed paths; do not stage or commit. Suggested approved commit: `fix(github): fence stale owner authorization writes`.

## Deviations

- Task 1, pending-state publication · planned: add only the epoch to pending state · did: also bind the captured owner incarnation, encoded as an empty string when signed out because `PendingStates.put` accepts string values · why: epoch-only completion can overwrite a newer same-user sign-in without an intervening sign-out. The added pre-fix regression demonstrated that failure.
- Task 2, regression order · planned: add routing coverage after Task 1 or temporarily restore original behavior · did: wrote and ran the routing regression before Task 1's production changes · why: this gave direct red/green evidence without temporary production mutations.

- Task 3, commit-hook verification · planned: no additional structural changes after review · did: extracted the shared cached-token snapshot and split the fixture token-response handler · why: the pre-commit audit rejected a clone group and fixture cognitive complexity. Focused tests still pass; the audit now passes with one non-blocking fixture complexity warning. Follow-up review found no issues and independently passed all 20 tests. After correcting an extraction-related spacing error, full root checks passed again with 1,100 passed, 118 skipped, and 0 failed.

No entries need a decision.
