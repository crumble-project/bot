# Web client decisions

## Status

Accepted

## Context

The web client comments inventory included implementation rationale that is consequential to security, reliability, or user-visible behavior. The code remains the executable source; this record preserves the decisions that should not be lost when comments are removed.

## Decisions

### Authentication and secret handling

- An invitation token is not a privilege grant. The server validates it during sign-up and determines the resulting role.
- Keep credentials and secret values out of query and mutation state. Send secret-bearing input in request bodies. A saved secret reference is not the secret value and must not be displayed as one; start its editable draft empty and avoid resending an unchanged reference.
- A desktop viewer URL is a short-lived, single-use credential because browser WebSocket connections cannot attach the owner's bearer token. Scope and consume it on the server. Each connection needs a fresh URL. Until explicitly asked, a viewer link only watches; it does not boot or keep a machine awake. Leaving the desktop view hands control back so the bot's job can continue.
- Sign-in return targets stay on this site and cannot redirect to another origin or back to sign-in. A one-use GitHub redirect code is exchanged through query-owned caching so React StrictMode does not consume it twice.
- GitHub App creation is a form post that navigates to GitHub; keep the return flow in the same tab because the installation page reads that tab's session storage.

### State, caching, and streams

- A cache can predate a newly arrived request. A request card that offers an answer reads a fresh server listing and treats the result as inconclusive until that read finishes.
- Query owns data caching; the router triggers loads rather than creating a second cache. On successful sign-out, reset the session and clear the query cache so account data cannot cross sessions.
- Serialize skill-assignment operations per bot to prevent races. Operations for different bots may run concurrently with a bound and preserve input-order results.
- Pin updates are optimistic, whole-list writes serialized one at a time. Do not write until the session's list has loaded: an incomplete list could erase pins. Reconcile from the session after writes, including rollback when a write fails; older servers may omit the list.
- Activity streams have no replay, so invalidate or reload relevant state after reconnect. Ignore status from replaced followers, and poll server-owned state while sign-in or event-source connections advance.
- A provider's append-only event log uses its event index as identity. Closing a provider sign-in view does not cancel the server-side sign-in; it can be continued. A held action cached as waiting may already have settled, so do not equate cached status with current status.
- A message remains optimistically visible until a server snapshot confirms it. Retry with the same request ID and files so the server can recognize the same message. A refusal means it did not succeed; other failures may be ambiguous, so retain the failed message for retry rather than assuming it never arrived. A sent message's uploads are immutable.

### Browser behavior and presentation

- The mobile sidebar sheet focuses its own container because its trigger opens it programmatically. Include safe-area insets for the bottom and left edges; on wide landscape phones, account for the side inset so the sidebar clears the notch.
- Apply the saved or system-selected theme in the inline script in `apps/web/index.html` before first paint. Catch unavailable local storage so theme initialization does not prevent rendering. The site also reads system color scheme during render through an external-store subscription because JavaScript-rendered libraries cannot be restyled by CSS media queries alone.
- Do not assume reduced-motion preferences, secure-context APIs, or browser storage are universally available. Preserve usable behavior when they are absent: reduced motion shows the completed transcript timeline, unsupported secure-context APIs remain unavailable, and unavailable or full storage loses only best-effort saved data.
- The owner's notification setting defaults to enabled, but notices require browser permission. Storage exhaustion or missing notification APIs must not terminate the event stream; reporting a failed notice must not end reply processing.
- Chat draft persistence is best effort and never blocks typed text. Allocate object URLs after commit so discarded renders cannot leak them.
- Render bare and angle-bracketed HTTP(S) links in Markdown. Trim punctuation and excess closing parentheses, and do not create links inside existing links. The server hosts the lazy Markdown diagram module at runtime, so keep its dynamic import out of bundler resolution.
- Keep recurrence display aligned with cron's Sunday-zero weekday numbering. Resolve local-zone offsets in two passes so daylight-saving transitions are accounted for. Long-lived relative-time labels refresh and catch up after the page resumes from sleep without reading time during render.
- Do not interpret zero usage cost from subscription providers as a real zero-cost report; it can mean the provider does not report cost. Usage grouping preserves incoming model-row order within each provider; provider order follows first occurrence.
- Use stable IDs where labels can collide in the command palette. Native checkboxes retain keyboard behavior and mixed-section selection.

### Test environment and completed tooling changes

- Adapt DOM tests to verified test-environment gaps rather than treating them as unresolved product debt. The avatar test checks disabled-fieldset ancestry because happy-dom's `:disabled` does not. The notification test records `reportError` calls because Bun's implementation terminates the process. The bulk-skills test observes the checkbox's `indeterminate` setter because a Profiler misses context-only commits with no other DOM effect.
- Source comments and directives have been removed. Machine-specific React diagnostics suppressions now live in external `doctor.config` ignore overrides. These file-and-rule scopes are necessarily broader than the former line-specific suppressions.
- The site TypeScript configuration now references Vite client types previously declared by a source comment.

## Consequences

These decisions affect authentication, secrets, account isolation, mutation ordering, desktop access, and user-visible behavior. Verify them against implementations and tests when those behaviors change. The diagnostics configuration and Vite type reference are completed maintenance changes, not pending work or semantic guarantees.
