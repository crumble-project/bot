# OpenAPI integration for the bundled web UI

## Recommendation

Use `openapi-typescript` for generated types, `openapi-fetch` for HTTP, and `openapi-react-query` for TanStack Query integration.

Generate from this checkout's `openapi/openapi.json`. Ship the UI with the server that generated its contract. Do not download or pin a separate contract release for this bundled consumer.

This recommendation targets settings, provider configuration, and native-client pairing. It does not assume full native-client parity. The primary benefits are:

- One generated type file, rather than generated endpoint implementations and hooks for the entire API.
- Typed literal paths, parameters, bodies, and responses without maintaining handwritten API interfaces.
- A shared Fetch client for runtime bearer authentication, HTTP errors, and cancellation.
- Query options usable by both route loaders and React components.
- Explicit application-owned invalidation, without introducing a second cache or SDK abstraction.

These are design judgments, not benchmark results. Orval and Hey API are viable alternatives. Prefer Hey API if generated operation functions, runtime validators, or broad streaming support become central requirements. Prefer Orval if generated hooks and mock fixtures become a concrete requirement. [O1][O2][O3][R1][R2][H1][H2]

## Evidence and scope

Repository inspection used commit `22a8107ca38af2ca52d311bc91c83d6b212eb4fa` in `bot-web-ui`. Official documentation and upstream source were fetched on October 23, 2026. Upstream `main` source is moving evidence, not proof of behavior in a particular published package version.

No dependencies were installed, generators executed, application servers started, or credentials read. This report is the only authored change. Exact package compatibility and generated output remain untested.

### Verified repository facts

| Area | Finding | Local source |
| --- | --- | --- |
| Existing stack | Bun, Hono, Zod, and TypeScript; no React, TanStack Router, TanStack Query, or candidate generator in `package.json`. | [Package manifest](../../package.json) |
| Contract | OpenAPI `3.1.0`, contract version `1.6.0`, HTTP bearer security, stable operation IDs. | [OpenAPI document](../../openapi/openapi.json) |
| Source of truth | Route and response schemas generate deterministic contract artifacts without starting the server. | [Contract maintenance](../api-contract.md), [exporter](../../src/openapi.ts) |
| Checks | `openapi:check` compares generated artifacts byte-for-byte. `check` includes lint, format, typecheck, contract drift, and tests. | [Package manifest](../../package.json), [exporter](../../src/openapi.ts) |
| Authentication | `/health` is public. Middleware protects `/v1/*` with a supplied bearer token. This is not a browser login or refresh-token protocol. | [API handlers](../../src/api.ts) |
| Errors | `401` is `text/plain`; application errors generally use JSON containing `error`, with validation details where applicable. | [OpenAPI document](../../openapi/openapi.json), [API handlers](../../src/api.ts) |
| Provider settings | `GET /v1/providers`, `GET /v1/models`, and `PUT`/`DELETE /v1/providers/{provider}` already exist. | [OpenAPI document](../../openapi/openapi.json) |
| Provider secrets | Provider listing returns configuration status, not saved API keys. The write endpoint accepts `apiKey`; model listing refreshes the provider catalog. | [API handlers](../../src/api.ts) |
| Pairing | No pairing, token-issuance, or token-refresh operation appears in the inspected OpenAPI paths. Push device registration is not pairing. | [OpenAPI document](../../openapi/openapi.json) |
| Streams | HTTP responses describe `text/event-stream` as strings, with payload references in `x-sse-events`. | [OpenAPI document](../../openapi/openapi.json) |

The contract maintenance document is partly stale: it describes four artifacts and two streaming endpoints. The exporter now emits OpenAPI plus five event schemas, including group chat and desktop control. Use the current exporter and contract when implementing. This research did not change that document.

Pairing remains a product/API decision. A generator cannot supply missing pairing semantics. The inspected bot contract does not establish the native clients' QR format, discovery behavior, or credential-transfer protocol. Those details are UNKNOWN here.

## Candidate comparison

The following capabilities come from current official documentation unless marked as a recommendation or unknown.

| Concern | OpenAPI TypeScript stack | Orval | Hey API |
| --- | --- | --- | --- |
| Output | Schema-derived TypeScript types; shared runtime wrappers. | Endpoint functions, models, hooks, and query helpers; configurable file layout. | Types, SDK functions, Fetch client, and TanStack Query option/key factories. |
| Query integration | `queryOptions`, query hooks, and mutation hooks. | Generated hooks and options/key helpers. | Generated query, infinite-query, and mutation options for TanStack Query v5. |
| Authentication | Request middleware reads the current token. | Custom Fetch mutator or transport configuration. | Runtime `auth` callback, plus interceptors; generated security controls which operations receive auth. |
| Keys | Method, schema path, and request initialization options. | Generated key helpers, typically based on the resolved path and parameters. | Normalized SDK parameters and metadata, including operation ID and base URL; optional tags. |
| Invalidation | Application chooses affected queries. | Application uses generated key helpers. | Application uses generated key factories or optional tags. |
| HTTP errors | Fetch returns `data`/`error`/`response`; Query wrapper throws the error payload. | Fetch documentation returns status-bearing response unions; configure throwing behavior for Query. | Typed errors and configurable `throwOnError`; inspect generated Query transport behavior. |
| Cancellation | Upstream Query wrapper forwards Query's `signal` to Fetch. | Current query examples forward `signal`; a custom mutator must preserve it. | Fetch accepts Fetch options; exact generated Query signal forwarding was not independently verified here. |
| Runtime validation | Type generation does not validate response data. | Supports Zod schema output and custom client behavior. | Validator plugins integrate with generated clients. |
| Streaming | `parseAs: "stream"` exposes the body; framing and event validation remain separate. | No verified handling of Crumble's `x-sse-events` in the reviewed docs. | Generates SSE streams for `text/event-stream`; extension-specific typing remains unverified. |
| Fit here | Recommended: least generated runtime code for a small settings UI. | More generated surface than this scope needs. | Strongest alternative if SDK generation or validation becomes important. |

Sources: [O1][O2][O3][O4][O5][O6][R1][R2][R3][R4][H1][H2][H3][H4].

### Important documentation distinctions

Orval's current Fetch guide and configuration reference say Fetch is the default transport for query clients. Its React Query guide still includes an Axios example. Do not infer an Axios requirement from that example. Explicitly configure the transport if selecting Orval. [R1][R2][R4]

Hey API's Fetch client is generated through a plugin. Its migration guide says client packages have been bundled since `0.73.0`; a separate `@hey-api/client-fetch` dependency is unnecessary. Its current introduction recommends exact generator version pins because the package remains in initial development. That is a tool version pin, not a separate contract release pin. [H2][H3][H4]

The OpenAPI TypeScript documentation describes keys as `[method, path, params]`. Current source stores the entire `init` object as the third element, or omits it when absent. This matters for credentials and cache identity. Use the library's returned `queryKey` for exact matching. [O3][O5]

## Local contract pipeline

This section recommends a future implementation; these commands and scripts were not added or executed.

Keep the existing contract publication and compatibility process for independently released native clients. The bundled UI consumes the local artifact directly, without a release download, checksum bundle, or consumer contract-version constant.

1. Update server schemas and handlers together.
2. Run `bun run openapi:generate`.
3. Generate the UI's type file with the locally installed, locked `openapi-typescript` executable.
4. Commit contract artifacts and generated UI types with the corresponding source changes.
5. Check contract drift before checking generated UI type drift in CI.
6. Run UI typechecking, existing checks, and the UI production build before packaging the server.

Proposed scripts, with a proposed output path rather than an existing UI directory:

```json
{
  "web:api:generate": "openapi-typescript openapi/openapi.json -o web/src/api/schema.d.ts",
  "web:api:check": "openapi-typescript openapi/openapi.json -o web/src/api/schema.d.ts --check"
}
```

The official CLI documents local schema input, output selection, and an up-to-date check. Verify the exact flags against the selected locked version before implementation. [O7]

Recommended CI order:

1. Run `bun run openapi:check`.
2. Run `bun run contract:validate`.
3. Run the proposed `bun run web:api:check`.
4. Run existing lint, format, typecheck, and unit-test checks, plus UI-specific checks and build.

Avoid regenerating before a CI drift check, which would conceal stale committed output. `bun run check` already includes the contract drift check; avoid duplicating expensive work when integrating scripts.

Pin generator and runtime package versions through the existing Bun dependency workflow and lockfile. Tool reproducibility does not require pinning the bundled UI to a published contract release. Local contract changes still follow the repository's existing version and changelog policy for external clients.

Generation must use local files, not the running server or a remote registry. Never import server handler modules into browser code merely to obtain types. Keep generated types as type-only imports. Existing runtime business rules remain server-owned; TypeScript cannot represent every provider availability or cross-field constraint.

Keep push/PR unit-test jobs within the repository's two-minute limit. Measure duration when implementation changes CI; this report makes no timing claim.

## Bearer authentication and secret handling

Recommended design:

- Use a same-origin API base URL for the bundled application, supplied at runtime. Contract paths already include `/v1`; do not append it twice.
- Read the current token inside `openapi-fetch` request middleware. Attach `Authorization: Bearer TOKEN` only to the expected API origin and protected routes.
- Keep tokens out of query keys, route search parameters, logs, generated code, and build-time environment substitutions.
- Hold the token in memory by default. Persistent browser storage requires a separate threat-model decision because browser scripts can read it.
- On logout or credential change, cancel outstanding requests and discard the authenticated Query cache before enabling new queries.
- Do not invent automatic refresh: no refresh endpoint exists in the inspected contract.
- Handle `401` centrally using the response status, stop authenticated loading, and request credentials again.

Middleware supports request-time token lookup and response inspection. It avoids putting a bearer header into per-query `init`, which current source includes in the cache key. [O4][O5]

Use one Query client per authenticated server context. The default keys do not automatically include the Fetch client's base URL or token. Sharing a cache across servers or credentials can return another context's data.

Provider keys are distinct from the server bearer token. Submit provider keys only to the provider write endpoint, then clear the form. Do not persist or log mutation variables. Query mutations can retain variables, so clear completed sensitive mutations rather than assuming a cleared input removes every copy.

For native-client pairing, distinguish a QR payload containing an existing credential from a short-lived pairing exchange. The former transfers the credential's authority; it is not device-scoped authentication. A short-lived exchange requires a specified backend protocol before client generation. Do not expose the server's configured bearer token automatically in HTML or JavaScript assets.

## Query ownership and invalidation

TanStack Query owns server state. Router coordinates when data loads. Use the same `queryOptions` factory in loaders and components, with the same Query client in router context. This avoids duplicate caches and mismatched keys. [O3][T1]

For example, define provider-list options from `$api.queryOptions("get", "/v1/providers")`. A route loader can pass those options to the selected Query version's cache-loading API; the component uses those same options with `useQuery`.

Recommended invalidation rules:

| Successful mutation | Queries to invalidate | Reason |
| --- | --- | --- |
| Provider key write or delete | `["get", "/v1/providers"]` and `["get", "/v1/models"]` prefixes | Configuration status and available models can change. The prefix covers filtered and unfiltered model queries. |
| MCP server create, update, delete, or OAuth state change | `["get", "/v1/mcp-servers"]` prefix | Integration configuration and authentication state can change. |
| Future pairing exchange | Only the specified pairing/device-status queries | No current pairing query exists to invalidate. |

Await invalidation when the UI must show refreshed status before completing a save. Do not automatically retry credential-changing mutations. Avoid optimistic provider configuration status: accepting a stored key does not prove that provider authentication succeeds.

No candidate can infer these domain relationships reliably from this contract. Generated keys remove duplication, but application code must decide which resources a mutation affects.

## Cancellation and errors

### Verified behavior

Current `openapi-react-query` source forwards the Query `AbortSignal` to the Fetch call. A supplied `init.signal` can override it because initialization options are spread afterward. Avoid supplying a different signal through query initialization options. [O5]

TanStack Query cancellation only aborts the transport when the query function consumes its signal. Its v5 documentation explicitly excludes Suspense hooks from cancellation support. Do not promise cancellation merely because a route uses a Suspense query. Aborting a mutation request does not roll back server work. [T2]

Current `openapi-fetch` source reads unsuccessful responses as text, attempts JSON parsing, and retains plain text when parsing fails. That matches Crumble's mix of JSON application errors and plain-text `401` responses. Its Query wrapper throws the payload, not an `Error` containing response status. [O5][O6]

### Recommended application policy

Treat values reaching error boundaries as `unknown`. Handle documented JSON error objects, strings, network failures, aborts, malformed responses, and unexpected proxy responses. Do not assume `error.message`, `error.error`, or a generated error union covers every runtime failure.

Inspect HTTP status in response middleware before the Query wrapper discards the `Response`. If status-aware retry or UI behavior needs a typed exception, define a small HTTP error boundary with status and an unknown payload. Narrow the payload before use; do not falsely cast the exception to the generated error type.

Current upstream source has an additional edge case: an empty unsuccessful body produces `error: undefined`, while the Query wrapper tests `if (error)`. Add a status-based guard for unsuccessful empty responses in the future integration. Recheck this behavior against the selected release, then verify it with an external-boundary fixture. [O5][O6]

For Orval, do not copy the custom-client example unchanged: it calls `response.json()` without checking status. Query functions must reject failed requests. A chosen mutator must preserve signals, handle text and empty responses, and expose a truthful error type. [R2][R3]

For Hey API, verify generated error throwing and signal forwarding against the selected release. The docs establish typed errors, interceptors, and `throwOnError`, but no generator was run against Crumble during this research. [H1][H2][H4]

## Streaming boundaries

Settings and provider configuration need ordinary HTTP queries and mutations. Do not build chat or desktop streams just to achieve native-client parity.

If live status becomes necessary, keep the streaming transport separate from ordinary Query fetches:

- Use authenticated Fetch streaming, not native `EventSource`, which provides no custom authorization-header option. [T3]
- With `openapi-fetch`, `parseAs: "stream"` returns the body without parsing SSE frames. Implement framing, cancellation, reconnection, and event validation separately. [O6][O8]
- Use the emitted JSON Schema assets for event payload validation and type generation. Do not treat a raw stream or OpenAPI string response as a typed event union.
- Process heartbeats and unknown event names without disrupting updates. The inspected streams send heartbeats every 15 seconds.
- Do not assume durable replay: the documented chat and activity streams lack `Last-Event-ID` replay. Fetch a fresh chat snapshot after reconnecting.
- Update or invalidate existing Query entries from validated events; do not put an indefinitely open stream into a normal JSON query.

The local maintenance document explicitly warns that standard generators might ignore `x-sse-events`. Hey API does support SSE generation, introduced in `0.81.0`, so claiming all three options lack streaming support would be incorrect. However, support for Crumble's custom extension and named-event payload mapping is UNKNOWN. Its transport support does not establish correct event typing for this contract. [H4]

## Remaining verification

Before adopting dependencies, verify these points in a small implementation:

- Generation and typechecking against Crumble's actual OpenAPI 3.1 document, including nullable unions and open JSON values.
- Compatibility with the repository's Bun and TypeScript versions and the selected React/Query versions.
- Authenticated HTTP errors: plain-text `401`, JSON errors, empty errors, malformed responses, and `204` mutations.
- Query cancellation with the selected non-Suspense integration.
- Provider/model invalidation, credential changes, and absence of tokens in cache keys.
- Browser credential bootstrap and native-client pairing requirements.
- Generated output size, production bundle size, and CI duration. No measurements were performed here.

These checks do not change the recommendation. They bound what has been established through source and documentation review rather than execution.

## Sources

### OpenAPI TypeScript

- [O1: OpenAPI React Query introduction](https://openapi-ts.dev/openapi-react-query/).
- [O2: OpenAPI Fetch introduction](https://openapi-ts.dev/openapi-fetch/).
- [O3: Query options](https://openapi-ts.dev/openapi-react-query/query-options).
- [O4: Middleware and authentication](https://openapi-ts.dev/openapi-fetch/middleware-auth).
- [O5: Current Query wrapper source](https://github.com/openapi-ts/openapi-typescript/blob/main/packages/openapi-react-query/src/index.ts).
- [O6: Current Fetch client source](https://github.com/openapi-ts/openapi-typescript/blob/main/packages/openapi-fetch/src/index.js).
- [O7: TypeScript generator CLI](https://openapi-ts.dev/cli).
- [O8: Fetch API reference](https://openapi-ts.dev/openapi-fetch/api).

### Orval

- [R1: React Query integration](https://orval.dev/docs/guides/react-query/).
- [R2: Fetch client](https://orval.dev/docs/guides/fetch-client/).
- [R3: Custom HTTP client](https://orval.dev/docs/guides/custom-client/).
- [R4: Output configuration](https://orval.dev/docs/reference/configuration/output/).

### Hey API

- [H1: TanStack Query plugin](https://heyapi.dev/docs/openapi/typescript/plugins/tanstack-query).
- [H2: Fetch client](https://heyapi.dev/docs/openapi/typescript/clients/fetch).
- [H3: Introduction and versioning](https://heyapi.dev/docs/openapi/typescript/get-started).
- [H4: Migration history, including SSE and bundled clients](https://heyapi.dev/docs/openapi/typescript/migrating).

### TanStack and browser APIs

- [T1: Router external data loading](https://tanstack.com/router/latest/docs/framework/react/guide/external-data-loading).
- [T2: Query v5 cancellation](https://tanstack.com/query/v5/docs/framework/react/guides/query-cancellation).
- [T3: Browser EventSource constructor](https://developer.mozilla.org/en-US/docs/Web/API/EventSource/EventSource).
