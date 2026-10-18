# API contract maintenance

The server owns the API contract. [`openapi/openapi.json`](../openapi/openapi.json) is its generated, language-independent distribution artifact.
Clients consume a pinned revision or release of that file. No files are exported to a sibling repository.

## Source files

- `src/api-contract.ts` defines routes, operation IDs, security, request schemas, and response references.
- `src/api-responses.ts` defines response schemas and server-sent event payloads.
- `src/domain.ts` defines existing agent, schedule, and skill input schemas reused by the contract.
- `src/attachments.ts` defines the attachment input schema reused by message requests.
- `src/api.ts` binds route definitions to handlers. Handlers reuse the request schemas; handler responses are type-checked against the contract.
- `src/openapi.ts` exports OpenAPI 3.1 without importing the runtime or starting the server.

Route registration uses the `OpenAPIHono` registry from `@hono/zod-openapi`, followed by Hono handler registration.
It deliberately retains existing parsers instead of installing automatic OpenAPI validators.
Automatic validators would change JSON error handling, content-type acceptance, and PATCH validation before merging stored values.
PATCH schemas describe supplied fields; handlers merge them with the stored resource before validating the complete input.

## Change the contract

1. Update the relevant request or response schema and handler together.
2. Add new endpoints to `routes` in `src/api-contract.ts` and bind them with `register` in `src/api.ts`.
3. Give each endpoint a stable, unique `operationId`.
4. Run `bun run openapi:generate`.
5. Run `bun run check`.
6. Include `openapi/openapi.json` with the source changes.

`bun run openapi:check` compares the generated document byte-for-byte with the checked-in file and exits nonzero on drift.
CI can run this command independently or run the complete `bun run check` command.
Generation does not fetch provider catalogs, use credentials, or open databases.

OpenAPI cannot express every runtime rule. Provider availability, MCP ownership, attachment validity, and cross-field refinements still require server validation.
The contract documents nullable resource responses where existing handler return types permit `null`.

## Consume the contract

Use `openapi/openapi.json` as input to your client's OpenAPI generator.
Pin its server revision or release so builds don't silently consume contract changes from the default branch.
Supply the server base URL at runtime and use bearer authentication for `/v1` endpoints.
`GET /health` is unauthenticated. The server does not add a public documentation endpoint.

Generated clients do not replace integration checks against the server.
Provider-defined transcript blocks, tool details, live progress, and usage documents remain open JSON values rather than invented fixed shapes.

## Handle server-sent events

OpenAPI describes each stream as `text/event-stream`, with a string body rather than a JSON response array.
The `x-sse-events` extension on each streaming operation maps event names to JSON payload schemas.
Standard OpenAPI generators might ignore this extension; implement streaming transport separately.

| Endpoint | Event | JSON payload schema |
| --- | --- | --- |
| `/v1/agents/{id}/events` | `snapshot` | `ChatSnapshot` |
| `/v1/agents/{id}/events` | `heartbeat` | `HeartbeatEvent` |
| `/v1/events` | `activity` | `ReplyEvent` or `ChatPreviewEvent` |
| `/v1/events` | `heartbeat` | `HeartbeatEvent` |

Each event uses standard framing, with a JSON-encoded `data` field followed by a blank line:

```text
event: heartbeat
data: {}

```

Both streams send heartbeats every 15 seconds and require an `Authorization: Bearer TOKEN` header.
Replace `TOKEN` with the server token. Use a streaming client that supports request headers.

The server-wide stream replays current chat previews on connection, but does not replay completed replies.
Chat streams publish snapshots when state changes. Fetch `/v1/agents/{id}/chat` when reconnecting to recover the current snapshot.
Neither stream supports `Last-Event-ID` replay.
