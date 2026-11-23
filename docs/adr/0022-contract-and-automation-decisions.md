# ADR 0022: Preserve client-generator contract shapes

## Status

Accepted

## Decision

Keep public response shapes as plain objects with optional or nullable fields where established, rather than replacing them with unions solely to express conditional presence. Keep `LearnedEvent` as its own `learned` SSE event instead of adding it to the existing closed event union. Count login answer limits in Unicode code points. Reject bare cron weekday steps (`1/2`) because the installed parser treats them like `1-7/2`, including Sunday.

## Context

The API response schemas explicitly model the memory source as a nullable union, provider fields as nullable, and login prompts as one object with optional fields. The learned-event schema is separately declared and the stream protocol uses event names. These are observable generated-client contract choices; seemingly equivalent schema rewrites can change generated types or make a closed union reject an event. Login answer validation uses `Array.from(value).length`, preserving the existing code-point limit without a lint suppression. The weekday-step equivalence was checked against the installed `cron-parser`: `1/2` and `1-7/2` yielded the same next occurrence in the verification probe.

## Consequences

Changes to these representations require checking generated clients and compatibility with existing consumers. Preserve the login code-point limit and the weekday-step rejection unless the validation semantics are intentionally changed. Runtime schema descriptions remain part of the API and are preserved; this decision does not justify comments that merely restate schema fields.
