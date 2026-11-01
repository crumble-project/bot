# Crumble

Self-hosted AI bots with persistent memory, continuous chats, and isolated workspaces, built on Bun, SQLite, and Pi Durable.

Documentation lives at [docs.crumbli.ng](https://docs.crumbli.ng) ([`apps/docs`](apps/docs)).

## Quick start

Requires Bun (see [`.bun-version`](.bun-version)):

```bash
bun install
bun run dev
```

Open `http://127.0.0.1:7337/ui` to create an account. For Docker, workspaces, environment variables, and backups, see [Install the Server](https://docs.crumbli.ng/getting-started/server) and [Configuration](https://docs.crumbli.ng/self-hosting/configuration).

## Develop

```bash
bun run check   # Lint, format check, typecheck, contract drift, and unit tests
bun run fix     # Format and apply lint fixes
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [Contributing](https://docs.crumbli.ng/contributing) for repository layout, database migrations, API contract scripts, Git hooks, and releases.

## License

Licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
