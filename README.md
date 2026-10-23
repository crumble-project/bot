# Crumble server

Self-hosted AI agent server and bundled web UI, built on Bun, SQLite, and Pi Durable.

## Run

Requires Bun 1.4 or later.

```bash
bun install
bun run dev    # or `bun run start` without file watching
```

- **API:** `http://127.0.0.1:7337` (`/v1` requires the bearer token printed at startup; `GET /health` is public).
- **Web UI:** `http://127.0.0.1:7337/ui` (bundled on demand by Bun with Tailwind CSS; set `NODE_ENV=production` to minify).

| Variable | Default | Purpose |
| --- | --- | --- |
| `CRUMBLE_DATA_DIR` | `./data` | SQLite databases, Pi Durable stores, and `.secret.key` |
| `CRUMBLE_HOST` | `127.0.0.1` | Listen address (keep on loopback unless behind TLS) |
| `CRUMBLE_PORT` | `7337` | Listen port |
| `CRUMBLE_TOKEN` | Generated | Bearer token (overrides must be ≥ 32 characters) |
| `CRUMBLE_PUBLIC_URL` | Unset | Public `https://` URL for OAuth Client ID Metadata Documents (`/oauth/client-metadata.json`) |
| `CRUMBLE_SKILLS_DIR` | `./skills` | Directory of bundled default skills |
| `CRUMBLE_WORKSPACE_IMAGE` | Unset | Microsandbox OCI image enabling the `coding` tool |
| `CRUMBLE_WORKSPACE_DESKTOP_IMAGE` | Unset | Microsandbox OCI image enabling the `desktop` tool |
| `CRUMBLE_WORKSPACE_BACKEND` | Microsandbox | `railway` runs workspaces in Railway sandboxes and enables the `coding` tool |
| `CRUMBLE_RAILWAY_REGION` | Railway's default | Region of new Railway sandboxes, such as `europe-west4` |
| `CRUMBLE_CLAUDE_COMMAND` | `claude` on `PATH` | Claude Code executable for the Claude Code provider |
| `CRUMBLE_CLAUDE_CONFIG_DIR` | `$CRUMBLE_DATA_DIR/claude` | Claude Code's own config directory, holding its sign-in |
| `CRUMBLE_CLAUDE_TELEMETRY` | On | `off` stops Claude Code's telemetry and feature flags; its model list may then shrink |

Back up the entire `CRUMBLE_DATA_DIR` (including `.secret.key`, which decrypts stored provider and MCP credentials) and `MSB_HOME` (`~/.microsandbox`).

## Workspaces (`coding` and `desktop`)

Bots with the `coding` or `desktop` capability run jobs inside a per-bot [Microsandbox](https://github.com/superradcompany/microsandbox) microVM with a persistent disk volume (`crumble-<bot id>`). Requires Apple silicon on macOS or `/dev/kvm` on Linux.

Use the published images (`ghcr.io/crumble-project/crumble-workspace` and `ghcr.io/crumble-project/crumble-workspace-desktop`) or build and load locally from `workspace-image/Dockerfile`:

```bash
docker build --target base -t crumble-workspace:dev workspace-image
docker save crumble-workspace:dev -o /tmp/crumble-workspace.tar
bun -e 'import { Image } from "microsandbox"; await Image.load("/tmp/crumble-workspace.tar", { tag: "crumble-workspace:dev" })'
```

Build `--target desktop` as `crumble-workspace-desktop:dev` to enable bot desktops (`CRUMBLE_WORKSPACE_DESKTOP_IMAGE`).

### Railway sandboxes

With `CRUMBLE_WORKSPACE_BACKEND=railway`, each bot's workspace is a [Railway sandbox](https://docs.railway.com/sandboxes) instead, so the server needs no virtualization ([ADR 0005](docs/adr/0005-railway-workspaces.md)). Set `RAILWAY_TOKEN` (a project token) or `RAILWAY_API_TOKEN`, and `RAILWAY_ENVIRONMENT_ID`. Use a Hobby or Pro plan: other plans destroy idle sandboxes after 5 minutes. A bot's files survive as the checkpoint `crumble-<bot id>` in that environment, and outbound connections are not filtered. Bot desktops are not available on Railway yet.

Live tests create billed sandboxes: `CRUMBLE_RAILWAY_TESTS=1 bun test test/railway-workspaces.test.ts`.

## Claude subscription (Claude Code)

The Claude Code provider runs bots on a Claude Pro or Max subscription through the official Claude Code CLI on the server ([feature 0006](https://github.com/crumble-project/spec/blob/main/features/0006-claude-code-provider.md)). Crumble does not ship Claude Code and never reads its sign-in; you install it and sign in with Claude Code's own flow. Only the versions in `QUALIFIED_VERSIONS` (`src/claude-code/setup.ts`) are accepted, currently 2.1.309.

```bash
CLAUDE_CONFIG_DIR="$CRUMBLE_DATA_DIR/claude" claude auth login   # sign in for Crumble
CLAUDE_CONFIG_DIR="$CRUMBLE_DATA_DIR/claude" claude auth logout  # sign out
```

A plain `claude auth login` signs in a different directory. Provider settings show the exact commands for your server.

With Docker, install Claude Code onto the data volume, where the image looks for it, and sign in inside the container:

```bash
docker compose exec crumble sh -c 'mkdir -p /var/lib/crumble/claude-code && cd /var/lib/crumble/claude-code && echo "{\"trustedDependencies\":[\"@anthropic-ai/claude-code\"]}" > package.json && bun add @anthropic-ai/claude-code@2.1.309'
docker compose exec -it crumble sh -c 'CLAUDE_CONFIG_DIR=/var/lib/crumble/data/claude /var/lib/crumble/claude-code/node_modules/.bin/claude auth login'
```

To qualify another Claude Code version, run `bun tools/claude-code-qualify.ts /absolute/path/to/claude`. It drives the real CLI against a local fake upstream, with no account or inference, and exits non-zero on any failure.

Anthropic has not confirmed that this arrangement is permitted under its terms; see the specification.

## Run with Docker

```bash
docker compose up -d --build
docker compose exec crumble cat /var/lib/crumble/data/server-token
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
