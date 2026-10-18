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

Keep the server on loopback unless you provide TLS and access control.
Back up the entire data directory, including `.secret.key`, which is required to decrypt stored credentials.

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
