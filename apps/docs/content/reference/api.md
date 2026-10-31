---
title: API Reference
description: Authenticate, call the /v1 HTTP API, and subscribe to event streams.
sidebar:
  order: 1
---

Everything the web app does goes through the HTTP API under `/v1`, so anything
you can click, you can script. The full contract is
[`openapi/openapi.json`](https://github.com/crumble-project/bot/blob/main/openapi/openapi.json)
(OpenAPI 3.1).

The API calls bots `agents`, so bot endpoints start with `/v1/agents`. The two
words mean the same thing.

## Authenticating

Every `/v1` request needs an account session. `GET /health` is the only public
endpoint.

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

## Endpoints

| Area                     | Paths                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Capabilities**         | `GET /v1/capabilities`                                                                                                                                                                                                               |
| **Bots**                 | `/v1/agents`, `/v1/agents/{id}`, `POST /v1/agents/{id}/duplicate`                                                                                                                                                                    |
| **Bot chat**             | `/v1/agents/{id}/chat`, `/v1/agents/{id}/chat/history`, `POST /v1/agents/{id}/messages`, `POST /v1/agents/{id}/abort`, `POST /v1/agents/{id}/compact`, `/v1/agents/{id}/attachments/{entryId}/{index}`                               |
| **Group chats**          | `/v1/group-chats`, `/v1/group-chats/{id}`, `/v1/group-chats/{id}/chat`, `/v1/group-chats/{id}/history`, `POST /v1/group-chats/{id}/messages`, `POST /v1/group-chats/{id}/stop`, `/v1/group-chats/{id}/attachments/{entryId}/{index}` |
| **Jobs**                 | `/v1/agents/{id}/coding-jobs`, `/v1/agents/{id}/coding-jobs/{name}/history`, `/v1/agents/{id}/desktop-jobs`, `/v1/agents/{id}/desktop-jobs/{name}/history`                                                                           |
| **Bot desktop**          | `POST /v1/agents/{id}/desktop/viewer`, `/v1/agents/{id}/desktop/control`, `GET /v1/agents/{id}/desktop/status`                                                                                                                       |
| **Credentials**          | `/v1/agents/{id}/credentials`, `/v1/agents/{id}/credentials/{name}`, `/v1/agents/{id}/credentials/{name}/uses`                                                                                                                       |
| **Logins**               | `/v1/agents/{id}/logins`, `/v1/agents/{id}/logins/{name}`, `/v1/agents/{id}/logins/{name}/uses`                                                                                                                                      |
| **Intent checks**        | `/v1/agents/{id}/held-actions`, `POST /v1/agents/{id}/held-actions/{actionId}/approve`, `POST /v1/agents/{id}/held-actions/{actionId}/decline`, `/v1/judge-model`                                                                    |
| **Memories**             | `/v1/memories`, `/v1/memories/{id}`, `/v1/agents/{id}/memories`, `/v1/agents/{id}/memories/{memoryId}`                                                                                                                               |
| **Skills**               | `/v1/skills`, `/v1/skills/{id}`, `/v1/agents/{id}/skills`, `/v1/agents/{id}/skills/{skillId}`                                                                                                                                        |
| **Reviews & changes**    | `/v1/agents/{id}/reviews`, `/v1/changes`, `POST /v1/changes/{id}/revert`                                                                                                                                                             |
| **Schedules & activity** | `/v1/schedules`, `POST /v1/schedules/{id}/run`, `/v1/executions`, `/v1/activity/feed`                                                                                                                                                |
| **Providers & models**   | `/v1/providers`, `/v1/providers/{provider}`, `POST /v1/providers/{provider}/login`, `/v1/provider-logins/{id}`, `POST /v1/provider-logins/{id}/responses`, `/v1/models`                                                              |
| **Password managers**    | `/v1/password-managers`, `/v1/password-managers/{id}`                                                                                                                                                                                |
| **MCP servers**          | `/v1/mcp-servers`, `/v1/mcp-servers/{id}`, `/v1/mcp-servers/{id}/oauth`, `POST /v1/mcp-servers/{id}/oauth/callback`                                                                                                                  |

## Event Streams

Streams use Server-Sent Events:

| Stream                           | Event                 | JSON Schema                                                               |
| -------------------------------- | --------------------- | ------------------------------------------------------------------------- |
| `/v1/agents/{id}/events`         | `snapshot`            | `openapi/chat-snapshot.schema.json`                                       |
| `/v1/group-chats/{id}/events`    | `snapshot`            | `openapi/group-chat-snapshot.schema.json`                                 |
| `/v1/agents/{id}/desktop/events` | `control`             | `openapi/desktop-control.schema.json`                                     |
| `/v1/events`                     | `activity`, `learned` | `openapi/activity-event.schema.json`, `openapi/learned-event.schema.json` |

Every stream sends `event: heartbeat` with `data: {}` every 15 seconds. A
client should ignore heartbeats and event types it doesn't know, and fetch a
fresh snapshot after it reconnects.
