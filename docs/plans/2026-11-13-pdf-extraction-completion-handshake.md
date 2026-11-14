# PDF extraction completion handshake implementation plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** Prevent successful PDF extraction from failing when RSS sampling overlaps worker exit, without weakening resource enforcement.
**Architecture:** Retain the separate Bun worker and bounded stdout transport. Add newline framing, IPC acknowledgment, and receipt confirmation; settle monitoring before authorizing worker exit. Keep lifecycle coordination internal to PDF extraction.
**Source:** [PDF extraction completion handshake](../designs/pdf-extraction-completion-handshake.md).

## Decisions

- The worker stays alive through result validation and settlement of the in-flight RSS sample, removing the successful-exit race.
- Results remain on stdout as one newline-terminated JSON frame; IPC carries `{ kind: "ack" }` and `{ kind: "ack-received" }` only.
- Success requires receipt confirmation, exactly one valid result, stdout EOF, and exit code `0`. Sending acknowledgment alone proves nothing.
- Stop scheduling RSS samples after validating the frame. Settle an existing sample before acknowledgment; unavailable or over-limit RSS still fails closed.
- Preserve the first terminal failure. Worker errors return `PDF extraction failed` unless an earlier watchdog failure already won.
- Preserve malformed-JSON `PDF extraction failed` and invalid-schema `Invalid PDF extraction output`. New framing violations use the latter.
- The original deadline covers the entire lifecycle, including confirmation, output draining, and exit.
- Every worker error closes IPC and exits nonzero; parent disconnection also releases a waiting worker.
- Keep existing explicit re-upload extraction and deduplication behavior. Introduce no background retries or record repair.
- Existing library tests cover PDF followed by the same bytes as `text/plain`, not two PDF extractions. Retain those tests as shared-text preservation coverage.
- Use a narrow internal coordinator seam for deterministic tests, not public test options or process-wide mocks.
- Reliable receipt delivery and error teardown on macOS and Linux are acceptance gates. Do not replace them with sleeps or weaken the protocol if a gate fails.

## Constraints

- “Never commit, push, tag, switch branches, stash, reset, publish, open PRs, or interact publicly without explicit permission. Stage only requested paths.”
- “No `any`, inline imports, or compatibility shims for outdated dependencies.”
- “CI unit-test jobs that run on push or pull requests must finish in at most two minutes; check a job's duration after changing it.”
- No new dependencies. Preserve caller-facing extraction arguments and results, existing limits, and user-facing copy.
- Bug-fix regression coverage must fail before the fix and pass afterward. Default tests use local fixtures without keys, paid APIs, or network calls.
- Existing signatures: `samplePdfRss(pid: number, signal?: AbortSignal): Promise<number | null>` at `apps/server/src/files/pdf-text.ts:16`; `extractPdfText(bytes: Uint8Array, limits: { ms: number; memoryMib: number }): Promise<Result>` at `apps/server/src/files/pdf-text.ts:61`. Its result union is at lines 9-12, parent output cap at line 14, and first-failure handler at lines 79-83.
- Repository checks: `bun run check` runs agent-path checks, lint, formatting, server/web type checks, OpenAPI validation, and parallel tests (`package.json:34`). Markdown outside `apps/` needs a separate `bun fmt --check` invocation (`package.json:28`).

## Out of scope

Hard OS memory caps, parser changes, limit increases, automatic retries, record repair, library production changes, public test configuration, migrations, UI changes, and a general subprocess framework.

## Review focus

1. A valid frame followed by clean exit without acknowledgment must fail, even when exit notification lags.
2. An in-flight unavailable or over-limit RSS sample must win over an otherwise valid result.
3. Exit notification before confirmation delivery must not prematurely fail a successful handshake; IPC closure without confirmation must fail.
4. Malformed input and worker text-limit violations must release IPC without becoming timeouts, subject to first-failure precedence.
5. Parent disconnection and stalled completion must leave no child process or sampler running indefinitely.

## Files

- Modify `apps/server/src/files/pdf-text.ts`: preserve the public facade and RSS sampler; delegate lifecycle coordination.
- Create `apps/server/src/files/pdf-extraction.ts`: PDF-specific internal subprocess coordinator and injectable test seam.
- Modify `apps/server/src/files/pdf-worker.ts`: framed result, acknowledgment wait, receipt confirmation, and error teardown.
- Modify `apps/server/src/files/pdf-text.test.ts`: deterministic real-worker regression and protocol/resource tests.
- Create `apps/server/test/fixtures/pdf-protocol-worker.ts`: local worker fixture for malformed output and lifecycle failures.
- Create `apps/server/test/fixtures/pdf-parent.ts`: subprocess fixture for testing parent disconnection from the real worker.
- Retain `apps/server/src/files/library.test.ts`: existing PDF/text MIME integration assertions; change only if an explicit regression requires it.
- Updated `docs/designs/pdf-extraction-completion-handshake.md` during planning: clarified reviewed diagnostic precedence and precise library coverage. Implementation consumes those decisions without further spec edits.
- Modify `docs/designs/file-library.md`: describe the implemented handshake in its extraction implementation note.
- Modify `CHANGELOG.md`: record the reliability fix using existing conventions.
  Fixture convention: executable local TypeScript fixtures under `apps/server/test/fixtures/` report newline-delimited JSON metadata to stdout (`apps/server/test/fixtures/crash-server.ts:52`). The changelog uses prose bullets under `## Unreleased` (`CHANGELOG.md:3`).

### Task 1: Establish the deterministic regression seam

**Files:** modify `pdf-text.ts` and `pdf-text.test.ts`; create `pdf-extraction.ts`, all under `apps/server/src/files/`.
**Interfaces:**

- Preserve `samplePdfRss(pid: number, signal?: AbortSignal): Promise<number | null>` and `extractPdfText(bytes: Uint8Array, limits: { ms: number; memoryMib: number }): Promise<PdfResult>`.
- New internal `PdfResult` is the current `text | none | failed` result union; `PdfLimits` is `{ ms: number; memoryMib: number }`.
- New internal `runPdfExtraction(bytes: Uint8Array, limits: PdfLimits, runtime: PdfRuntime): Promise<PdfResult>` owns subprocess coordination.
- `PdfRuntime` contains `workerCommand: readonly string[]`, `sampleRss: (pid: number, signal?: AbortSignal) => Promise<number | null>`, optional `beforeInput: (signal: AbortSignal) => Promise<void>`, and optional `onResultFrame: () => void`. The input barrier establishes a sampling overlap in tests; the observer reports a validated result. Neither changes production policy.
- The facade supplies the existing worker command and sampler. Tests use the internal entry point without altering public options.

- [x] Move existing coordination into the internal entry point without changing extraction behavior. Await `beforeInput` between the first successful sample and input delivery. In the legacy reader, notify `onResultFrame` after EOF yields a valid result, before joining the watcher. Task 2 moves that notification to frame validation before EOF.
- [x] Add `completion waits for an in-flight RSS sample`: take a real initial sample, block a later sample behind a deferred barrier, and use `beforeInput` to withhold PDF input until that later sample has started. Feed the real worker, then await the result observer. Assert `expect(await samplePdfRss(workerPid)).toBeGreaterThan(0)` before releasing the sample, and finally `expect(result.kind).toBe("text")`. Always release barriers in cleanup and make injected waits abort-aware. The old worker exits before the observer can report its EOF-delimited result, so the liveness assertion fails deterministically; do not claim it deterministically reproduces the stale-exit-code error message.
- [x] Run `bun test apps/server/src/files/pdf-text.test.ts -t 'completion waits for an in-flight RSS sample'`. Record the failing liveness assertion before changing the worker protocol. The same assertion and sampling overlap must pass after Task 2 without changing the test's success criteria.
- [x] Run `bun test apps/server/src/files/pdf-text.test.ts apps/server/src/files/library.test.ts`. Retain existing assertions and distinguish known intermittent failures from the expected new regression.

### Task 2: Implement and verify the complete protocol

**Files:** modify `pdf-extraction.ts`, `pdf-worker.ts`, and `pdf-text.test.ts`; create `pdf-protocol-worker.ts` and `pdf-parent.ts` under `apps/server/test/fixtures/`.
**Interfaces:**

- Consume Task 1's `runPdfExtraction`, `PdfRuntime`, `PdfLimits`, and `PdfResult` without signature changes.
- Worker stdin: raw PDF bytes through EOF. Worker stdout: exactly one newline-terminated existing JSON result, with the current byte bounds.
- IPC: parent sends `{ kind: "ack" }` after monitoring settles; worker replies `{ kind: "ack-received" }` only after receiving acknowledgment.
- The protocol fixture takes a scenario name in `process.argv`; tests pass it through `workerCommand`. Scenarios cover invalid JSON, invalid schema, missing delimiter, duplicate/trailing/excess output, clean exit without acknowledgment, missing receipt, and stalled exit.
- The parent fixture runs the actual worker through the internal coordinator and reports its worker PID to the test before waiting. Test termination applies only to that fixture process and its child.

- [x] Add newline framing and incremental schema validation without waiting for stdout EOF. Enforce byte limits throughout draining, including after acknowledgment.
- [x] Keep the worker alive waiting for acknowledgment; install handlers before publishing the frame. Confirm receipt, then disconnect and exit. Explicitly tear down IPC on every error and parent-disconnection path.
- [x] Stop new sampling after frame validation and await the existing sample before sending acknowledgment. Preserve measurement failures, memory violations, and first-failure precedence.
- [x] Track confirmation, IPC closure, stdout EOF, and child exit independently. Exit notification alone must neither prove receipt nor reject a confirmation still eligible for delivery. Retain the deadline until all success conditions settle.
- [x] Add assertions for each Review focus item, real text and scan results, malformed-JSON versus invalid-schema reasons, original timeout and memory cases, and every protocol fixture scenario.
- [x] Exercise malformed PDF input and the real worker text-limit failure. Use local bounded fixtures or a temporary local fixture generator; do not change production extraction limits. Assert nonzero teardown rather than timeout, allowing an earlier watchdog failure to retain precedence.
- [x] Run the deterministic completion test with successful, unavailable, and over-limit deferred samples. Use `{ ms: 5000, memoryMib: 512 }`; return a real positive RSS, `null`, or `513 * 1024 * 1024` bytes, respectively. Assert `kind === "text"`, `{ kind: "failed", reason: "PDF memory measurement unavailable" }`, or `{ kind: "failed", reason: "PDF memory limit exceeded" }`. Confirm the successful worker remains alive until the sample settles.
- [x] Verify real-worker confirmation delivery before final IPC closure on macOS and Linux, including exit-notification ordering. Verify parent termination releases a waiting real worker. If either platform is unavailable, report the gate as unverified; do not declare platform acceptance.
- [x] Run `bun test apps/server/src/files/pdf-text.test.ts apps/server/src/files/library.test.ts`. Expected: all tests pass without skips or suppressed resource assertions. Protocol-delivery failure blocks acceptance and requires a recorded design decision, not a grace period.

### Task 3: Document and validate the fix

**Files:** modify `docs/designs/file-library.md` and `CHANGELOG.md`; update this plan's checkboxes and Deviations.
**Interfaces:** no new runtime interfaces; consume the accepted Task 2 protocol.

- [x] Update the extraction implementation note and changelog. Preserve the best-effort RSS watchdog limitation and historical decisions.
- [x] Repeat both test files in 100 fresh `bun test --parallel` invocations. Use a temporary script for the loop, retain failure logs, and report failed invocations and individual failed tests. Expected: zero failures; these runs supplement the deterministic test.
- [x] Run `bun run check` and `bun fmt --check docs/designs/pdf-extraction-completion-handshake.md docs/designs/file-library.md docs/plans/2026-11-13-pdf-extraction-completion-handshake.md CHANGELOG.md`. Expected: all checks pass. Record actual results, failures, skipped checks, and macOS/Linux verification separately. Keep the stress loop out of default CI.
- [x] Confirm no debug instrumentation, process-wide mocks, orphan fixtures, or leaked worker processes remain. Confirm the production library, public API, data formats, dependencies, and limits are unchanged.
- [x] Request fresh-context `vet` review against the spec and this plan's Deviations. No staging or commits without explicit permission.

## Verification results

- macOS: final `bun run check` passed, including lint, formatting, type checks, OpenAPI validation, and tests. Tests: 1,285 passed, 118 skipped, 0 failed; test execution took 17.13 seconds. Skipped integration scenarios remain unverified.
- Markdown formatting passed after formatting the plan and the existing file-library design document.
- Linux aarch64, Bun 1.4.4: all 25 PDF/library tests passed in parallel with networking disabled. Image `crumble-pdf-linux-verify:local` installs Linux-native dependencies from the existing frozen lockfile; only manifests and the lockfile entered the dependency build context. Source, tests, migrations, and workspace-image files are mounted read-only. The real Linux `microsandbox` binding loads without mocks; host dependencies and lockfiles are unchanged. This supersedes the earlier macOS-native-binding setup failure.
- Fresh-context reviews: no meaningful defects, spec drift, or structural issues found. Follow-up review of the ordering seam confirmed both previously open verification gaps are closed; the reviewer inspected code and reported evidence without independently repeating platform runs.
- Original stress runs: 100 fresh parallel invocations passed before adding the ordering seam, with 24 tests per invocation and zero failed invocations or tests. Duration: 9 minutes 46 seconds. Logs: `/tmp/pdf-handshake-stress.fGR5oa`. These runs do not include the latest test-seam change.
- Forced ordering: `accepts receipt delivered after worker exit` passed 100 repetitions on macOS and 100 on Linux. The test uses the real worker, delays receipt delivery until its real exit promise resolves, and preserves terminal IPC closure ordering. It asserts events exactly equal `["exit:0", "receipt", "disconnect"]` and checks extracted text. Logs: `/tmp/pdf-ordering-macos-repeat.log` and `/tmp/pdf-ordering-linux-repeat.log`.
- Ordering-test sensitivity: a temporary mutation rejecting missing receipt immediately on exit caused the new test to fail (`kind: "failed"` instead of `"text"`). A diff confirmed that mutation; restoring the independent exit/receipt wait made it pass. No mutation remains.
- Cleanup: no PDF worker or fixture processes remained after stress testing, and no debug markers were found. Production library logic, public API, data formats, dependency manifests, and resource limits are unchanged.
- Receipt-loss cleanup regression: a worker that disconnected after a valid frame without confirming receipt and remained alive returned `PDF extraction timed out` before correction. It now returns `PDF extraction failed`; ten repetitions of all rejection tests passed (110 tests). Full repository checks and all 21 Linux extraction tests passed again after both disconnection corrections. Follow-up review found no meaningful issues.

## Deviations

- Task 2, commit-hook complexity check · planned: inline frame parsing inside the stdout reader · did: extracted the same incremental frame parsing into a private `appendPdfFrame` helper · why: the pre-commit Fallow audit rejected the reader's cognitive complexity. Parsing, failure messages, output bounds, and lifecycle coordination remain unchanged; no hook was bypassed. Full repository checks passed again (1,285 passed, 118 skipped), and Fallow allowed the change with a nonblocking complexity warning. A post-extraction Linux rerun timed out while Docker became unresponsive, including to `docker info`; the successful 25-test Linux run predates this behavior-preserving extraction.

- Task 2, receipt-loss cleanup · planned: reject closed IPC without receipt · did: strengthened missing-receipt coverage and added a disconnect-before-result fixture. Both stay alive after disconnection. The coordinator terminates the worker, stops monitoring, and drains buffered stdout to preserve incomplete-frame diagnostics before reporting a pre-frame disconnect · why: both orderings previously waited until timeout. Each regression failed before its correction and passed afterward. A local input-delivery closure keeps coordinator complexity within the existing lint limit.

- Task 2, protocol-verification gate · planned: verify receipt delivery on macOS and Linux, including exit notification arriving first · did: after initial verification remained blocked, added the user-authorized internal `PdfRuntime.spawnWorker` seam. It accepts the existing command/options and returns a real Bun subprocess. The test wrapper delays receipt delivery until real exit and delays terminal IPC closure until receipt delivery settles; production defaults to `Bun.spawn` unchanged · why: this establishes the required order without replacing the worker or depending on natural callback timing. Both platform gates now pass.
- Task 2, worker-error coverage · planned: local bounded fixtures or generator with real RSS · did: generated a bounded repeated-page PDF, verified text on one page, checked direct worker nonzero exit and IPC closure for malformed and oversized input, and used a deterministic positive sampler for exact failure diagnosis alongside real-RSS assertions that allow earlier unavailable measurements · why: a worker-error exit can race with RSS measurement, whose earlier failure must retain precedence.
- Task 2, Review focus coverage · planned: cover all ordering and teardown assertions · did: covered ten protocol fixture modes, real parent termination, and forced exit-before-receipt delivery on macOS and Linux · why: the later user-approved testing follow-up closed the previously open ordering step.
