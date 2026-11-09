# Password exposure refresh

**Status:** implemented

## Problem

A resumed desktop job can disclose a password filled by another job on the same bot desktop. Each job caches its computer-use instance, but that instance loads persisted password-exposure records only once.

After job A initializes, job B can fill a password and persist its exposure record. Resuming A reuses stale password and browser collections. A can return plaintext from a surface exposing that password and admit screenshots that the existing safety policy would withhold.

[F01 in the state-machine correctness review](../state-machine-correctness-review.md#finding-f01) reproduces synthetic plaintext disclosure. It does not establish disclosure from ordinary masked fields, actual password pixels, or cross-bot access. The glossary requires login passwords to stay out of the bot's model and transcript.

## Solution

Refresh persisted exposure records before every computer-use call dispatches. Merge those records into the instance's existing knowledge, so resumed jobs recognize passwords filled by other jobs.

If refreshing fails, refuse the call instead of using stale knowledge. Preserve the existing rules for recording passwords before typing and withholding screenshots while the recorded Chromium instance runs.

## Behavior

1. **A job resumes after another job fills a password.** Job A initializes against an empty exposure store. Job B fills a password through `fill_login`. When the same A instance resumes, its output replaces that password with the recorded label. Screenshots remain withheld while the recorded Chromium instance runs.
2. **Chromium restarts.** A resumed job still replaces historical password text. Screenshots become available under the existing browser-instance policy.
3. **Refreshing fails.** Even after earlier successful calls, a failed exposure-store read returns an error before dispatch. The failed call returns no captured desktop text or image and sends no guest command after the refresh failure.
4. **A password is filled.** Its exposure record must persist before typing. A failed write prevents typing, preserving existing behavior.
5. **Existing records or login definitions change.** Existing exposure records require no migration. Refreshes merge knowledge without clearing local collections. Login rotation or deletion does not remove historical password scrubbing.

These guarantees concern the serialized desktop-job sequence established in F01. They do not introduce synchronization between independently running screenshot and fill operations.

## Decisions

- Read the durable exposure store before every computer-use dispatch because exposure knowledge belongs to the bot desktop, not one job.
- Remove the permanent restoration-promise cache because a successful initial read says nothing about later fills.
- Retain `restoreFilled` as the internal entry point to avoid unnecessary caller changes; update its description to reflect refresh behavior.
- Merge records into existing collections because historical passwords must remain scrubbed after login changes or Chromium restart.
- Refuse dispatch on refresh failure because stale knowledge cannot establish output safety.
- Preserve persistence before typing because a password remains on the desktop even if the job ends immediately afterward.
- Preserve the existing Chromium-instance screenshot policy because F01 concerns stale knowledge, not a new screenshot policy.
- Accept a store read and decryption per call. Reject a shared in-memory registry for this fix because it adds invalidation and lifecycle coordination without demonstrated need.
- Preserve per-conversation computer instances because their other observation state is independent of exposure freshness.

## Interfaces and data

No public API, tool schema, database schema, migration, configuration, or settings changes are required.

`DesktopFills.list()` remains the source of persisted exposure records. `DesktopFills.add()` remains the write boundary before password typing. `restoreFilled(state)` continues to return a promise, but each invocation reads the store instead of returning a permanently cached result.

Exposure records remain scoped to one bot through the existing repository access layer. Existing encrypted records remain compatible. No new retention or deletion policy is introduced.

## Affected code

- `apps/server/src/bot-desktop/computer-use-login.ts`: refresh and merge exposure records on each invocation. Preserve password recording, text scrubbing, and browser-instance checks.
- `apps/server/src/bot-desktop/computer-use-state.ts`: remove the obsolete restoration-promise field and initializer.
- `apps/server/src/bot-desktop/computer-use-run.ts`: preserve the existing refresh-before-dispatch ordering and error path. No new dispatch mechanism is needed.
- `apps/server/src/bot-desktop/computer-use.ts`: preserve the per-conversation instance cache; regression tests exercise the `createComputerUse` boundary.
- `apps/server/src/bot-desktop/desktop-fill-repository.ts`: reuse the existing encrypted, per-bot durable store without changing it.
- `apps/server/src/bot-desktop/desktop-screenshot.ts`: preserve its existing fresh-state password check. This is prior art for reading current records before admitting a screenshot.
- `apps/server/src/bot-desktop/computer-use-login.test.ts`: add resumed-instance and refresh-failure regressions using the existing scripted guest and shared fill-store fixture.
- `docs/state-machine-correctness-review.md`: record F01 remediation and verification evidence without rewriting historical audit results.

## Testing

The agreed primary seam is `createComputerUse().run()` in `apps/server/src/bot-desktop/computer-use-login.test.ts`. Use two computer instances sharing the existing fill-store fixture, and fill the synthetic password through B's real `fill_login` path. Initialize A before B fills, then reuse A rather than creating a later reader.

This seam must prove text scrubbing and screenshot withholding after resumption, screenshot recovery with continued text scrubbing after Chromium restart, and refusal before dispatch when a later refresh fails. Run the regressions against the unfixed implementation to demonstrate their ability to detect F01.

Model these tests on the existing later-job, Chromium-restart, login-rotation, and unreadable-store tests. Retain their existing coverage.

Strengthen persistence-before-typing coverage at the same seam. Defer `DesktopFills.add()` and assert that no `browser_type` command occurs until persistence resolves. Separately reject the write and assert an error with no typing. The existing record-count test establishes neither ordering nor failed-write safety.

Run `apps/server/src/bot-desktop/desktop-screenshot.test.ts` to check the separate screenshot tool's existing behavior.

Tests use synthetic secrets and scripted guest responses, without real credentials, network services, or a live desktop. Fixture images prove image admission or withholding, not actual password pixels. The shared fixture proves behavior across the real computer-use boundary, not encrypted SQLite persistence itself; the unchanged repository provides that persistence boundary.

## Out of scope

- Other findings in the correctness review.
- Shared exposure registries, cache invalidation protocols, or performance-driven caching.
- New locking between independently running screenshot and fill operations.
- Changes to password matching, exposure retention, login storage, or browser-instance identification.
- Broader claims about masked fields, rendered password pixels, or cross-bot disclosure.

## Open questions

None.
