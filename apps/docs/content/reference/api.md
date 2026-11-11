---
title: API Reference
description: Authenticate, call the /v1 HTTP API, and subscribe to event streams.
sidebar:
  order: 1
---

Everything the web app does goes through the HTTP API under `/v1`, so anything
you can click, you can script. Every server serves its full contract at
`GET /openapi.json` (OpenAPI 3.1), matching the version it runs. The same file
for the latest source is
[`openapi/openapi.json`](https://github.com/crumble-project/bot/blob/main/openapi/openapi.json).

The API calls bots `agents`, so bot endpoints start with `/v1/agents`. The two
words mean the same thing.

## Authenticating

Every `/v1` request needs an account session, except routes under
`/v1/voice/`. `GET /health` and `GET /openapi.json` are public.

Sign in to get a session token:

```bash
curl --fail-with-body http://127.0.0.1:7337/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  --data '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD"}'
```

Copy `token` from the JSON response and send it as a bearer token:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer SESSION_TOKEN" \
  http://127.0.0.1:7337/v1/capabilities
```

Browsers use the `better-auth.session_token` cookie instead. If a
cookie-authenticated write fails while reads work, check the `Origin` header:
it has to match the server's address.

Routes under `/v1/voice/` are for the [voice gateway](/concepts/voice-gateway)
and take only the voice gateway token as the bearer token, never a session.
The token reaches no other route.

## Endpoints

| Area                     | Paths                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Capabilities**         | `GET /v1/capabilities`                                                                                                                                                                                                                                                          |
| **Message gateways**     | `GET /v1/message-gateways`, `PUT /v1/message-gateways/{id}`                                                                                                                                                                                                                     |
| **Bots**                 | `/v1/agents`, `/v1/agents/{id}`, `POST /v1/agents/{id}/duplicate`                                                                                                                                                                                                               |
| **Bot chat**             | `/v1/agents/{id}/chat`, `/v1/agents/{id}/chat/history`, `POST /v1/agents/{id}/messages`, `POST /v1/agents/{id}/abort`, `POST /v1/agents/{id}/compact`, `/v1/agents/{id}/attachments/{entryId}/{index}`                                                                          |
| **Group chats**          | `/v1/group-chats`, `/v1/group-chats/{id}`, `/v1/group-chats/{id}/chat`, `/v1/group-chats/{id}/history`, `POST /v1/group-chats/{id}/messages`, `POST /v1/group-chats/{id}/stop`, `/v1/group-chats/{id}/attachments/{entryId}/{index}`                                            |
| **Jobs**                 | `/v1/agents/{id}/coding-jobs`, `/v1/agents/{id}/coding-jobs/{name}/history`, `/v1/agents/{id}/desktop-jobs`, `/v1/agents/{id}/desktop-jobs/{name}/history`                                                                                                                      |
| **Bot desktop**          | `POST /v1/agents/{id}/desktop/viewer`, `/v1/agents/{id}/desktop/control`, `GET /v1/agents/{id}/desktop/status`                                                                                                                                                                  |
| **Credentials**          | `/v1/agents/{id}/credentials`, `/v1/agents/{id}/credentials/{name}`, `/v1/agents/{id}/credentials/{name}/uses`                                                                                                                                                                  |
| **Logins**               | `/v1/agents/{id}/logins`, `/v1/agents/{id}/logins/{name}`, `/v1/agents/{id}/logins/{name}/uses`                                                                                                                                                                                 |
| **Call requests**        | `/v1/agents/{id}/call-requests`, `POST /v1/agents/{id}/call-requests/{requestId}/approve`, `POST /v1/agents/{id}/call-requests/{requestId}/decline`, `/v1/agents/{id}/call-requests/{requestId}/transcript`                                                                     |
| **Intent checks**        | `/v1/agents/{id}/held-actions`, `POST /v1/agents/{id}/held-actions/{actionId}/approve`, `POST /v1/agents/{id}/held-actions/{actionId}/decline`, `/v1/judge-model`                                                                                                               |
| **Memories**             | `/v1/memories`, `/v1/memories/{id}`, `/v1/agents/{id}/memories`, `/v1/agents/{id}/memories/{memoryId}`                                                                                                                                                                          |
| **Skills**               | `/v1/skills`, `/v1/skills/{id}`, `/v1/skills/{id}/update`, `/v1/skills/github/browse`, `/v1/skills/github/install`, `/v1/skills/updates/check`, `/v1/agents/{id}/skills`, `/v1/agents/{id}/skills/{skillId}`                                                                    |
| **Reviews & changes**    | `/v1/agents/{id}/reviews`, `/v1/changes`, `POST /v1/changes/{id}/revert`                                                                                                                                                                                                        |
| **Schedules & activity** | `/v1/schedules`, `POST /v1/schedules/{id}/run`, `/v1/executions`, `/v1/activity/feed`                                                                                                                                                                                           |
| **Event relay**          | `/v1/event-relay`, `/v1/event-sources`, `/v1/event-sources/{id}`                                                                                                                                                                                                                |
| **Voice gateway**        | `/v1/voice-gateway`, `/v1/voice-gateway/token`                                                                                                                                                                                                                                  |
| **Voice gateway token**  | `GET /v1/voice/events`, `POST /v1/voice/lines/{username}/messages`, `GET /v1/voice/lines/{username}/events`, `GET /v1/voice/lines/{username}/executions/{executionId}`, `PUT /v1/voice/lines`, `PUT /v1/voice/lines/{username}/calls/{callId}`, `POST /v1/voice/calls/{callId}` |
| **Providers & models**   | `/v1/providers`, `/v1/providers/{provider}`, `POST /v1/providers/{provider}/login`, `/v1/provider-logins/{id}`, `POST /v1/provider-logins/{id}/responses`, `/v1/models`, `/v1/vision-model`                                                                                     |
| **Password managers**    | `/v1/password-managers`, `/v1/password-managers/{id}`                                                                                                                                                                                                                           |
| **MCP servers**          | `/v1/mcp-servers`, `/v1/mcp-servers/{id}`, `/v1/mcp-servers/{id}/oauth`, `POST /v1/mcp-servers/{id}/oauth/callback`                                                                                                                                                             |

## Transcript and display fields

Transcript messages expose `blocks` as an array discriminated by `type`. The
server normalizes provider content before returning it. Image blocks contain
metadata; use the attachment endpoint to fetch image bytes.

`TranscriptBlock` and `JobHistoryItem` are named OpenAPI schemas with named
variants. Event schemas reference the same block definitions through `$defs`.
Client generators reuse these names across HTTP and event responses. Use the
generated types directly, adding presentation helpers and local UI state where needed.

Coding and desktop job history responses include `items`, ordered for display.
Each item's `kind` identifies a task, reply, or tool step. Steps include a display
label, an icon identifier, an optional subject, and their result when available.
Render these items instead of deriving steps from provider blocks.

Bot chat snapshots include `working`, which identifies the bot's current activity.
Use this field for activity indicators instead of interpreting tool calls.

Schedule responses include `description` for their timing and `timing` for the
same text with a `Paused · ` prefix when disabled. These fields include event
source names and use the schedule's time zone. Render them directly for saved
automations; keep editable recurrence inputs separate.

## Event Streams

Streams use Server-Sent Events:

| Stream                              | Event                                  | JSON Schema                                                                                                                                                         |
| ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/agents/{id}/events`            | `snapshot`                             | `openapi/chat-snapshot.schema.json`                                                                                                                                 |
| `/v1/group-chats/{id}/events`       | `snapshot`                             | `openapi/group-chat-snapshot.schema.json`                                                                                                                           |
| `/v1/agents/{id}/desktop/events`    | `control`                              | `openapi/desktop-control.schema.json`                                                                                                                               |
| `/v1/events`                        | `activity`, `learned`                  | `openapi/activity-event.schema.json`, `openapi/learned-event.schema.json`                                                                                           |
| `/v1/voice/events`                  | `config`, `call`, `cancel`, `replaced` | `openapi/voice-gateway-config.schema.json`, `openapi/voice-call.schema.json`, `openapi/voice-call-cancel.schema.json`, `openapi/voice-gateway-replaced.schema.json` |
| `/v1/voice/lines/{username}/events` | `snapshot`                             | `openapi/chat-snapshot.schema.json`                                                                                                                                 |

Every stream sends `event: heartbeat` with `data: {}` every 15 seconds. A
client should ignore heartbeats and event types it doesn't know, and fetch a
fresh snapshot after it reconnects.

A voice gateway reports each call with `PUT /v1/voice/lines/{username}/calls/{callId}`
before the greeting, again after every `config` event while the call runs,
and its end with `POST /v1/voice/calls/{callId}` and `{ "outcome": "ended",
"reason": "hungUp" }` (or `maxDuration`, `failed`, `stopping`). A `409` from
either start report or a spoken message means the call ended: hang up. In a
bot's transcript, calls show as `call-started` and `call-ended` events with a
`call` field, and an end that wakes the bot as a message with `origin.kind`
`call`.

An approved call request sends a `call` event with `party` `outside`. While
the line's active call is that outside call, its messages, events, and
execution reads go to the call's own conversation, never the bot chat, and the
`call` field of its events carries `callee`. Any other use of an outside
call's ID answers `409`: hang up.

A chat snapshot's `partial` is empty unless you open
`/v1/agents/{id}/events?partial=true`. Then it carries the text of the reply
the bot is writing, updated about every 100 ms, and replies still appear in
`messages` only when the turn ends. When the bot calls a tool between two
pieces of text, `partial` starts over with the next piece.
