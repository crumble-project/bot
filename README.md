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
| `CRUMBLE_WORKSPACE_IMAGE` | Unset: no bot is offered the `coding` tool. See [Coding workspaces](#coding-workspaces) |

Keep the server on loopback unless you provide TLS and access control.
Back up the entire data directory, including `.secret.key`, which is required to decrypt stored credentials.

## Coding workspaces

A bot with the `coding` tool runs coding jobs in its own workspace: a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM on a persistent disk in `<data dir>/workspaces/<bot id>/`. Jobs can make HTTP and HTTPS requests to the internet, for example to clone repositories or install packages. Other protocols, including SSH, and private address ranges, such as the host's network and cloud metadata, are blocked. The VM starts on first use and stops after 10 minutes without a request; the disk keeps its files.

Requirements:

- QEMU, including `qemu-img`, with hardware acceleration: HVF on macOS, or read-write access to `/dev/kvm` on Linux. Without it, the VM fails to start.
- A guest image with git and build tools, built from `workspace-image/gondolin.json`. The build runs in Docker:

  ```bash
  bunx gondolin build --config workspace-image/gondolin.json --arch aarch64 --output <image dir>
  ```

  Use `--arch x86_64` on an x86-64 host. Set `CRUMBLE_WORKSPACE_IMAGE` to the output directory.

A workspace disk only boots with the image it was created from. Changing the image makes existing workspaces fail with an error; migration is not supported yet.

Gondolin's VM tests are skipped by default. To run them:

```bash
CRUMBLE_VM_TESTS=1 CRUMBLE_WORKSPACE_IMAGE=<image dir> bun test test/gondolin-workspaces.test.ts
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

- State lives in the `crumble` volume at `/var/lib/crumble`, which holds the data directory and its lock. Run one container per volume, and use a local disk rather than a network filesystem.
- Compose publishes the port on the host's loopback only. For remote clients, use a private network such as Tailscale or a TLS reverse proxy.
- To set your own token, pass `CRUMBLE_TOKEN` through an env file. For native push, mount the APNs key or FCM service account read-only and set the `CRUMBLE_APNS_*` or `CRUMBLE_FCM_SERVICE_ACCOUNT_PATH` variables (see [Native push](docs/native-push.md)).
- Back up the volume, including `data/.secret.key`. Stop the container first, or copy the SQLite files with `sqlite3 .backup`.

## Develop

```bash
bun run check             # Lint, formatting, types, contract drift, and tests
bun run format            # Format source and tests
bun run openapi:generate  # Regenerate the shared API contract
```

## API and docs

`/v1` endpoints require bearer authentication. `GET /health` is unauthenticated.

- [OpenAPI contract](openapi/openapi.json): generated specification for client models and API clients.
- [Contract maintenance](docs/api-contract.md): schema ownership, generation, and streaming conventions.
- [Architecture](docs/architecture.md)
- [Native push](docs/native-push.md)
- [Feature parity](docs/product-parity.md)
