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

| Variable           | Default                     | Description                                                                                             |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `CRUMBLE_DATA_DIR` | `./data`                    | Directory for SQLite databases, the server token, and the encryption key.                               |
| `CRUMBLE_HOST`     | `127.0.0.1`                 | Bind address. Keep the loopback default unless a trusted reverse proxy provides TLS and access control. |
| `CRUMBLE_PORT`     | `7337`                      | HTTP port.                                                                                              |
| `CRUMBLE_TOKEN`    | Generated in `server-token` | Bearer token override. The token must contain at least 32 characters.                                   |

For example:

```bash
CRUMBLE_DATA_DIR="$PWD/.crumble-data" CRUMBLE_PORT=7338 bun run start
```

The server permits one process to own a data directory. A second process exits instead of sharing SQLite and Pi Durable state.

## Verify the server

Run the complete server checks (lint, format check, type checking, and tests):

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

Run the Oxlint rules, including the vendored anti-slop plugin in `tools/oxlint/anti-slop/`:

```bash
bun run lint
```

Format `src` and `test` with oxfmt, or only check formatting:

```bash
bun run format
bun run format:check
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

| Route                              | Description                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /chat`                        | Snapshot of the newest transcript page, live generation state, and usage.                                                                                                                              |
| `GET /chat/history?before=&limit=` | Older transcript pages. Pass the previous page's `oldestEntryId` as `before`; `limit` is at most 200.                                                                                                  |
| `POST /messages`                   | Send `{ content, requestId, replyTo?, attachments? }`. `requestId` is a UUID that makes retries idempotent. `replyTo` is a message `entryId`. `content` may be empty when the message has attachments. |
| `GET /attachments/:entryId/:index` | The bytes of an attached image, by its position in the message's `attachments`.                                                                                                                        |
| `GET /events`                      | Server-sent `snapshot` events for the chat.                                                                                                                                                            |
| `POST /abort`                      | Stop the running response.                                                                                                                                                                             |
| `POST /compact`                    | Summarize older working context. The transcript keeps every original message.                                                                                                                          |

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

Like the chat stream, it sends a `heartbeat` event every 15 seconds.

## Shared and personal memory, skills, and MCP servers

Memory, skills, and MCP servers are either shared or belong to one bot.

- **Memory:** `/v1/agents/:id/memories` holds a bot's own memories, and `/v1/memories` holds shared ones (`agentId: null`). A bot recalls shared memories only when its `sharedMemory` is `true`. Its `memory` tool then lists them marked `shared`, can update or delete them, and saves a new one as shared with `shared: true`.
- **Skills:** repository-backed common skills are loaded from the workspace `skills` directory by default (override with `CRUMBLE_SKILLS_DIR` or `skillsDir` in `startServer`). Each immediate subdirectory containing `SKILL.md` is applied to every bot before opt-in shared skills and the bot's own inline skills. Bundled defaults and editable shared skills appear together at `/v1/skills`; bundled entries have `source: "bundled"`, stable `common:` IDs, and are read-only. They are never copied into SQLite. A missing default directory is treated as an empty catalog and logged; an explicitly configured missing directory fails startup. A file may begin with simple `name:` and `description:` YAML frontmatter; without it, the directory name is used. Shared skills use `source: "shared"`, and a bot uses those whose IDs are in its `sharedSkills`. Deleting a shared skill removes it from every bot. Skills are loaded at server startup, so restart after changing files.
- **MCP servers:** `POST /v1/mcp-servers` with `agentId` creates a server that belongs to that bot. The bot starts using it right away, and no other bot can use it. Its token or OAuth sign-in is separate from any shared server for the same service. Which bot a server belongs to cannot change. Deleting the bot deletes its servers and their credentials, and duplicating the bot leaves them with the original.

## MCP servers

An MCP server authenticates with a static token, saved with the server, or with OAuth. `GET /v1/mcp-servers` reports each server's `auth` as `token`, `oauth`, or `none`, and its `agentId` (`null` for a shared server).

MCP connections and OAuth sign-in use `@earendil-works/pi-mcp`, following the MCP authorization spec. The server discovers the authorization server, registers itself as a client, and keeps the tokens encrypted with other credentials, refreshing them as needed:

1. `POST /v1/mcp-servers/:id/oauth` with `{ redirectUri }` returns `{ authorizationUrl }`, or `{ authorized: true }` when saved tokens still work.
2. The client opens `authorizationUrl` in a browser. The authorization server redirects to `redirectUri` with `code` and `state`.
3. `POST /v1/mcp-servers/:id/oauth/callback` with `{ code, state, iss? }` exchanges the code for tokens. Send `iss` whenever the callback URL carries it; servers that promise one (RFC 9207) reject the sign-in without it.

`DELETE /v1/mcp-servers/:id/oauth` signs out. When a refresh fails during a chat, the tool call fails with a message asking the owner to sign in again; it never waits for a browser.

## Code mode

An agent with the `codemode` capability uses Pi Durable's code mode (`@earendil-works/pi-durable/codemode`). The model is offered one `codemode` tool and writes JavaScript that calls the agent's other tools, such as memory, delegation, and MCP tools, as `await tools.<name>(args)`. Only the script's output reaches the model, so a task that needs many tool calls takes one step. Each MCP server's tools are grouped under the server's name.

Scripts run in a QuickJS sandbox from `@earendil-works/pi-codemode`, one worker per script, with a 256 MB memory limit. Their only capability is calling the agent's tools, and permitted MCP tools execute directly after the same server and agent checks as normal tool calls. A script survives a server restart and resumes without repeating finished calls.

## Scheduled tasks

`POST /v1/schedules` creates a task for one bot. `agentId` is the bot whose chat runs the prompt, either once at `runAt` or on a `cron` schedule. Update that field to move the task to another bot.

A bot with the `schedule` capability gets a `schedule` tool (`list`, `create`, `update`, `delete`, `run`). Omitting `agentId` targets the bot itself. It can target another bot only when **Message other bots** is on and that bot is in its permitted list. It can change tasks that run on it, including ones the owner saved, and tasks it created for someone else. A task it did not create for another bot stays hidden.

## Protect and back up data

The server creates these protected files in the data directory:

- `server-token` authenticates API clients.
- `.secret.key` encrypts credentials stored in SQLite.
- `store.sqlite` stores product metadata, settings, MCP server records, and execution history.
- `agents/*.sqlite` stores Pi Durable conversation and execution state.

Keep the data directory private. The server creates it with owner-only permissions where the operating system supports them. Back up the entire directory, including `.secret.key`; a backup without the key cannot decrypt stored credentials. Encryption at rest does not protect data from a process or account that can read the running server directory.

Do not expose the loopback server directly to a network. If remote access is required, put it behind a trusted TLS reverse proxy and restrict access to the intended owner.

## Current scope and limitations

The repository contains working persistence, authenticated API routes, continuous bot chats, streaming events, scheduling, memory, MCP configuration, and delegation paths. The macOS client is the intended configuration surface for provider credentials and integrations.

The project is still under active development. Hermes Agent and Grok Bot parity remains an acceptance target, not a completed claim. Review [`docs/product-parity.md`](docs/product-parity.md) for the reference capability matrix and [`docs/architecture.md`](docs/architecture.md) for boundaries and milestones.

Known limitations include:

- Live provider behavior requires credentials and has not been verified in this checkout.
- The initial deployment model is one authenticated owner, not multi-tenant hosting.
- Pi Durable and the surrounding API are pinned to experimental package versions. Validate migrations before upgrading.
- Native client and server feature work continues. Treat unimplemented parity rows as pending work.

## Ask another bot

Enable **Message other bots** in the requesting bot’s desktop profile and select the bots it may contact. Then send a normal chat message, such as “Can you ask @Bot2 how he feels?”

The model can discover permitted recipients with `list_bots` and call `ask_bot` with a bot ID, exact name, or `@Name`. Name matching ignores case; duplicate names require an ID. The ask waits up to 60 seconds and returns the answer or a pending receipt. `delegation_status` can check that receipt later. Existing `delegate` calls still start bounded work without waiting.

The source chat records explicit sender-to-recipient communication cards for the sent question and observed answer or failure. The target chat identifies the incoming bot. Private chat history and memory are not automatically forwarded. Cancelling the source run stops its wait while the target’s admitted execution continues.

See [Bot messaging architecture](docs/architecture.md#bot-messaging) for the module seams and execution flow.
