# Crumble server

Self-hosted AI agent server and bundled web UI, built on Bun, SQLite, and Pi Durable.

## Run

Requires Bun 1.4 or later.

```bash
bun install
bun run dev    # or `bun run start` without file watching
```

- **API:** `http://127.0.0.1:7337` (`/v1` requires an account session; `GET /health` is public).
- **Web UI:** `http://127.0.0.1:7337/ui` (bundled on demand by Bun with Tailwind CSS; set `NODE_ENV=production` to minify).

| Variable | Default | Purpose |
| --- | --- | --- |
| `CRUMBLE_DATA_DIR` | `./data` | Account database, auth secret, and private per-user data directories |
| `CRUMBLE_HOST` | `127.0.0.1` | Listen address (keep on loopback unless behind TLS) |
| `CRUMBLE_PORT` | `7337` | Listen port |
| `BETTER_AUTH_URL` | Local listener origin | Canonical browser origin for authentication; `CRUMBLE_PUBLIC_URL` takes precedence |
| `CRUMBLE_PUBLIC_URL` | Unset | Public `https://` origin for authentication and OAuth client metadata |
| `CRUMBLE_SKILLS_DIR` | `./skills` | Directory of bundled default skills |
| `CRUMBLE_WORKSPACE_IMAGE` | Unset | Microsandbox OCI image enabling the `coding` tool |
| `CRUMBLE_WORKSPACE_DESKTOP_IMAGE` | Unset | Microsandbox OCI image enabling the `desktop` tool |


Back up the entire `CRUMBLE_DATA_DIR`, including `.auth-secret` and each user’s `.secret.key`, plus `MSB_HOME` (`~/.microsandbox`).

## Workspaces (`coding` and `desktop`)

Bots with the `coding` or `desktop` capability run jobs inside a per-bot [Microsandbox](https://github.com/superradcompany/microsandbox) microVM with a persistent disk volume (`crumble-<user id>-<bot id>`). Requires Apple silicon on macOS or `/dev/kvm` on Linux.

Use the published images (`ghcr.io/crumble-project/crumble-workspace` and `ghcr.io/crumble-project/crumble-workspace-desktop`) or build and load locally from `workspace-image/Dockerfile`:

```bash
docker build --target base -t crumble-workspace:dev workspace-image
docker save crumble-workspace:dev -o /tmp/crumble-workspace.tar
bun -e 'import { Image } from "microsandbox"; await Image.load("/tmp/crumble-workspace.tar", { tag: "crumble-workspace:dev" })'
```

Build `--target desktop` as `crumble-workspace-desktop:dev` to enable bot desktops (`CRUMBLE_WORKSPACE_DESKTOP_IMAGE`).

## Accounts and isolation

Open `/ui` to create an account or sign in with email and password. Better Auth manages account sessions at `/api/auth/*`. Configure your canonical origin before accessing the UI through a different hostname or a reverse proxy. Use `CRUMBLE_PUBLIC_URL` for an HTTPS deployment. Registration is open to anyone who can reach the server.

Each account owns a separate database, encryption key, bot runtimes, transcripts, groups, memories, skills, schedules, MCP credentials, provider logins, push registrations, and workspace namespace under `users/USER_ID`. “Shared” memories and skills are shared only among that account’s bots. Bundled skills are read-only server defaults. Providers use credentials saved by that account; host environment keys are ignored.

The host-wide Claude Code provider is disabled in multi-user mode. Configure a supported API provider in each account’s settings.

Native or API clients sign in through `POST /api/auth/sign-in/email`, then send the returned session token as `Authorization: Bearer SESSION_TOKEN`. Browser clients use the HTTP-only session cookie. Cookie-authenticated writes require the configured `Origin`. Sign-out revokes the session. Existing native clients need the account sign-in flow; this branch changes only `bot/`.

### Assign existing data

Legacy data stays at the data-directory root until an operator assigns it to an existing account. The old `server-token` grants no access. See [account migration](docs/multi-user.md) for the offline migration procedure.

## Run with Docker

```bash
docker compose up -d --build
```

On Linux with KVM workspaces, layer `compose.kvm.yaml` and pass `CRUMBLE_KVM_GID=$(getent group kvm | cut -d: -f3)` and `CRUMBLE_WORKSPACE_IMAGE`.

## Develop

```bash
bun run check                  # Lint, format, typecheck, contract drift, and unit tests
bun run format                 # Format source and tests
bun run openapi:generate       # Regenerate OpenAPI and six SSE JSON Schemas
bun run contract:validate      # Validate OpenAPI and JSON Schemas offline
bun run contract:compatibility # Compare against the latest stable contract-vX.Y.Z release
bun run contract:bundle        # Export a checksummed release bundle
```

## Documentation

- [Architecture](docs/architecture.md)
- [API contract maintenance](docs/api-contract.md) and [generated OpenAPI spec](openapi/openapi.json)
- [Native push notifications](docs/native-push.md)
- [Bundled default skills](skills/README.md)
- [Specifications and glossary](https://github.com/crumble-project/spec)
