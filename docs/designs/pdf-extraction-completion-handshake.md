# PDF extraction completion handshake

**Status:** draft

## Problem

Successful PDF uploads intermittently lose their extracted text because the extraction watchdog races with worker exit.

In `apps/server/src/files/pdf-text.ts`, `samplePdfRss` rejects zero resident set size (RSS) as unavailable. On macOS, `ps` can report zero when a worker exits before Bun updates `running.exitCode`. The watchdog then returns `PDF memory measurement unavailable`, despite the worker subsequently reporting exit code `0`.

`apps/server/src/files/library.ts` records extraction as failed and returns `null` instead of extracted text. This affects real uploads, not only tests.

The investigation reproduced failures in both `pdf-text.test.ts` and `library.test.ts` on macOS with Bun 1.4.4. Unmodified runs failed once in 20 sequential runs and three times in 50 parallel runs. These observations do not establish a 50% failure rate. Linux reproduction remains unverified.

## Solution

Keep the PDF worker alive after publishing its result until the parent acknowledges completion. The parent validates a complete result and settles memory monitoring before allowing the worker to exit.

A framed result replaces stdout EOF as the completion boundary. Existing extraction results, failure messages, resource limits, and library storage behavior remain unchanged.

## Behavior

1. **Successful text extraction.** The worker publishes its complete result and waits for acknowledgment. The parent validates the result, settles monitoring, and acknowledges it. The worker confirms receipt. Extraction returns text only after that confirmation, stdout EOF, and a clean worker exit.
2. **PDF without text.** A scan follows the same handshake and returns `{ kind: "none" }`.
3. **Completion during an RSS sample.** The worker remains alive while the parent waits for the in-flight sample. A valid sample within the limit permits acknowledgment. Successful completion cannot itself make that sample unavailable.
4. **Unavailable RSS.** Missing or invalid RSS before acknowledgment fails extraction with `PDF memory measurement unavailable`, even after earlier successful samples. No acknowledgment authorizes successful completion after that failure.
5. **Memory violation.** An over-limit sample fails extraction with `PDF memory limit exceeded`, including a sample already in flight when the result arrives. The worker is terminated.
6. **Timeout.** The existing extraction deadline covers startup, input delivery, extraction, result validation, monitoring settlement, acknowledgment, and worker exit. A stalled handshake returns `PDF extraction timed out` and terminates the worker.
7. **Invalid or excessive output.** Malformed or incomplete frames, invalid result schemas, multiple results, and unexpected trailing output cannot produce success. Existing output bounds remain enforced. Malformed JSON retains `PDF extraction failed`; valid JSON with an invalid result schema retains `Invalid PDF extraction output`. Incomplete framing, duplicate results, and trailing output use `Invalid PDF extraction output`. Exceeding the parent output bound uses `PDF output limit exceeded`.
8. **Worker failure or lost connection.** A failed acknowledgment, missing receipt confirmation, or nonzero final exit cannot produce success. A worker that publishes a valid result and exits without receiving acknowledgment must fail, even with exit code `0`. The parent fails extraction and cleans up without hanging. An earlier watchdog failure retains precedence over subsequent exit or protocol errors. Otherwise, worker errors return `PDF extraction failed`. Every worker error path stops acknowledgment waiting, closes IPC, and exits nonzero without waiting for the extraction deadline.
9. **Parent failure.** A worker waiting for acknowledgment terminates when the parent control channel disconnects. It cannot remain orphaned waiting for a message.
10. **Library behavior.** Successful PDF uploads retain readable text across duplicate uploads in the same library and uploads in another library. This change introduces no automatic or background retry or record repair. Explicit PDF re-uploads still perform extraction before deduplication. They can update shared extracted-text files without changing an existing library row.

## Decisions

- Use a completion handshake because process exit and Bun's observable exit state are not synchronized with RSS sampling.
- Keep the worker alive through result validation and settlement of the in-flight RSS sample, so successful exit cannot invalidate monitoring.
- Stop scheduling new RSS samples once the complete result is validated. Settle any existing sample before acknowledgment, so its failure cannot be discarded.
- Treat acknowledgment as the boundary after which RSS monitoring is no longer required. PDF processing is complete; the worker must only confirm receipt, disconnect, and exit.
- Keep the deadline active until receipt confirmation, stdout EOF, and worker exit settle, so acknowledgment does not create an unbounded cleanup phase.
- Keep result bytes on stdout and use Bun's subprocess IPC channel only for acknowledgment and receipt confirmation. This preserves bounded streaming output without sending PDF text through another serialization channel.
- Require explicit receipt confirmation because `Subprocess.send` returns no delivery acknowledgment. Sending a message and observing exit code `0` cannot prove the worker received it.
- Tear down IPC on every worker error path because setting `process.exitCode` alone might leave the acknowledgment listener keeping the process alive.
- Use one newline-terminated JSON result on stdout. JSON escapes embedded newlines, so the delimiter identifies completion without depending on EOF.
- Require receipt confirmation, a clean final exit, and exactly one result. A valid frame alone does not override premature exit, a crash, extra output, or an earlier watchdog failure.
- Preserve the first terminal failure. Later shutdown errors must not replace the cause that initiated termination.
- Preserve fail-closed RSS handling. Ignoring unavailable RSS after one successful sample would weaken memory enforcement.
- Reject sleeps, retries, and exit grace periods as the fix because they substitute another timing assumption for a completion protocol.
- Preserve the separate Bun process and existing dependencies. The existing watchdog is best-effort monitoring, not an operating-system hard memory cap.

## Interfaces and data

### Internal worker protocol

Input remains raw PDF bytes on stdin, terminated by EOF. Stdin cannot carry acknowledgment because the worker consumes it through EOF before extraction.

Output becomes exactly one UTF-8 JSON result followed by a newline. The accepted result shapes remain `{ kind: "text", text: string }` and `{ kind: "none" }`.

The parent reads the frame incrementally instead of waiting for stdout EOF. Existing parent and worker output limits remain in force; framing does not justify increasing them.

A separate Bun IPC control channel carries a fixed acknowledgment message, `{ kind: "ack" }`. The worker accepts it only after publishing its result. It remains alive with its acknowledgment handler installed until that message arrives or the channel disconnects. Unknown messages cannot authorize exit as a successful extraction.

After receiving acknowledgment, the worker sends `{ kind: "ack-received" }` before disconnecting and exiting. The parent accepts this confirmation only after sending acknowledgment. Confirmation received before acknowledgment is a protocol failure, not evidence of successful completion.

The parent must not acknowledge until result validation and any in-flight RSS sample succeed. Failure stops monitoring, terminates the child, and settles subprocess resources. After acknowledgment, the parent still drains stdout, enforces its byte limit, rejects extra output, and waits for receipt confirmation and exit under the original deadline.

The parent must not infer receipt from `Subprocess.send` returning, `exitCode`, or callback ordering. Exit notification may precede delivery of a queued confirmation. Success requires the actual confirmation, complete stdout validation, and exit code `0`. If IPC closes without confirmation, extraction fails with `PDF extraction failed`.

On parsing errors, worker text-limit violations, and other worker errors, the worker cancels acknowledgment waiting, closes IPC, and terminates nonzero. It must not rely on `process.exitCode = 1` alone. Cleanup must preserve any intended output without waiting for an acknowledgment that cannot arrive.

Bun 1.4.4's installed `bun-types` declares subprocess `ipc`, `send`, and `onDisconnect`, plus child `process.send` and `process.on("message")`. Runtime verification must establish that queued receipt confirmation reaches the parent before final IPC closure, regardless of exit notification ordering. This is a protocol-verification gate on macOS and Linux, not an assumed API guarantee. If reliable delivery cannot be established, the protocol needs revision before implementation can be accepted.

### Compatibility

`extractPdfText` retains its caller-facing arguments and result union. `samplePdfRss` retains its handling of zero, missing, and invalid RSS. Library upload limits remain 10 seconds and 256 MiB. Existing caller-supplied test limits remain unchanged.

No HTTP contracts, database schemas, stored text formats, settings, or dependencies change. Parent and worker ship together, so the internal protocol needs no legacy compatibility path.

## Affected code

- `apps/server/src/files/pdf-text.ts`: framed output parsing, acknowledgment, receipt validation, monitoring coordination, and deadline-bounded cleanup. Reuse its existing schema validation, bounded stdout reader, RSS sampler, and first-failure handling.
- `apps/server/src/files/pdf-worker.ts`: publish a framed result, remain alive pending acknowledgment, confirm receipt, and terminate on parent disconnection. Tear down acknowledgment waiting on every error path. Retain its existing extraction loop and text output bound.
- `apps/server/src/files/pdf-text.test.ts`: deterministic regression coverage at the real subprocess boundary and coverage of protocol and resource failures. Model fixtures and extraction assertions on its existing tests.
- `apps/server/src/files/library.test.ts`: retain the existing end-to-end upload assertions as integration coverage. Production library logic does not need to change.
- `apps/server/test/fixtures/`: existing `text.pdf`, `scan.pdf`, and `pathological.pdf` remain the extraction inputs. Any new protocol-failure worker fixture belongs here and must be marked as a test fixture.
- `docs/designs/file-library.md`: update its extraction implementation note when the handshake ships, without rewriting historical decisions.
- `CHANGELOG.md`: record the PDF extraction reliability fix when implementation ships.

Prior art: `docs/designs/file-library.md` records extraction at upload and the separate-process watchdog limitation. `apps/server/src/bots/crash-recovery.test.ts` demonstrates real subprocess fixtures and lifecycle assertions. No existing server subprocess acknowledgment protocol was found; this protocol remains local to PDF extraction.

## Testing

The agreed seams are PDF extraction through the real worker and library uploads through the existing `Library` service tests.

### Extraction boundary

Use `apps/server/src/files/pdf-text.test.ts` for:

- Successful text extraction and scans through the real worker and handshake.
- Deterministic completion while an RSS sample is in flight. Synchronization must establish that the worker remains alive until sampling settles and acknowledgment occurs. Random delays and repeated passes alone are not regression coverage.
- A valid framed result reaching the parent before stdout EOF. This detects a parent that still waits for exit before acknowledgment.
- Missing RSS from a live worker after an earlier valid sample, which must still fail closed.
- An over-limit in-flight sample during completion, which must fail rather than be discarded.
- Existing real timeout and memory-limit scenarios, plus a stalled acknowledgment, receipt confirmation, or exit remaining bounded by the original deadline.
- Invalid, incomplete, duplicate, trailing, and excessive output never producing success. Malformed JSON and invalid result schemas retain their distinct existing failure messages.
- A fixture worker publishing a valid frame and exiting cleanly without receiving acknowledgment. It must fail regardless of when the parent observes exit or attempts to send acknowledgment.
- Actual receipt confirmation arriving before IPC closure, including when exit notification arrives first. The real worker must complete reliably without relying on callback ordering.
- Malformed PDF input and the worker text-limit violation exiting nonzero after IPC teardown, rather than turning into timeouts. Both return `PDF extraction failed` unless an earlier watchdog failure already won.
- Unexpected worker exit and parent disconnection settling resources without leaked subprocesses.

Use the smallest explicit test seam needed to coordinate sampling and completion. It must preserve the real subprocess, result parser, and watchdog coordination. Avoid process-wide mocks that leak between parallel test files. Fixture workers may exercise malformed protocol behavior but cannot replace the real worker in the completion regression.

The regression must demonstrate failure against the original implementation and success with the handshake. Tests use local fixtures without keys, paid APIs, or network access.

### Library boundary

Keep the existing `different MIME uploads preserve extracted text` cases in `apps/server/src/files/library.test.ts`. They upload a PDF, then upload the same bytes as `text/plain` in the same library or another library. They verify shared-text preservation, not a second PDF extraction.

### Verification

Repeat both files with the repository's `bun test --parallel` mode after implementation. Record run counts and failures; passing stress runs supplement deterministic regression coverage rather than replace it.

Run applicable repository formatting, lint, type checks, and existing tests. Verify the protocol on macOS and Linux, or explicitly report any unverified platform. CI unit-test jobs must remain within the project's two-minute budget.

## Out of scope

- Replacing the RSS watchdog with a hard operating-system memory cap.
- Changing PDF parsing, extraction limits, user-facing messages, or library deduplication.
- Introducing automatic or background extraction retries or repair of previously failed library records. Existing extraction on explicit re-upload remains unchanged.
- A general subprocess framework, public test configuration, or new dependency.
- UI, HTTP API, database, or mobile-client changes.

## Open questions

None. Reliable receipt delivery and worker teardown are explicit protocol-verification gates. Failure to verify either requires revisiting the protocol, not weakening the acceptance criteria.
