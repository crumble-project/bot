# Contributing to Crumble

Thanks for helping with Crumble. Bug reports, documentation fixes, and code changes are all welcome, and you don't need to be an expert in the whole project to start.

Contributions to `bot` are accepted under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).

## Summary

1. [Find or open an issue](#choose-what-to-work-on).
2. [Fork the repository and start the server](#set-up-your-environment).
3. Create a branch, make one focused change, and add tests.
4. Run `bun run check`.
5. [Open a pull request](#submit-a-change) with a Conventional Commit title.

## Contents

- [Choose what to work on](#choose-what-to-work-on)
- [Report a bug](#report-a-bug)
- [Suggest a feature](#suggest-a-feature)
- [Get help](#get-help)
- [Set up your environment](#set-up-your-environment)
- [Repository layout](#repository-layout)
- [Submit a change](#submit-a-change)
- [Test your change](#test-your-change)
- [Conventions](#conventions)
- [Commit messages](#commit-messages)
- [Git hooks](#git-hooks)
- [Database migrations](#database-migrations)
- [API contract](#api-contract)
- [Recognition](#recognition)

## Choose what to work on

Start with the [open issues](https://github.com/crumble-project/bot/issues). Labels show where help fits and whether an issue is ready:

| Label                                                                                          | Meaning                                                  |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [`good first issue`](https://github.com/crumble-project/bot/labels/good%20first%20issue)       | A small task for newcomers.                              |
| [`help wanted`](https://github.com/crumble-project/bot/labels/help%20wanted)                   | Maintainers want help with this issue.                   |
| [`documentation`](https://github.com/crumble-project/bot/labels/documentation)                 | Improves the docs in `apps/docs`.                        |
| `area:*`, such as `area:web` and `area:backend`                                                | The part of the project that the issue affects.          |
| [`proposal`](https://github.com/crumble-project/bot/labels/proposal)                           | Needs review and a feasibility check before work starts. |
| `needs-design`, `blocked`                                                                      | Waits on a decision or a dependency.                     |

Comment on an issue before you start larger work, so that nobody duplicates it and the approach is agreed. Small fixes can go straight to a pull request.

## Report a bug

1. Search the [existing issues](https://github.com/crumble-project/bot/issues?q=is%3Aissue) for the same bug.
2. Fill in the [bug report form](https://github.com/crumble-project/bot/issues/new?template=bug_report.yml).

To report a security vulnerability, follow [`SECURITY.md`](SECURITY.md). Don't open a public issue for it.

## Suggest a feature

1. Search the [existing issues](https://github.com/crumble-project/bot/issues?q=is%3Aissue) for a similar idea.
2. Fill in the [feature request form](https://github.com/crumble-project/bot/issues/new?template=feature_request.yml).

## Get help

- Read the [documentation](https://docs.crumbli.ng) for setup, configuration, and API guides.
- Read the [contributor documentation](https://docs.crumbli.ng/contributing) for architecture details, feature-specific guides, and releases.
- Ask on the related issue or pull request.

## Set up your environment

You need:

- **Bun:** the exact version in [`.bun-version`](.bun-version). Git hooks and CI enforce it.
- **oasdiff `1.35.0`:** on your `PATH`, for the OpenAPI checks in `pre-push`.
- **Workspaces (optional):** Apple silicon on macOS or `/dev/kvm` on Linux for Microsandbox workspaces, or a Railway token and environment ID for Railway sandboxes.

To start the server:

1. [Fork the repository](https://github.com/crumble-project/bot/fork) and clone your fork.
2. Install dependencies and start the server with file watching:

   ```bash
   bun install
   bun run dev
   ```

3. Open `http://127.0.0.1:7337` and create an account.

## Repository layout

`bot` is a Bun workspace for the server and web UI, with standalone lockfiles for the documentation site and landing page so their dependencies stay out of the server install and Docker image:

| Path                           | Contents                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `apps/server/src/`             | Server feature modules such as `bots/` and `jobs/`, with colocated `*.test.ts` files |
| `apps/server/drizzle/`         | SQLite migrations for `store.sqlite` and `push.sqlite`                                          |
| `apps/server/skills/`          | Bundled default skills                                                                          |
| `apps/server/workspace-image/` | Guest manifest, Dockerfile, and desktop scripts for workspace images                            |
| `apps/web/`                    | Web UI, grouped by feature and bundled by the server                                            |
| `apps/docs/`                   | User and contributor docs at [docs.crumbli.ng](https://docs.crumbli.ng)                         |
| `apps/site/`                   | Landing page at [crumbli.ng](https://crumbli.ng)                                                |
| `openapi/`                     | Generated OpenAPI 3.1 spec and SSE event JSON Schemas                                           |
| `GLOSSARY.md`                  | Canonical product and domain terminology                                                        |

## Submit a change

1. Create a branch from `main`.
2. Make one focused change. Add tests for new behavior and bug fixes.
3. Update [`apps/docs`](apps/docs) if user-facing behavior changes, and add an entry under `## Unreleased` in [`CHANGELOG.md`](CHANGELOG.md).
4. Run `bun run check`, and run `bun run fix` for any formatting or lint errors.
5. Commit with a [Conventional Commit message](#commit-messages).
6. Sync your fork's `main` with `gh repo sync`, because `pre-push` compares your branch against `origin/main`.
7. Push your branch and open a pull request.
8. Fill in the [pull request template](.github/pull_request_template.md), including what you verified.

The title must follow the [commit message format](#commit-messages) and summarize the whole branch. Pull requests are squash-merged with their title as the commit subject.

To respond to review feedback, push more commits to the same branch. CI runs again on each push.

## Test your change

Unit tests sit next to the module they test, as `*.test.ts` or `*.test.tsx`. Shared test fixtures are in [`apps/server/test/fixtures/`](apps/server/test/fixtures).

```bash
bun run test         # All unit tests
bun test TEST_FILE   # One test file
bun run check        # Lint, format check, typecheck, OpenAPI drift, and unit tests
```

Replace `TEST_FILE` with the path to the test file.

A bug fix needs a test that fails before the fix and passes after it. Tests that need a VM or a Railway sandbox are skipped unless their environment is set up, so a skipped test doesn't mean that your change passed it.

`apps/docs` and `apps/site` have their own lockfiles, so install their dependencies before you check them:

```bash
cd apps/docs && bun install && bun run check && bun run build
cd apps/site && bun install && bun run build
```

## Conventions

- **Terminology:** follow [`GLOSSARY.md`](GLOSSARY.md). When a word in the docs or UI and a word in the code disagree, the glossary wins.
- **Effect:** server code uses [Effect](https://effect.website). Read [`AGENTS.md`](AGENTS.md) and `apps/server/node_modules/effect/AGENTS.md` before you write Effect services or layers.
- **Web UI components:** add shadcn components with `bun run ui:add`, as described in [`AGENTS.md`](AGENTS.md).
- **Formatting and lint:** `bun run fix` formats with `bun fmt` and applies `oxlint` fixes.
- **Test speed:** the unit test suite in CI must finish in two minutes or less.
- **Documentation:** when a change alters behavior, settings, endpoints, or UI labels described in the docs, update the matching page in [`apps/docs/content/`](apps/docs/content) in the same pull request and run `bun run check` in `apps/docs`.

## Commit messages

Only [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) are accepted, for commit messages and pull request titles:

```text
TYPE(SCOPE): DESCRIPTION
```

For example, `feat(web): add bot avatars`. Replace the placeholders as follows:

- **Types:** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, or `chore`.
- **Scope:** optional; name the affected area when it helps, such as `web`, `skills`, or `gateway`.
- **Description:** lowercase and imperative, preferably under 72 characters.
- **Breaking changes:** add `!` after the type or scope and explain the break in the commit body. A breaking API change also raises the major version of `info.version` in the contract, which is what lets the compatibility check pass.

The `commit-msg` hook checks each commit, and the PR title workflow checks pull request titles. Both use [`.githooks/check-conventional-commit.sh`](.githooks/check-conventional-commit.sh).

## Git hooks

`bun install` configures Git to use [`.githooks/`](.githooks). Skip a hook once with `--no-verify`.

- **`pre-commit`:** checks the Bun version, regenerates and stages `openapi/` artifacts from staged contract files, runs `agents:check`, `lint`, `format:check`, and `typecheck` on the whole tree, and runs `fallow audit` on changes since `HEAD`.
- **`commit-msg`:** rejects a commit whose subject isn't a Conventional Commit. Merge, revert, `fixup!`, `squash!`, and `amend!` commits that Git writes are allowed.
- **`pre-push`:** refuses the push if the working tree has uncommitted or untracked files, or if the pushed branch isn't checked out. It then runs the full PR suite against `origin/main`: `bun install --frozen-lockfile`, `bun run check`, `contract:validate`, `oasdiff validate`, `contract:compatibility`, `fallow audit`, and `apps/docs` / `apps/site` builds when those directories changed.

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
bun run contract:validate                          # Validate the JSON Schemas offline
bun run contract:compatibility BASELINE_DIRECTORY  # Check compatibility against a baseline OpenAPI directory
```

Replace `BASELINE_DIRECTORY` with the path to the OpenAPI directory that you compare against. The `pre-push` hook also validates `openapi/openapi.json` with `oasdiff`.

## Recognition

Your work appears in the [contributor list](https://github.com/crumble-project/bot/graphs/contributors). Thank you for improving Crumble.
