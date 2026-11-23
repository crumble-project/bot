# Desktop and voice gateway decisions

- Status: Accepted

## Desktop viewer and protocol filter

Viewer assets are restricted to noVNC's `core/` and `vendor/` paths. Viewer credentials are single-use, expire after one minute, and may be account-scoped; redemption removes the ticket before the WebSocket upgrade. These properties bound the unauthenticated viewer surface while accommodating WebSocket clients that cannot attach the owner's bearer token. See [ADR 0006: Credential proxy](0006-credential-proxy.md) for the broader credential boundary.

The RFB client-to-server filter passes the fixed 14-byte RFB 3.8 security-None handshake and frames supported messages using their protocol lengths. Signed extended clipboard lengths are interpreted by absolute magnitude. Input-bearing messages pass only while the owner holds control; unknown message types fail closed because their frame length cannot safely be determined. The bridge closes the stream on protocol errors.

Outside-call numbers are normalized and validated both when requested and again when approved. Owner numbers and listed premium, service, and satellite prefixes are refused. The owner approves the exact digits, so these checks prevent mistakes and costly abuse rather than replace approval. Keep the prefix policy aligned with the voice gateway's own checks.

Call request and tool-call identifiers act as idempotency keys to prevent duplicate dialing. Approval atomically claims a pending request, establishes the call conversation, and sends the call; a refusal returns it to pending. Outside-call transcripts stay in their separate conversation and are withheld if the callee objected. See [ADR 0006: Credential proxy](0006-credential-proxy.md) for gateway credential boundaries.

Desktop login filling uses refs only from the latest page read. Passwords are registered for output scrubbing before typing and restored from durable state when a job restarts; usernames and one-time codes are not treated as secrets in model output.

App launching runs outside the panel's launcher windows, optionally passing an absolute target path, and detaches the app process from the command session. Window discovery reports the resulting target window when available.

Voice-call state transitions are serialized under one semaphore; state is persisted before queued notifications are announced outside the lock. Call IDs for ended and outside calls are retained in bounded sets/maps to reject stale reports, while active or pending IDs are not evicted. Restarted calls require gateway reconfirmation, and calls expire when the gateway is unavailable, fails to reconfirm, or the maximum lifetime elapses. Only an outside call's pending start report can activate it; it remains distinct from a call with the owner.

Desktop actions declare whether they observe, act, or are unchecked. Observation survives a control handover; acting calls require a fresh control state and intent review; unchecked calls are still stale after handover, with compound steps reviewed together. Background input is attempted first and foreground delivery is used only when the driver requests it.

Application discovery can return one entry per running process, so the owner-facing list merges entries by application name and retains a running flag if any process runs. Accessibility role parsing keeps complete multiword roles up to the name's quote or the first attribute bracket. Desktop sessions use the stable `crumble-desktop` identity: Chromium's page-tool attachment belongs to that driver session, so independently named sessions cannot attach simultaneously.

Pending placed calls have separate acknowledgement and settlement budgets: 15 seconds to acknowledge and 210 seconds to report settlement. The latter includes ringing and final reporting, rather than equating the ringing window with the full report deadline.

## Tool inputs, control, and replay

The computer-use schema is adapted from Hermes Agent; its attribution and MIT license are retained in `THIRD_PARTY_NOTICES.md`. Crumble defaults to accessibility-tree captures and diffs rather than screenshots, escalates background input to foreground delivery when necessary, and waits for owner approval only when an intent check holds an action.

The action name remains a string rather than a closed enum, because a model can supply an unsupported action. Normalize empty optional placeholders from model output, including zero coordinates and element `[0]`: element zero denotes the window frame, not a useful target. Preserve empty text or values only for actions where an empty value is meaningful.

Do not replay computer input after a crash: already delivered input cannot be undone. The job must capture state before deciding what to do next. Control waits resolve only when the bot holds control and honor cancellation. Held-action waits first subscribe, then read persisted state, preventing a decision between those steps from being lost. Existing decisions return immediately; cancellation expires a held action, and startup expires pending waits because no waiting tool call survives the process.

## Intent boundary and judge selection

Judge input contains the proposed action, the owner's messages, and assigned tasks, not arbitrary page text that could argue for its own action. Login details identify a field, never its secret value. Commit-control names cover several languages; Enter remains a possible commit point because focus may be in a form field. A terminal judge can decide Enter only when it sees the command; elsewhere the selected classifier must explicitly be trusted to decide it. Chat fallbacks do not decide Enter.

Unevaluated classifiers require high in-intent confidence. Chat judges produce binary answers, so a midpoint threshold reads that answer without pretending it is a calibrated probability. Keep fallback order explicit. Catalog price overrides use dollars per million tokens and apply only when the catalog supplies no usable price.

Historical source notes motivated classifier-specific Enter handling and thresholds. A 38-case Jev evaluation dated 2026-10-30 recorded requested actions at or above 55% in-intent and unrelated actions at or below 42%; a typed repository deletion and a session-data URL escaped that sample's check, so Enter stayed guarded for that classifier. A 61-case GPT-6 Luna evaluation dated 2026-11-04 recorded risky URLs and submits at or above 77% irreversible, motivating that classifier's Enter handling. These are the original decision notes, not independently rerun results or guarantees for current model versions. Re-evaluate rather than treating those historical samples as ongoing validation.
