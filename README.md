# Crumble server

Crumble server runs persistent agents and exposes the authenticated HTTP API used by the macOS client. The server uses Bun, SQLite, and Pi Durable.

## Requirements

- Bun 1.4 or later.
- A provider API key for live model requests. Configure provider credentials through the client or the API.
- A writable data directory. The default is `./data`.

## Install dependencies

From this directory, run:

```bash
bun install
```

## Start the server

Start a development server with file watching:

```bash
bun run dev
```

Start the server without file watching:

```bash
bun run start
```

The server listens on `127.0.0.1:7337` by default. Check the terminal output for the generated token-file path. Copy the token contents into the Crumble macOS app connection settings.

Use these environment variables when you need a different configuration:

| Variable | Default | Description |
| --- | --- | --- |
| `CRUMBLE_DATA_DIR` | `./data` | Directory for SQLite databases, the server token, and the encryption key. |
| `CRUMBLE_HOST` | `127.0.0.1` | Bind address. Keep the loopback default unless a trusted reverse proxy provides TLS and access control. |
| `CRUMBLE_PORT` | `7337` | HTTP port. |
| `CRUMBLE_TOKEN` | Generated in `server-token` | Bearer token override. The token must contain at least 32 characters. |

For example:

```bash
CRUMBLE_DATA_DIR="$PWD/.crumble-data" CRUMBLE_PORT=7338 bun run start
```

The server permits one process to own a data directory. A second process exits instead of sharing SQLite and Pi Durable state.

## Verify the server

Run the complete server checks:

```bash
bun run check
```

Run only tests:

```bash
bun run test
```

Run type checking:

```bash
bun run typecheck
```

After starting the server, check the unauthenticated health endpoint:

```bash
curl http://127.0.0.1:7337/health
```

The `/v1` API requires the bearer token, including server-sent event streams:

```bash
curl -H "Authorization: Bearer $CRUMBLE_TOKEN" http://127.0.0.1:7337/v1/agents
```

Live provider execution is not verified by the automated tests because this repository does not include provider credentials. Use a test provider account before accepting a live deployment.

## Providers

The server registers every Pi built-in provider plus [Melious](https://melious.ai/docs/reference/models), an OpenAI-compatible API at `https://api.melious.ai/v1`. Melious has no fixed catalog: after you save a Melious key, `GET /v1/models?provider=melious` loads the models your account can use. Melious does not report context windows or prices in that list, so the server assumes a 128,000-token context window, 16,384 output tokens, and no cost tracking.

## Bot chat API

Each bot has one continuous chat. These routes live under `/v1/agents/:id`:

| Route | Description |
| --- | --- |
| `GET /chat` | Snapshot of the newest transcript page, live generation state, and usage. |
| `GET /chat/history?before=&limit=` | Older transcript pages. Pass the previous page's `oldestEntryId` as `before`; `limit` is at most 200. |
| `POST /messages` | Send `{ content, requestId, replyTo?, attachments? }`. `requestId` is a UUID that makes retries idempotent. `replyTo` is a message `entryId`. `content` may be empty when the message has attachments. |
| `GET /attachments/:entryId/:index` | The bytes of an attached image, by its position in the message's `attachments`. |
| `GET /events` | Server-sent `snapshot` events for the chat. |
| `POST /abort` | Stop the running response. |
| `POST /compact` | Summarize older working context. The transcript keeps every original message. |

Scheduled tasks and delegated work from other bots post into the same chat. Their messages carry an `origin`.

### Attachments

`attachments` is a list of up to eight `{ name, mimeType, data }` objects, with `data` in base64:

- Images (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) of up to 5 MB reach the model as image input. A model whose catalog entry lacks image input refuses them with a `400`.
- Text files (`text/*`, and JSON, XML, YAML, TOML, JavaScript, TypeScript, shell and SQL) of up to 512 KB of UTF-8 reach the model as text, wrapped in an `<attachment name="…">` block.
- Other types, such as PDFs, are refused with a `400`.

The message endpoint accepts bodies of up to 32 MB; every other endpoint keeps a 1 MB limit. Transcript messages list their files as `attachments: [{ name, mimeType, size, kind }]`, and image bytes stay out of snapshots and history pages.

## Activity events

`GET /v1/events` is a server-wide stream of `activity` events for notifications:

- `{ type: "reply", agentId, agentName, entryId, origin, preview }` when any bot finishes a reply, from a chat, a scheduled task, or delegated work. `origin` is `owner`, `task`, or `bot`.
- `{ type: "approval", approvalId, agentId, agentName, toolName }` when an MCP tool call waits for approval.

Like the chat stream, it sends a `heartbeat` event every 15 seconds.

## MCP servers

An MCP server authenticates with a static token, saved with the server, or with OAuth. `GET /v1/mcp-servers` reports each server's `auth` as `token`, `oauth`, or `none`.

MCP connections and OAuth sign-in use `@earendil-works/pi-mcp`, following the MCP authorization spec. The server discovers the authorization server, registers itself as a client, and keeps the tokens encrypted with other credentials, refreshing them as needed:

1. `POST /v1/mcp-servers/:id/oauth` with `{ redirectUri }` returns `{ authorizationUrl }`, or `{ authorized: true }` when saved tokens still work.
2. The client opens `authorizationUrl` in a browser. The authorization server redirects to `redirectUri` with `code` and `state`.
3. `POST /v1/mcp-servers/:id/oauth/callback` with `{ code, state }` exchanges the code for tokens.

`DELETE /v1/mcp-servers/:id/oauth` signs out. When a refresh fails during a chat, the tool call fails with a message asking the owner to sign in again; it never waits for a browser.

## Protect and back up data

The server creates these protected files in the data directory:

- `server-token` authenticates API clients.
- `.secret.key` encrypts credentials stored in SQLite.
- `store.sqlite` stores product metadata, settings, MCP server records, and execution history.
- `agents/*.sqlite` stores Pi Durable conversation and execution state.

Keep the data directory private. The server creates it with owner-only permissions where the operating system supports them. Back up the entire directory, including `.secret.key`; a backup without the key cannot decrypt stored credentials. Encryption at rest does not protect data from a process or account that can read the running server directory.

Do not expose the loopback server directly to a network. If remote access is required, put it behind a trusted TLS reverse proxy and restrict access to the intended owner.

## Current scope and limitations

The repository contains working persistence, authenticated API routes, continuous bot chats, streaming events, scheduling, memory, MCP configuration, approvals, and delegation paths. The macOS client is the intended configuration surface for provider credentials and integrations.

The project is still under active development. Hermes Agent and Grok Bot parity remains an acceptance target, not a completed claim. Review [`docs/product-parity.md`](docs/product-parity.md) for the reference capability matrix and [`docs/architecture.md`](docs/architecture.md) for boundaries and milestones.

Known limitations include:

- Live provider behavior requires credentials and has not been verified in this checkout.
- The initial deployment model is one authenticated owner, not multi-tenant hosting.
- Pi Durable and the surrounding API are pinned to experimental package versions. Validate migrations before upgrading.
- Native client and server feature work continues. Treat unimplemented parity rows as pending work.
