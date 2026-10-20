# Shared API contract distribution

Bot owns and distributes the API contract. Its route and response Zod schemas remain the source of truth. The spec repository contains only authored specifications and links to bot releases.

## Version and release the contract

The contract uses independent semantic versions in OpenAPI `info.version`, initially `1.0.0`. Server package versions do not select contract versions. Breaking changes require a higher major version. A server remains compatible with installed clients within that major version.

Publish `contract-vX.Y.Z` from `main` only after validation succeeds. Each release contains `openapi.json`, `chat-snapshot.schema.json`, `activity-event.schema.json`, `heartbeat.schema.json`, `SHA256SUMS`, `CHANGELOG.md`, and `source-commit.txt`. Checksums cover every payload asset, including provenance and the changelog excerpt, but not the checksum file itself. The tag targets the source commit. Never replace a published contract's assets.

Select the latest published, non-draft, non-prerelease `contract-v*` release, independently of unrelated server releases. Before the first contract release, report that compatibility checking is skipped. Authentication, download, parsing, and validation errors must fail rather than masquerade as an absent baseline.

CI uses oasdiff for HTTP compatibility and compares event schemas as response schemas through a temporary OpenAPI projection. This applies response compatibility rules to published events instead of treating them as requests. Reports remain available when checks fail. Changes without a major bump fail. Contract changes also require a version change, even when compatible.

## Export event schemas

Use Zod 4's native `z.toJSONSchema` with the JSON Schema 2020-12 target and output semantics. Export the existing snapshot, activity union, and heartbeat schemas in the same command as OpenAPI. Do not infer event shapes from examples or create a second hand-written schema.

Keep additional response properties open for forward compatibility within a major version. Provider-defined content remains JSON, not an invented fixed type. The exported schemas describe payloads; SSE framing, authentication, reconnect behavior, and heartbeat handling remain documented separately.

## Generate the Swift client once

Use Apple's Swift OpenAPI Generator CLI `1.14.2` in apfelkern, Swift OpenAPI Runtime `1.13.2`, and URLSession transport `1.3.2`. Commit generated types and operations. Generation is an explicit maintenance command, not a SwiftPM build plugin. Desktop and iOS consume apfelkern; neither runs a generator.

Keep `APIClient` as the app-facing boundary. Generated operations handle path parameters, requests, and typed responses. The boundary retains runtime connection settings, bearer authentication, cancellation, timeouts, bounded error bodies, and user-facing error mapping. Domain and presentation helpers remain separate from generated wire models.

For events, project the downloaded JSON Schemas into generator input components. Generate payload types with the same pinned CLI. A small streaming adapter handles SSE frames and decodes payloads into those generated types. Unknown event names and heartbeats do not interrupt chat updates. No build fetches contracts or generates code.

## Generate the Android client

Android currently uses an injectable `HttpTransport` backed by `HttpURLConnection`, Kotlin coroutines, and `kotlinx.serialization`. Use a versioned, repository-owned Python generator without external dependencies. It generates typed Kotlin operations and serializable wire models directly from the pinned OpenAPI and event schemas. Preserve open JSON as `JsonElement`, never `Any`, and fail on unsupported schema constructs.

OpenAPI Generator's Kotlin generator `7.26.0` was considered with custom transport templates. Its official feature table marks null, unrestricted values, and union composition unsupported. This contract uses all three. Templates cannot reliably recover schema semantics discarded by the generator's model. A small generator for the contract's supported subset avoids adding OkHttp or Ktor and preserves nullable and event-union behavior. The cost is maintaining and reviewing that generator when the contract introduces new schema constructs.

Commit output and regenerate explicitly. Reuse the same schema projection for SSE payload types. Keep frame parsing and stream lifetime in the existing transport adapter. Preserve cancellation, attachment timeouts, bearer authentication, and error mapping.

## Pin and update consumers

Apfelkern and Android each store contract assets, a manifest identifying their source and version, and checksums. Their updater accepts either a release tag or an explicit local export directory. It verifies all checksums before generation and runs the repository's tests. Generation checks reproduce output in a temporary directory and compare it byte-for-byte, rejecting stale output and manual edits.

Until the first release exists, pin a local bot export with matching checksums and source commit. After bot publishes `contract-v1.0.0`, run both updaters against that release and review the resulting pin changes. Never silently treat a local export as a published release.

Scheduled update workflows use `GITHUB_TOKEN`, validate generated output, and run tests themselves before opening or updating a PR. Use read-only permissions for ordinary CI and narrowly scoped write permissions for the updater. Public contributions require no deployment credentials, signing account, private package access, or Firebase configuration. If repository policy disallows workflow-created PRs, the owner must enable it; implementation does not change that setting.

Desktop and iOS pin the reviewed apfelkern commit. During desktop verification use `swift package edit apfelkern --path ../apfelkern`, then unedit before committing. Do not commit local overrides.

## Merge and bootstrap

1. Merge bot and let its release workflow publish the first contract.
2. Switch apfelkern and Android from their local pins to `contract-v1.0.0`, regenerate, and verify before merging.
3. Merge apfelkern before desktop and iOS. Update app pins to the merged, reviewed apfelkern commit.
4. Merge spec independently after the owner establishes its initial base branch. An empty repository cannot accept a PR without that base.

No contract is published to spec. No deployment, live server, signing key, or production host participates in generation or tests.

## Sources and alternatives

- [Swift OpenAPI Generator](https://github.com/apple/swift-openapi-generator) provides the CLI and generated operations. A build plugin would violate the committed-output decision.
- [Swift OpenAPI Runtime](https://github.com/apple/swift-openapi-runtime) and [URLSession transport](https://github.com/apple/swift-openapi-urlsession) retain Foundation networking.
- [Kotlin generator options and supported features](https://openapi-generator.tech/docs/generators/kotlin/) document the unsupported null and union constructs. Custom templates were rejected because they cannot repair unsupported model semantics. Default Ktor or OkHttp output would also add an unnecessary networking migration.
- [Zod JSON Schema conversion](https://zod.dev/json-schema) avoids introducing a separate Zod-to-schema library.
- [oasdiff](https://github.com/oasdiff/oasdiff) provides direction-aware response compatibility checks. Raw schema text diffs cannot establish compatibility.
- [GitHub workflow triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) currently document approval-required runs for some PR events created with `GITHUB_TOKEN`. Updaters run their own checks regardless.
- [GitHub releases API](https://docs.github.com/en/rest/releases/releases) documents release selection and asset publication.

Bot pins official oasdiff `1.34.0`, Swagger Parser `13.1.0`, and Ajv `8.20.0`. The workflow verifies the official oasdiff archive against a committed SHA-256. JSON breaking reports are parsed only after a successful checker process; nonzero checker exits never become an allowed major-version change. Zod `4.6.7` exports event schemas with `target: "draft-2020-12"` and `io: "output"`.

The Android generator's own version is recorded with its implementation. Swift versions were verified against the official release APIs and generator documentation. A tool upgrade requires regeneration and review.
