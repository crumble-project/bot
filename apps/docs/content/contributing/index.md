---
title: Contributing
description: How the server repository is laid out, which checks to run, and how to release.
sidebar:
  order: 1
---

Crumble is split across repositories in
[`crumble-project`](https://github.com/crumble-project). The server and the web
app live in `bot`. So does the canonical glossary, `GLOSSARY.md`, which the
[glossary](/reference/glossary) page copies. When a word in the docs and a word
in the code disagree, the glossary wins.

The server and web app are licensed under the
[GNU Affero General Public License v3.0](https://github.com/crumble-project/bot/blob/main/LICENSE)
(`AGPL-3.0-only`). Contributions to `bot` are accepted under the same license.

## Repository Layout

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

Server code uses [Effect](https://effect.website). Read `AGENTS.md`
before changing it. [Architecture](/contributing/architecture) shows how the
pieces fit.

## Running the Checks

From the `bot` root:

```bash
bun run check   # lint, format check, typecheck, contract drift, and unit tests
bun run fix     # format and apply lint fixes
```

`bun install` sets up the Git hooks in `.githooks/`. The commit and push
hooks require the Bun version in `.bun-version`, which CI also uses. Skip them once with
`--no-verify`:

| Hook           | Runs                                                                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit         | Generates and stages OpenAPI artifacts from staged sources, then runs the steering-file path check, lint, format check, and typecheck on the whole tree, and `fallow audit` on the changes since the last commit.                                                                       |
| Commit message | Rejects a commit subject that isn't a Conventional Commit, such as `feat(web): add bot avatars`. Pull request titles get the same check in CI.                                                                                                                                          |
| Push           | Runs the PR checks against the pushed commit and a freshly fetched `origin/main` (`bun install --frozen-lockfile`, `bun run check`, contract validation and compatibility, `fallow audit`, and `apps/docs` / `apps/site` when changed). Refuses dirty trees or un-checked-out branches. |

Unit test jobs in CI must finish in two minutes or less.

## Changing the Database Schema

Store tables live in each feature's `schema.ts` or `schema.<part>.ts`, which
`apps/server/drizzle.store.config.ts` finds automatically. Push tables live in
`apps/server/src/push/schema.ts`. Edit the schema, then generate the migration
from the `bot` root:

```bash
bun run --cwd apps/server db:generate --name short_description       # store.sqlite
bun run --cwd apps/server db:generate:push --name short_description  # push.sqlite
```

## Changing the API Contract

Route and event schemas in `apps/server/src/contract/` generate everything in
`openapi/`. After changing them:

```bash
bun run openapi:generate        # regenerate openapi/
bun run contract:validate       # validate the OpenAPI and JSON Schemas offline
bun run contract:compatibility BASELINE_DIRECTORY  # compare against a baseline OpenAPI directory
```

`bun run openapi:check` fails if the generated files are out of date, and
`bun run check` runs it for you.

## Releasing

`apps/server/package.json` holds the version. A release publishes
`crumble-server`, `crumble-workspace`, and `crumble-workspace-desktop` with the
same version, so a server and its workspace images always match.

1. In one pull request:
   - Set `version` in `apps/server/package.json`.
   - Rename `## Unreleased` in `CHANGELOG.md` to `## X.Y.Z`, and add a new
     empty `## Unreleased` above it.
   - Update the image tags in `apps/docs`.
2. Squash-merge it.
3. Tag the merge commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The Server image and Workspace images workflows publish `X.Y.Z` and `latest`
for each image. If the server workflow fails right away, check that the tag
matches the version in `apps/server/package.json`. Every push to `main` also
publishes `main` and `sha-…` tags.
