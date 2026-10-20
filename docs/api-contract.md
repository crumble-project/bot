# API contract maintenance

Bot owns and distributes the API contract. Route and response Zod schemas are its source of truth.
The contract version is independent of the server package version. Its initial version is `1.0.0`.
The spec repository contains authored specifications, not generated contract assets.

## Source files

- `src/api-contract.ts` defines routes, operation IDs, bearer security, requests, errors, and `info.version`.
- `src/api-responses.ts` defines responses, snapshots, the discriminated activity union, and heartbeats.
- `src/domain.ts` and `src/attachments.ts` provide shared request schemas.
- `src/api.ts` binds shared route definitions to handlers and reuses runtime request validation.
- `src/openapi.ts` exports four deterministic artifacts without starting the server or accessing credentials, provider catalogs, or databases.
- `src/contract-release.ts` validates artifacts, checks compatibility, and publishes releases through the main workflow.

Route registration uses `@hono/zod-openapi` without installing automatic validators.
Existing parsers preserve JSON errors, content-type acceptance, and PATCH validation after merging stored values.
OpenAPI doesn't express provider availability, ownership rules, or every cross-field refinement. Runtime validation still enforces those rules.

## Export the contract

Run the same command for HTTP and event artifacts:

```bash
bun run openapi:generate
bun run openapi:check
bun run contract:validate
```

| Artifact | Source |
| --- | --- |
| `openapi/openapi.json` | Shared route registry; OpenAPI 3.1 |
| `openapi/chat-snapshot.schema.json` | `chatSnapshotResponse` |
| `openapi/activity-event.schema.json` | `activityEvent`, the reply and chat-preview discriminated union |
| `openapi/heartbeat.schema.json` | `heartbeatEvent` |

The three event artifacts use Zod 4's native `z.toJSONSchema`, the `draft-2020-12` target, and `io: "output"`.
Response objects permit additional properties for forward compatibility. Typed dictionaries retain their value constraints.
Provider-defined transcript blocks, tool details, live progress, and usage remain open JSON values.
Nullable resource responses use explicit unions so named schema references also permit `null`.
Every path parameter is required, including coerced numeric parameters.

`bun run openapi:check` compares all four generated artifacts byte-for-byte and fails on drift.
`bun run check` includes this drift check. `bun run contract:validate` separately validates OpenAPI and compiles each event schema offline.
JSON Schema formats are annotations; structural validation doesn't enforce provider-specific formats.

## Change the contract

1. Update the schema and handler together.
2. Give new endpoints stable, unique operation IDs.
3. Increase `info.version` in `src/api-contract.ts` when any published artifact changes.
4. Use a higher major version for breaking HTTP or event changes.
5. Add a `## Contract X.Y.Z` section to `CHANGELOG.md` with consumer-facing changes.
6. Run `bun run openapi:generate` and `bun run check`.
7. Run `bun run contract:validate` and `bun run contract:compatibility`.
8. Commit the source and all four generated artifacts together.

Versions must be stable `MAJOR.MINOR.PATCH` values without leading zeros.
Servers must remain backward compatible with installed clients within the same major version.
Compatible changes still require a version increase. Documentation-only changes to a contract artifact also require an increase.

## Check compatibility

CI runs `bun run check`, validates OpenAPI and JSON Schema, and compares against the highest stable published `contract-vX.Y.Z` release.
Selection paginates all releases and excludes drafts, prereleases, and unrelated server releases.
Baseline downloads require all assets and valid checksums. The OpenAPI version must match the release tag.

Only a successful release listing with no stable contract release skips baseline comparison.
Authentication, network, download, parsing, schema, and checker failures fail CI.
No deployment credentials or provider keys are required. GitHub Actions uses its repository token with read-only permissions for checks.

The pinned official oasdiff CLI compares HTTP documents and event schemas separately.
Events become response schemas in temporary OpenAPI documents; request compatibility rules would have the wrong direction.
Any reported breaking change, including warnings, requires a higher major version.
The checker runs without `--fail-on` and its JSON findings determine compatibility, so process failures cannot be mistaken for permitted major changes.
External references are disabled. CI uploads projections and JSON reports from `contract-reports/`, including after a policy failure.

To compare local directories, replace `BASELINE_DIRECTORY` with a directory containing the four baseline artifacts:

```bash
bun run contract:compatibility BASELINE_DIRECTORY
```

Set `OASDIFF` to the executable path if it isn't on `PATH`.
Set `CONTRACT_DIR` to select candidate artifacts and `CONTRACT_REPORTS` to select report output.
Without a baseline argument, `gh` fetches releases from `GITHUB_REPOSITORY`, defaulting to `crumble-project/bot`.
Authenticate `gh` for that read operation when required. Errors don't fall back to an empty baseline.

## Export a local consumer bundle

Commit contract sources and artifacts before exporting a provenance bundle:

```bash
bun run contract:bundle
```

The command prints a fresh temporary directory. Pass a new directory as an argument to choose its location.
It refuses to overwrite payload files or export dirty contract inputs.
The directory contains exactly these release assets:

- `openapi.json`
- `chat-snapshot.schema.json`
- `activity-event.schema.json`
- `heartbeat.schema.json`
- `CHANGELOG.md`, containing only the current contract's changelog section
- `source-commit.txt`, containing the full source commit
- `SHA256SUMS`, covering every payload asset, including the changelog and provenance, but not itself

Consumers must verify every checksum before generating code.
A local bundle is a bootstrap pin, not a published release.
After `contract-v1.0.0` is published, update consumer pins to that release and regenerate.
Applications supply the server URL and bearer token at runtime; exported artifacts contain neither deployment hostnames nor credentials.

## Publish a release

`.github/workflows/contract.yml` publishes only after successful checks on a push to `main`.
The release job alone has `contents: write`; check jobs have `contents: read`.
It decides whether to publish from existing releases, not the previous commit's version.
The initial `1.0.0` release therefore publishes even when the preceding commit already has `1.0.0`.

A new `contract-vX.Y.Z` release starts as a draft targeting the explicit source commit.
The workflow uploads every asset, then publishes the draft. Existing tags must resolve to that source commit.
Published assets are never replaced. Repeating a completed release verifies its bundle and leaves it unchanged.
A retry resumes a draft only for the same source commit and verifies existing bytes before uploading missing assets.
A conflicting draft, asset, or tag fails instead of overwriting it. Release jobs run serially.
A failed draft for another source commit requires owner review; the workflow doesn't delete it.

The publishing command is restricted to the main push workflow. Don't invoke it during local development.
No release or tag is created by generation, validation, or compatibility commands.

## Handle server-sent events

OpenAPI describes streams as `text/event-stream` strings.
The `x-sse-events` extension maps event names to payload components, but standard generators might ignore it.
Generate event payload types from the standalone schemas and keep the streaming transport adapter separate.

| Endpoint | Event | JSON Schema asset |
| --- | --- | --- |
| `/v1/agents/{id}/events` | `snapshot` | `chat-snapshot.schema.json` |
| `/v1/agents/{id}/events` | `heartbeat` | `heartbeat.schema.json` |
| `/v1/events` | `activity` | `activity-event.schema.json` |
| `/v1/events` | `heartbeat` | `heartbeat.schema.json` |

Each event uses a JSON-encoded `data` field and a blank line:

```text
event: heartbeat
data: {}

```

Both streams require bearer authentication and send heartbeats every 15 seconds.
Unknown event names and heartbeats must not interrupt chat updates.
The server-wide stream replays chat previews on connection, but not completed replies.
Chat streams publish snapshots when state changes. Fetch `/v1/agents/{id}/chat` after reconnecting to recover the snapshot.
Neither stream supports `Last-Event-ID` replay. `/health` is unauthenticated; other endpoints require bearer authentication.

## Tool versions and references

- Bun `1.4.2` in CI, with the committed dependency lockfile.
- `@apidevtools/swagger-parser` `13.1.0` for [OpenAPI validation](https://apidevtools.com/swagger-parser/docs/swagger-parser.html).
- Ajv `8.20.0` for [JSON Schema 2020-12 validation](https://ajv.js.org/json-schema.html#draft-2020-12).
- Existing Zod `4.6.7` for [native schema conversion](https://zod.dev/json-schema).
- Official [oasdiff `1.34.0`](https://github.com/oasdiff/oasdiff/releases/tag/v1.34.0) for validation and [breaking-change JSON reports](https://github.com/oasdiff/oasdiff/blob/v1.34.0/docs/BREAKING-CHANGES.md).

The composite action pins the Linux AMD64 oasdiff archive's SHA-256.
GitHub Actions dependencies use immutable commit SHAs.
Review regenerated output and compatibility fixtures when upgrading tools.
Release selection and creation follow the [GitHub releases API](https://docs.github.com/en/rest/releases/releases).
Draft upload and publication use the [GitHub CLI release commands](https://cli.github.com/manual/gh_release).
