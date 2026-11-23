# ADR 0017: Bot and job execution boundaries

## Status

Accepted

## Context

Bot conversations, durable executions, background jobs, and bot-to-bot messages can be replayed after a process restart. The runtime must keep user-visible turns idempotent, isolate private or untrusted data, and coordinate cancellation with work admission.

## Decisions

- A bot execution uses its durable request ID when submitting to Pi. If Pi commits a turn but the host loses the returned submission ID, recovery must not create a second user turn.
- Job reporter delivery admission and job stopping are coordinated through durable state. A delivery either does not submit, or completes submission before stop aborts the job; stop waits for in-flight submissions. Exclusive job kinds acquire their holder in the same state commit that admits delivery.
- Job conversations contain only the job's tools and job knowledge. They do not inherit the bot's unrelated tools, hooks, or prompt sections, preventing a job from escalating into delegations, schedules, memory writes, or integrations.
- Bot-to-bot delegation reserves the resolved recipient and message against the request ID before chat admission. Replays reuse that reservation; a rename cannot redirect an in-flight request, and a request ID cannot be reused for a different message or recipient.
- Only completed recipient turns and completed job reports are returned to the calling bot. Partial output and other recipient-chat turns remain private.
- Outside-call transcripts and event/script payloads are framed as model-only input, not written into the stored user message. Untrusted transcript text is serialized as data so it cannot terminate its frame or masquerade as instructions.
- Cancellation is recorded before stopping the runtime, so a cancelled execution is not first persisted as a failure. Job/report state is committed before triggering follow-up work, allowing restart recovery to recognize already-recorded work.
- The runtime's `pi.live` document is owned and serialized by Pi Durable; consumers read its value as `LiveState` rather than maintaining a parallel representation.

## Consequences

These boundaries are part of crash recovery, privacy, and permission enforcement. Changes to them require updating the idempotency/recovery tests and reviewing behavior across restart and concurrent stop/admission cases.
