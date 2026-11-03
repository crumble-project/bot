# API contract maintenance

`bot` generates the HTTP and server-sent event (SSE) specifications from its Zod route and response schemas. Each Git commit identifies its generated artifacts. The OpenAPI `info.version` remains a required document field; it is not a release identifier and does not need a bump for each change, only a higher major version for a breaking change.

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
3. Push. The pre-push hook runs `bun run check` and `bun run contract:validate`, then compares against `origin/main`'s `openapi` directory.

To compare by hand, run `bun run contract:compatibility BASELINE_DIRECTORY`, replacing `BASELINE_DIRECTORY` with the path to the base commit's `openapi` directory. It needs oasdiff 1.35.0. Pull request CI checks out the exact base commit and runs this comparison automatically. It rejects breaking HTTP and event schema changes unless `info.version` has a higher major version than the base, and saves the reports as a workflow artifact. Bump the major version for an intentional break, and coordinate it before merging. A comparison with the base commit does not establish compatibility with every older deployed server or client.

The hook preserves unstaged edits to generated files. If you skip the hook, run `bun run openapi:generate` and stage the artifacts yourself.

The repository does not publish contract releases or bundles. To retrieve the specification for a server revision, use that revision's committed `openapi/` directory.

## Bot avatars

Contract version `6.0.0` intentionally replaces the `avatar` string with one validated geometry and colors object.
`avatar` is optional on create and patch; stored bot responses always include it. There is no separate `avatarDefinition` field:

```json
{
  "avatar": {
    "definition": {
      "version": 1,
      "id": "box",
      "name": "Box",
      "body": { "path": "M20 20H80V80H20Z" },
      "eyes": { "x": 50, "y": 46, "spacing": 15, "scale": 1 }
    },
    "color": "#38bdf8",
    "eyeColor": "#151515"
  }
}
```

The definition uses Open Bot Avatar v1 geometry in a `0 0 100 100` viewBox.
The server checks geometry with `validateAvatar` and accepts colors only as `#rgb` or `#rrggbb`.
Invalid input returns `400`, including the geometry validator's error messages.
Omitting `avatar` from a patch preserves it. Omitting it on create selects fresh gallery geometry from the bot ID, with library default colors.
Legacy string input returns `400`. JSON imports contain the definition alone; the editor sets colors separately.

The canonical object is stored as JSON in `agents.avatar`. The migration copies any previously saved `avatar_definition` values, then drops that interim column.
Before serving bots, repository initialization replaces legacy strings with fresh ID-derived gallery defaults. Legacy seeds, silhouettes, and colors don't affect the new appearance.
Valid saved definitions stay unchanged. Bot timestamps stay unchanged. Historical bot proposals are normalized too, preserving custom choices and decisions.
This data migration is restartable; runtime reads and web rendering accept only the canonical object.

Back up the database before upgrading. The migration overwrites legacy strings; the original appearance cannot be recovered without a backup.
A code revert alone doesn't restore the old API, avatar data, or interim column. Restore the matching pre-upgrade database and binary together for a complete rollback.
Restoring a backup discards changes made after that backup. There is no automatic down migration.

This is an intentional breaking change for native clients. Native support requires [apple#3](https://github.com/crumble-project/apple/issues/3) and
[android#7](https://github.com/crumble-project/android/issues/7) before those clients can use the new contract.

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
