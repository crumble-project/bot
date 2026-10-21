# Crumble server

Persistent agents with an authenticated HTTP API, built on Bun, SQLite, and Pi Durable.

## Run

Requires Bun 1.4 or later. Configure a provider API key through the client or API for live model requests.

```bash
bun install
bun run dev
```

Use `bun run start` without file watching. The default address is `http://127.0.0.1:7337`.
Copy the server token from the path printed at startup into your client's connection settings.

| Variable | Default |
| --- | --- |
| `CRUMBLE_DATA_DIR` | `./data` |
| `CRUMBLE_HOST` | `127.0.0.1` |
| `CRUMBLE_PORT` | `7337` |
| `CRUMBLE_TOKEN` | Generated; overrides require at least 32 characters |
| `CRUMBLE_WORKSPACE_IMAGE` | Unset: no bot is offered the `coding` tool. An OCI image reference; see [Coding workspaces](#coding-workspaces) |

Keep the server on loopback unless you provide TLS and access control.
Back up the entire data directory, including `.secret.key`, which is required to decrypt stored credentials.

## Coding workspaces

A bot with the `coding` tool runs coding jobs in its own workspace: a [Microsandbox](https://github.com/superradcompany/microsandbox) microVM with the bot's files on a persistent disk volume named `crumble-<bot id>`. Jobs can make HTTP and HTTPS requests to the internet, for example to clone repositories or install packages. Other protocols, including SSH, and private address ranges, such as the host's network and cloud metadata, are blocked. The VM starts on first use and stops after 10 minutes without a request; the volume keeps its files, also when the image changes.

Requirements:

- Hardware virtualization: Apple silicon on macOS, or read-write access to `/dev/kvm` on Linux. In Docker, use `compose.kvm.yaml`, which passes `/dev/kvm` and the host's kvm group to the container.
- A guest image with git and build tools, built from the `base` target of `workspace-image/Dockerfile` and imported into Microsandbox:

  ```bash
  docker build --target base -t crumble-workspace:dev workspace-image
  docker save crumble-workspace:dev -o /tmp/crumble-workspace.tar
  bun -e 'import { Image } from "microsandbox"; await Image.load("/tmp/crumble-workspace.tar", { tag: "crumble-workspace:dev" })'
  ```

  Set `CRUMBLE_WORKSPACE_IMAGE=crumble-workspace:dev`. Any OCI image reference from a registry also works.

- For desktop jobs, the `desktop` target: the base image plus a bot desktop (Xvnc, Openbox, tint2, Chromium, and a pinned cua-driver with telemetry off). Bots with the `desktop` tool boot it instead of the base image:

  ```bash
  docker build --target desktop -t crumble-workspace-desktop:dev workspace-image
  docker save crumble-workspace-desktop:dev -o /tmp/crumble-workspace-desktop.tar
  bun -e 'import { Image } from "microsandbox"; await Image.load("/tmp/crumble-workspace-desktop.tar", { tag: "crumble-workspace-desktop:dev" })'
  ```

  Set `CRUMBLE_WORKSPACE_DESKTOP_IMAGE=crumble-workspace-desktop:dev`. Without it, no bot is offered the `desktop` tool.

Published images, built for amd64 and arm64 by the Workspace images workflow (run it manually, or push a `workspace-image-v*` tag): `ghcr.io/crumble-project/crumble-workspace` and `ghcr.io/crumble-project/crumble-workspace-desktop`.

Microsandbox keeps images, sandboxes, and volumes in `MSB_HOME` (default `~/.microsandbox`; `/var/lib/crumble/microsandbox` in the Docker image). Back it up with the data directory.

The VM tests are skipped by default. To run them:

```bash
CRUMBLE_VM_TESTS=1 CRUMBLE_WORKSPACE_IMAGE=crumble-workspace:dev bun test test/microsandbox-workspaces.test.ts
```

The image change test also needs the same image under a second tag, which it treats as another image:

```bash
bun -e 'import { Image } from "microsandbox"; await Image.save("crumble-workspace:dev", { outputPath: "/tmp/crumble-workspace-other.tar" }); await Image.load("/tmp/crumble-workspace-other.tar", { tag: "crumble-workspace:other" })'
CRUMBLE_VM_TESTS=1 CRUMBLE_WORKSPACE_IMAGE=crumble-workspace:dev CRUMBLE_WORKSPACE_IMAGE_OTHER=crumble-workspace:other bun test test/microsandbox-workspaces.test.ts
```

## Run with Docker

The build fetches the shared skills from [crumble-project/skills](https://github.com/crumble-project/skills) and bundles them into the image. It uses `main` by default; set `CRUMBLE_SKILLS_REF` (Compose) or the `SKILLS_REF` build argument to a tag or commit to pin them.

```bash
docker compose up -d --build
docker compose exec crumble cat /var/lib/crumble/data/server-token
```

To bundle a local skills checkout instead, override the `skills` build stage:

```bash
docker build --build-context skills=../skills -t crumble-server .
```

- State lives in the `crumble` volume at `/var/lib/crumble`, which holds the data directory, its lock, and Microsandbox state. Run one container per volume, and use a local disk rather than a network filesystem.
- Compose publishes the port on the host's loopback only. For remote clients, use a private network such as Tailscale or a TLS reverse proxy.
- To set your own token, pass `CRUMBLE_TOKEN` through an env file. For native push, mount the APNs key or FCM service account read-only and set the `CRUMBLE_APNS_*` or `CRUMBLE_FCM_SERVICE_ACCOUNT_PATH` variables (see [Native push](docs/native-push.md)).
- Back up the volume, including `data/.secret.key`. Stop the container first, or copy the SQLite files with `sqlite3 .backup`.

### Enable coding workspaces on Linux

Build and save the guest image as described in [Coding workspaces](#coding-workspaces). Import it inside the server container: the host's Microsandbox cache is separate from the container's volume.

```bash
export CRUMBLE_KVM_GID=$(getent group kvm | cut -d: -f3)
export CRUMBLE_WORKSPACE_IMAGE=crumble-workspace:dev
docker compose -f compose.yaml -f compose.kvm.yaml build
docker compose -f compose.yaml -f compose.kvm.yaml run --rm \
  -v /tmp/crumble-workspace.tar:/tmp/workspace.tar:ro \
  crumble bun -e 'import { Image } from "microsandbox"; await Image.load("/tmp/workspace.tar", { tag: process.env.CRUMBLE_WORKSPACE_IMAGE })'
docker compose -f compose.yaml -f compose.kvm.yaml up -d
```

The override grants access to `/dev/kvm` and the host's KVM group. It does not require privileged mode.

## Develop

```bash
bun run check             # Lint, formatting, types, contract drift, and tests
bun run format            # Format source and tests
bun run openapi:generate  # Regenerate OpenAPI and three event JSON Schemas
bun run contract:validate # Validate OpenAPI and JSON Schema offline
bun run contract:compatibility # Compare with the latest stable contract release
bun run contract:bundle   # Export a checksummed bundle after committing changes
```

## API and docs

`/v1` endpoints require bearer authentication. `GET /health` is unauthenticated.

- [OpenAPI contract](openapi/openapi.json): generated specification for client models and API clients.
- [Contract releases](https://github.com/crumble-project/bot/releases?q=contract-v): independently versioned `contract-vX.Y.Z` bundles with event schemas, checksums, changelog, and source provenance.
- [Contract maintenance](docs/api-contract.md): schema ownership, generation, and streaming conventions.
- [Architecture](docs/architecture.md)
- [Native push](docs/native-push.md)
- [Feature parity](https://github.com/crumble-project/spec/blob/main/product/parity.md)
