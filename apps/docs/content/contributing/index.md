---
title: Contributing
description: How features get proposed and built, how the server repository is laid out, and which checks to run.
sidebar:
  order: 1
---

Crumble is split across repositories in [`crumble-project`](https://github.com/crumble-project). The server and web app live in `bot`. Specifications and the [glossary](/reference/glossary) live in `spec`.

## Propose a feature

New user-visible features go through [`crumble-project/spec`](https://github.com/crumble-project/spec/blob/main/features/README.md) before any code is written:

1. **Idea:** open an issue in `spec`.
2. **Draft:** write `features/NNNN-short-name.md`, and add any new terms to `spec/GLOSSARY.md`.
3. **Accepted:** the owner approves the specification. Don't build from a draft.
4. **Build:** implement it in `bot`, update the API contract if routes or events changed, and check every acceptance criterion.

See [Specifications](/contributing/specifications) for the existing ones.

## Repository layout

`bot` is a Bun workspace:

| Path                           | Contents                                                 |
| ------------------------------ | -------------------------------------------------------- |
| `apps/server/src/`             | Server feature modules, with tests next to the code.     |
| `apps/server/drizzle/`         | SQLite migrations for the product store.                 |
| `apps/server/skills/`          | Default skills that ship with the server.                |
| `apps/server/workspace-image/` | Dockerfile and desktop scripts for workspace images.     |
| `apps/web/`                    | The web app, grouped by feature.                         |
| `apps/docs/`                   | This documentation site, built with Blume.               |
| `apps/site/`                   | The landing page at crumbli.ng.                          |
| `openapi/`                     | The generated OpenAPI contract and event stream schemas. |

Server code uses [Effect](https://effect.website). Read `apps/server/AGENTS.md` before changing it. See [Architecture](/contributing/architecture) for how the pieces fit.

## Run the checks

From the `bot` root:

```bash
bun run check   # lint, format check, typecheck, contract drift, and unit tests
bun run fix     # format and apply lint fixes
```

`bun install` sets up Git hooks: commits run lint and typecheck, and pushes run `check`. Unit test jobs in CI must finish in two minutes or less.

## Change the API contract

Route and event schemas in `apps/server/src/contract/` generate everything in `openapi/`. After changing them:

```bash
bun run openapi:generate        # regenerate openapi/
bun run contract:validate       # validate the OpenAPI and JSON Schemas offline
bun run contract:compatibility  # compare against the latest contract-vX.Y.Z release
bun run contract:bundle         # export a checksummed release bundle
```

`bun run openapi:check` fails if the generated files are out of date. `bun run check` runs it for you.
