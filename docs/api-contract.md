# API contract maintenance

`bot` generates the HTTP and server-sent event (SSE) specifications from its Zod route and response schemas. Each Git commit identifies its generated artifacts. The OpenAPI `info.version` remains a required document field; it is not a release identifier and does not need a bump for each change.

## Exported artifacts

```bash
bun run openapi:generate
bun run openapi:check
bun run contract:validate
```

| Artifact | Source |
| --- | --- |
| `openapi/openapi.json` | Shared route registry (OpenAPI 3.1) |
| `openapi/chat-snapshot.schema.json` | `chatSnapshotResponse` |
| `openapi/group-chat-snapshot.schema.json` | `groupChatSnapshotResponse` |
| `openapi/activity-event.schema.json` | `activityEvent` (`reply` and `chat_preview` union) |
| `openapi/learned-event.schema.json` | `learnedEvent` |
| `openapi/desktop-control.schema.json` | `desktopControlResponse` |
| `openapi/heartbeat.schema.json` | `heartbeatEvent` |

## Change workflow

1. Update the Zod schema and route handler together, using stable operation IDs.
2. Stage the source changes and commit them. The pre-commit hook generates and stages the artifacts from the staged source.
3. Run `bun run check` and `bun run contract:validate`.
4. Compare against the base branch's `openapi` directory with `bun run contract:compatibility BASELINE_DIRECTORY`.

Replace `BASELINE_DIRECTORY` with the path to the base commit's `openapi` directory. Pull request CI checks out the exact base commit and runs this comparison automatically. It rejects breaking HTTP and event schema changes and saves the reports as a workflow artifact. Coordinate intentional breaking changes before merging them. A comparison with the base commit does not establish compatibility with every older deployed server or client.

The hook preserves unstaged edits to generated files. If you skip the hook, run `bun run openapi:generate` and stage the artifacts yourself.

The repository does not publish contract releases or bundles. To retrieve the specification for a server revision, use that revision's committed `openapi/` directory.

## Server-sent events

All `/v1` streams require a Better Auth account session (a session bearer token or browser session cookie) and send `event: heartbeat` (`data: {}`) every 15 seconds. Clients must ignore heartbeats and unknown event names and recover state via the corresponding snapshot endpoint on reconnect.

| Endpoint | Event | JSON Schema asset |
| --- | --- | --- |
| `/v1/agents/{id}/events` | `snapshot` | `chat-snapshot.schema.json` |
| `/v1/agents/{id}/events` | `heartbeat` | `heartbeat.schema.json` |
| `/v1/group-chats/{id}/events` | `snapshot` | `group-chat-snapshot.schema.json` |
| `/v1/group-chats/{id}/events` | `heartbeat` | `heartbeat.schema.json` |
| `/v1/agents/{id}/desktop/events` | `control` | `desktop-control.schema.json` |
| `/v1/agents/{id}/desktop/events` | `heartbeat` | `heartbeat.schema.json` |
| `/v1/events` | `activity` | `activity-event.schema.json` |
| `/v1/events` | `learned` | `learned-event.schema.json` |
| `/v1/events` | `heartbeat` | `heartbeat.schema.json` |
