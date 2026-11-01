# Contributing to Crumble

Contributions to `bot` are accepted under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).

For architecture details and feature-specific guides, see the [Contributing documentation](https://docs.crumbli.ng/contributing) ([`apps/docs/content/contributing/`](apps/docs/content/contributing)).

## Prerequisites

- **Bun:** exact version in [`.bun-version`](.bun-version) (enforced by Git hooks and CI).
- **oasdiff `1.35.0`:** on `PATH` for OpenAPI compatibility checks in `pre-push`.
- **Workspaces (optional):** Apple silicon on macOS or `/dev/kvm` on Linux for Microsandbox workspaces, or a Railway token and environment ID for Railway sandboxes.

## Repository layout

`bot` is a Bun workspace for the server and web UI, with standalone lockfiles for the documentation site and landing page so their dependencies stay out of the server install and Docker image:

| Path                           | Contents                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `apps/server/src/`             | Server feature modules (`bots/`, `jobs/`, `workspaces/`, etc.) with colocated `*.test.ts` files |
| `apps/server/drizzle/`         | SQLite migrations for `store.sqlite` and `push.sqlite`                                          |
| `apps/server/skills/`          | Bundled default skills                                                                          |
| `apps/server/workspace-image/` | Dockerfile and desktop scripts for workspace images                                             |
| `apps/web/`                    | Web UI, grouped by feature and bundled by the server                                            |
| `apps/docs/`                   | User and contributor docs at [docs.crumbli.ng](https://docs.crumbli.ng)                         |
| `apps/site/`                   | Landing page at [crumbli.ng](https://crumbli.ng)                                                |
| `openapi/`                     | Generated OpenAPI 3.1 spec and SSE event JSON Schemas                                           |
| `GLOSSARY.md`                  | Canonical product and domain terminology                                                        |

## Local setup and checks

Install dependencies and start the server with file watching:

```bash
bun install
bun run dev
```

Run checks and formatting from the repository root:

```bash
bun run check   # Agents path check, lint, format check, typecheck, OpenAPI drift, and unit tests
bun run fix     # Format with bun fmt and apply oxlint fixes
```

`apps/docs` and `apps/site` have their own lockfiles, so install their dependencies before checking them:

```bash
cd apps/docs && bun install && bun run check && bun run build
cd apps/site && bun install && bun run build
```

## Git hooks

`bun install` configures Git to use [`.githooks/`](.githooks). Skip a hook once with `--no-verify`.

- **`pre-commit`:** checks the Bun version, regenerates and stages `openapi/` artifacts from staged contract files, runs `agents:check`, `lint`, `format:check`, and `typecheck` on the whole tree, and runs `fallow audit` on changes since `HEAD`.
- **`commit-msg`:** rejects a commit whose subject isn't a Conventional Commit. Merge, revert, `fixup!`, `squash!`, and `amend!` commits that Git writes are allowed.
- **`pre-push`:** refuses the push if the working tree has uncommitted or untracked files, or if the pushed branch isn't checked out. It then runs the full PR suite against `origin/main`: `bun install --frozen-lockfile`, `bun run check`, `contract:validate`, `oasdiff validate`, `contract:compatibility`, `fallow audit`, and `apps/docs` / `apps/site` builds when those directories changed.

## Conventions

- **Terminology:** follow [`GLOSSARY.md`](GLOSSARY.md). When a word in the docs or UI and a word in the code disagree, the glossary wins.
- **Effect:** server code uses [Effect](https://effect.website). Read [`AGENTS.md`](AGENTS.md) and `apps/server/node_modules/effect/AGENTS.md` before writing Effect services or layers.
- **Tests:** keep unit tests next to the module they test (`*.test.ts`). The unit test suite in CI must finish in two minutes or less.
- **Documentation:** when a change alters behavior, settings, endpoints, or UI labels described in the docs, update the matching page in [`apps/docs/content/`](apps/docs/content) in the same pull request and run `bun run check` in `apps/docs`.

## Database migrations

Store tables live in each feature's `schema.ts` or `schema.<part>.ts` under `apps/server/src/`; [`drizzle.store.config.ts`](apps/server/drizzle.store.config.ts) finds new files automatically. Push tables live in `apps/server/src/push/schema.ts`. Edit the schema, then generate the migration:

```bash
bun run --cwd apps/server db:generate --name short_description       # store.sqlite
bun run --cwd apps/server db:generate:push --name short_description  # push.sqlite
```

## API contract

Route and SSE schemas in `apps/server/src/contract/` generate everything in [`openapi/`](openapi). After changing a route or event schema:

```bash
bun run openapi:generate                           # Regenerate openapi/
bun run contract:validate                          # Validate OpenAPI and JSON Schemas offline
bun run contract:compatibility BASELINE_DIRECTORY  # Check compatibility against a baseline OpenAPI directory
```

## Commit messages

Only [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) are accepted, for commit messages and pull request titles:

```text
<type>(<scope>): <description>
```

- **Types:** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, or `chore`.
- **Scope:** optional; name the affected area when it helps, such as `web`, `skills`, or `gateway`.
- **Description:** lowercase and imperative, preferably under 72 characters.
- **Breaking changes:** add `!` after the type or scope and explain the break in the commit body.

The `commit-msg` hook checks each commit, and the PR title workflow checks pull request titles. Both use [`.githooks/check-conventional-commit.sh`](.githooks/check-conventional-commit.sh).

## Pull requests

1. Fill in the [pull request template](.github/pull_request_template.md). Pull requests are squash-merged with their title as the commit subject, so the title must follow the commit message format and summarize the whole branch.
2. Keep each pull request focused on one change.
3. Include tests for new behavior and bug fixes, and update [`apps/docs`](apps/docs) when user-facing behavior changes.
4. Make sure `bun run check` passes before opening or updating the pull request.
