# API contract maintenance

`bot` generates the HTTP and server-sent event (SSE) specifications from its Zod route and response schemas. A running server serves the same document at `GET /openapi.json` without authentication; client integrations should read it there or from `openapi/`. The OpenAPI `info.version` is a required document field, not a release identifier. Nothing enforces compatibility: coordinate breaking changes with the client repositories by hand.

## Exported artifacts

```bash
bun run openapi:generate
bun run openapi:check
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
| `openapi/voice-gateway-config.schema.json` | `voiceGatewayConfigEvent` |
| `openapi/voice-call.schema.json` | `voiceCallEvent` |
| `openapi/voice-call-cancel.schema.json` | `voiceCallCancelEvent` |
| `openapi/voice-gateway-replaced.schema.json` | `voiceGatewayReplacedEvent` |

## Change workflow

1. Update the Zod schema and route handler together, using stable operation IDs.
2. Run `bun run openapi:generate` and commit the regenerated `openapi/` files with the change. `bun run check` fails while they are stale.

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

## Outside calls

A bot with a line that may call other people (`callsOthers` on a line of `PUT /v1/voice-gateway`, absent means `false`) gets the `request_call` tool. Its result's `details` is the stored `CallRequest`, the schema of `GET /v1/agents/{id}/call-requests`, which a card reads to show the request and **Approve** and **Decline**. `POST .../approve` dials at once and answers `409`, leaving the request `pending`, when the number rules or the line refuse the call.

The `call` event's `party` is `owner` or `outside`; absent means `owner`. For an outside call, `to` is the approved number, normalized, and `greeting` the approved opening. The server stores an outside call's ID before it sends the event. The ID becomes the line's active call only by a start report while the call rings: every other start report, spoken message, line event stream (`callId` query), or execution read for it answers `409`. While it is active, the line's messages go to the call's own conversation under request IDs `outside-call:{callId}:{requestId}`, and the line's event stream and execution reads serve that conversation. A transcript event's `call` gains an optional `callee` for outside calls.

## Server-sent events

All `/v1` streams require a Better Auth account session (a session bearer token or browser session cookie), except `/v1/voice/` streams, which take only a voice gateway token. All send `event: heartbeat` (`data: {}`) every 15 seconds. Clients must ignore heartbeats and unknown event names and recover state via the corresponding snapshot endpoint on reconnect.

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
| `/v1/voice/events` | `config` | `voice-gateway-config.schema.json` |
| `/v1/voice/events` | `call` | `voice-call.schema.json` |
| `/v1/voice/events` | `cancel` | `voice-call-cancel.schema.json` |
| `/v1/voice/events` | `replaced` | `voice-gateway-replaced.schema.json` |
| `/v1/voice/events` | `heartbeat` | `heartbeat.schema.json` |
| `/v1/voice/lines/{username}/events` | `snapshot` | `chat-snapshot.schema.json` |
| `/v1/voice/lines/{username}/events` | `heartbeat` | `heartbeat.schema.json` |
