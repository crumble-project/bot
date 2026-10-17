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

## Protect and back up data

The server creates these protected files in the data directory:

- `server-token` authenticates API clients.
- `.secret.key` encrypts credentials stored in SQLite.
- `store.sqlite` stores product metadata, settings, MCP server records, and execution history.
- `agents/*.sqlite` stores Pi Durable conversation and execution state.

Keep the data directory private. The server creates it with owner-only permissions where the operating system supports them. Back up the entire directory, including `.secret.key`; a backup without the key cannot decrypt stored credentials. Encryption at rest does not protect data from a process or account that can read the running server directory.

Do not expose the loopback server directly to a network. If remote access is required, put it behind a trusted TLS reverse proxy and restrict access to the intended owner.

## Current scope and limitations

The repository contains working persistence, authenticated API routes, agent conversations, streaming events, scheduling, memory, MCP configuration, approvals, and delegation paths. The macOS client is the intended configuration surface for provider credentials and integrations.

The project is still under active development. Hermes Agent and Grok Bot parity remains an acceptance target, not a completed claim. Review [`docs/product-parity.md`](docs/product-parity.md) for the reference capability matrix and [`docs/architecture.md`](docs/architecture.md) for boundaries and milestones.

Known limitations include:

- Live provider behavior requires credentials and has not been verified in this checkout.
- The initial deployment model is one authenticated owner, not multi-tenant hosting.
- Pi Durable and the surrounding API are pinned to experimental package versions. Validate migrations before upgrading.
- Native client and server feature work continues. Treat unimplemented parity rows as pending work.
