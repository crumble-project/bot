# Password exposure refresh implementation plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** Prevent resumed desktop jobs from returning passwords filled by later jobs on the same bot desktop.
**Architecture:** Refresh the persisted exposure set before every computer-use dispatch and merge it into the instance's existing collections. Preserve the durable store, per-conversation instances, and Chromium-instance screenshot policy.
**Source:** [Reviewed specification](../designs/password-exposure-refresh.md), including the persistence-order coverage correction; [F01](../state-machine-correctness-review.md#finding-f01).

## Decisions

- Use a store read per call instead of a shared registry, avoiding invalidation and lifecycle coordination.
- Keep `restoreFilled(state)` as the entry point, but remove permanent promise memoization.
- Merge records without clearing collections, preserving historical password scrubbing.
- A failed refresh prevents dispatch; cached knowledge cannot authorize fallback.
- Preserve persistence before typing and screenshot recovery after Chromium restart.
- Keep tests at `createComputerUse().run()` with scripted guests and a shared fill store, the agreed behavior seam.
- No new dependencies, schema, API, settings, or retention policy.

## Constraints

- Follow `GLOSSARY.md` and the repository's `AGENTS.md` instructions.
- No real credentials, paid APIs, network services, or live desktops in tests.
- Read `apps/server/node_modules/effect/AGENTS.md` completely before writing Effect code. This change requires none.
- Preserve existing user-facing copy and interfaces. Do not change unrelated findings.
- Run checks from the repository root with live backend opt-ins disabled.
- No staging or commits without explicit approval.

## Out of scope

Shared registries, cache invalidation, concurrent screenshot/fill coordination, storage changes, password-matching changes, and claims about real password pixels or cross-bot access.

## Review focus

- Initialized A resumes after B fills: scrub text and withhold images.
- Chromium restarts: allow images but continue historical password scrubbing.
- A later refresh fails: return an error without desktop content or dispatch.
- Persistence is pending or rejected: do not type before successful completion.

## Files

- `apps/server/src/bot-desktop/computer-use-login.ts`: refresh and merge on every invocation.
- `apps/server/src/bot-desktop/computer-use-state.ts`: remove the obsolete restoration-promise field and initializer.
- `apps/server/src/bot-desktop/computer-use-login.test.ts`: resumed-instance, read-failure, and persistence-order coverage.
- `docs/state-machine-correctness-review.md`: append F01 remediation and observed verification evidence.
- `CHANGELOG.md`: record the password-safety fix.
- `apps/docs/content/concepts/logins.md`: clarify that password protection applies across jobs, including resumed jobs, and that unreadable safety records prevent desktop calls. The existing protection promise appears in “What the Bot Sees” (lines 41-47).

### Task 1: Refresh exposure records and lock down safety behavior

**Files:** Modify the files listed in Files.
**Interfaces:**
- Consumes `DesktopFills.list(): Promise<DesktopFill[]>` and `DesktopFills.add(fill: DesktopFill): Promise<void>` in `computer-use-login.ts`.
- Consumes `createComputerUse(shell, options).run(args, context)` in `computer-use.ts`.
- Preserves `restoreFilled(state: ComputerUseState): Promise<void>` for `computer-use-run.ts` and `desktop-screenshot.ts`.
- Produces no new public interface.

- [x] Add `a resumed job refreshes passwords filled by another job`. Initialize A with an empty store; fill `hunter2` through B's real read and `fill_login` path; reuse A for a vision capture showing `hunter2`. Assert `expect(text(result)).not.toContain("hunter2")`, `expect(text(result)).toContain("[login github password]")`, and no image. Assert B persisted a record; do not populate it directly.
- [x] Add `a resumed job scrubs later passwords after Chromium restarts`. Repeat the sequence with A's guest reporting a new process start before resumption. Assert the password label, no plaintext, and an image.
- [x] Add `a failed refresh refuses an initialized job`. After a successful initial call, reject the next `list()` with a synthetic store error. Assert `isError === true`, no captured desktop content or image, and an unchanged guest-command count across the failed call.
- [x] Add `password typing waits for persistence`. Defer `add()`, signal when it is entered, and assert no `browser_type` before releasing it. Resolve the write and assert exactly one typing command. Use explicit promise gates, not sleeps.
- [x] Add `a failed exposure write prevents typing`. Reject `add()` and assert an error result and zero `browser_type` commands.
- [x] Run `bun test apps/server/src/bot-desktop/computer-use-login.test.ts`. Record the stale-instance and later-read failures before changing production code. Persistence-order and rejected-write tests must already pass; they protect existing behavior.
- [x] Make `restoreFilled` read and merge records on every invocation. Remove the private wrapper if redundant, update its once-per-job comment, and remove `restored` from the state type and initializer. Do not clear `filled` or `browsers`.
- [x] Preserve refresh-before-dispatch in `computer-use-run.ts` and persistence-before-typing in `remember`; neither needs a new mechanism.
- [x] Run `bun test apps/server/src/bot-desktop/computer-use-login.test.ts apps/server/src/bot-desktop/desktop-screenshot.test.ts`. Expect all tests to pass, including existing rotation, deletion, restart, and unreadable-store cases.
- [x] Update “What the Bot Sees” in `apps/docs/content/concepts/logins.md` with the cross-job and failed-refresh behavior. Preserve the existing screenshot and historical-scrubbing policy.
- [x] Run `CRUMBLE_VM_TESTS=0 CRUMBLE_RAILWAY_TESTS=0 bun run check`. The root `package.json` defines the agents, lint, formatting, type, OpenAPI, and test checks. Expect all enabled checks to pass; report skips, failures, and unrelated baseline failures accurately.
- [x] Run `bun run check` from `apps/docs`, as required for user-documentation changes. Expect success.
- [x] Add a changelog entry and F01 remediation note with exact commands and observed results. Preserve historical audit findings and distinguish fixture image admission from real password pixels.
- [x] Review the diff against the specification and file list. Report verification limitations. Do not stage or commit.
