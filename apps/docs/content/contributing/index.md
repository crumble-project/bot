---
title: Contributing
description: How the server repository is laid out, which checks to run, and how to release.
sidebar:
  order: 1
---

Crumble is split across repositories in [`crumble-project`](https://github.com/crumble-project). The server and web app live in `bot`. So does the canonical glossary, `GLOSSARY.md`, which the [glossary](/reference/glossary) page copies.

The server and web app are licensed under the [GNU Affero General Public License v3.0](https://github.com/crumble-project/bot/blob/main/LICENSE) (`AGPL-3.0-only`). Contributions to `bot` are accepted under the same license.

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

## Release

`apps/server/package.json` holds the version. A release publishes `crumble-server`, `crumble-workspace`, and `crumble-workspace-desktop` with the same version, so a server and its workspace images always match.

1. In one pull request:
   - set `version` in `apps/server/package.json`
   - rename `## Unreleased` in `CHANGELOG.md` to `## X.Y.Z`, and add a new empty `## Unreleased` above it
   - update the image tags in `README.md` and `apps/docs`
2. Squash-merge it.
3. Tag the merge commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The Server image and Workspace images workflows publish `X.Y.Z` and `latest` for each image. The server workflow fails if the tag doesn't match `apps/server/package.json`. Every push to `main` also publishes `main` and `sha-…` tags.
