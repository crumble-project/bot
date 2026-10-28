# Shared API contract distribution

> Superseded for bot contract distribution. See [API contract maintenance](../api-contract.md) for the current workflow. Client repositories have not been migrated.

`bot` owns and distributes the HTTP and SSE API contract from its route and response Zod schemas. `spec` holds authored specifications and links to `bot` releases.

## Decisions

- **Independent semantic versioning:** `info.version` in `src/api-contract.ts` versions the contract independently of the server package. Breaking HTTP or SSE changes require a new major version; adding an event schema file is minor-compatible.
- **Immutable release bundles (`contract-vX.Y.Z`):** Published from `main` after `oasdiff` compatibility and `ajv`/OpenAPI validation pass. Each bundle contains `openapi.json`, all exported SSE JSON Schemas (`*.schema.json`), `CHANGELOG.md`, `source-commit.txt`, and `SHA256SUMS`.
- **Committed client generation:**
  - **Apple (`apple/apfelkern`):** Uses pinned Apple Swift OpenAPI Generator CLI (`1.14.2`) and a repository-owned `URLSession` `ClientTransport` that preserves per-operation timeouts and SSE streaming. `apple/macos` and `apple/ios` depend on `../apfelkern` by path.
  - **Android (`android`):** Uses a repository-owned, zero-dependency Python generator (`scripts/generate-contract.py`) targeting `kotlinx.serialization` and `HttpTransport` to support nullable unions and open `JsonElement` fields that standard Kotlin generators omit.
- **Verification and automated PRs:** Both client repositories verify payload checksums and byte-for-byte regeneration in CI and run weekly workflow jobs that open verified update PRs when a new `contract-vX.Y.Z` release is published.
