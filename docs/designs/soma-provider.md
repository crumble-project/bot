# Soma model backend provider

**Status:** approved

## Problem

Model credentials, OAuth logins (ChatGPT / Codex, Claude Code), and provider-specific quirks currently have to be configured and maintained inside Crumble separately from Axon and Glia. Soma already centralizes model access, token refresh, server-side pricing, usage logging, and multi-provider routing behind one authenticated HTTP server (`Soma-Protocol: 1`).

Crumble should be able to use a Soma server as a model backend provider with full feature parity — streaming text, thinking, tool calls, images, vision-model routing, server-computed costs, and graceful cancellation — without losing any existing built-in providers.

## Solution

Add a built-in `soma` provider plugin to Crumble that speaks Soma's HTTP protocol directly, alongside two small backwards-compatible additions to Soma so Crumble can discover upstreams and image capabilities automatically.

1. **Soma (`~/Developer/soma`):**
   - Add `GET /v1/upstreams` so clients can discover all configured upstreams on a Soma server without hardcoding upstream names.
   - Add input modality metadata (`input: ["text"]` / `["text", "image"]`) to `config.ModelInfo` so clients know which models accept images directly.
2. **Crumble (`~/Developer/crumble-project/bot`):**
   - Register a `soma` provider plugin (`id: "soma"`, display name `"Soma"`) that coexists with all built-in providers.
   - Configure Soma per account in **Settings → Providers** with a **Server URL** and **Token** (supporting password manager references), with optional `SOMA_URL` and `SOMA_TOKEN` environment variable fallback.
   - Expose every discovered model from every Soma upstream under the `soma` provider as `<upstream>/<model>` (for example, `chatgpt/gpt-6.1-sol` or `claude/claude-sonnet-5-5`).
   - Implement full Soma wire compatibility: NDJSON streaming, tool calls, thinking levels, SHA-256 blob upload for images, graceful `/v1/abort`, server-reported usage/cost, and `/v1/endrun` + `afterFailedStream` for conversation-holding upstreams.

## Behavior

### Configuration & discovery

1. **Per-account setup:** In **Settings → Providers**, the `Soma` row accepts both a **Server URL** (`http://` or `https://`, no embedded credentials, query, or fragment) and a **Token** (direct value or 1Password / Bitwarden reference). Both are stored per account; the token uses Crumble's existing `Secrets` store and the URL is stored encrypted in `provider_credentials` (`ApiKeyCredential.env.SOMA_URL`). Removing the provider deletes both.
2. **Environment fallback:** When an account has no saved Soma credential and both `SOMA_URL` and `SOMA_TOKEN` are set in the server environment, Soma is shown as configured (`From environment`) and uses those values. A saved per-account credential always takes precedence over the environment.
3. **Upstream & model discovery:** Refreshing models calls `GET /v1/upstreams` followed by `GET /v1/info?upstream=<name>` for each upstream (in parallel, ignoring individual upstreams that are temporarily unauthenticated or unreachable so one broken upstream doesn't hide the rest). Each model is exposed as:
   - `provider`: `"soma"`
   - `id`: `<upstream>/<modelId>`
   - `name`: `<upstream>/<modelId>`
   - `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`, `input`, and `cost` populated from Soma's `ModelInfo`.
4. **Coexistence:** All existing built-in providers (OpenAI, Anthropic, Claude Code, Melious, etc.) remain available and unchanged.

### Streaming, tools, thinking, and usage

5. **NDJSON streaming:** `POST /v1/stream` streams `text`, `thinking`, and `tool_call` deltas incrementally to Crumble's `AssistantMessageEventStream`. `keepAlive` lines reset the stream idle timer and are otherwise ignored.
6. **Tool round trips:** Tool definitions (`name`, `description`, JSON `schema`) are sent in `request.tools`. Returned `tool_call` blocks map to Pi `ToolCall` content blocks with `stopReason: "toolUse"`. Subsequent `toolResult` messages (including both text and image blocks) map to Soma `role: "tool"` messages with `callId`, `toolName`, and `isError`.
7. **Thinking levels:** Crumble's requested reasoning level is clamped to the model's advertised `thinking` levels and sent as `request.thinking`. Thinking blocks and opaque provider signatures (when present) round-trip cleanly across turns.
8. **Usage and cost:** Token counts (`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`) and server-calculated `usage.cost` from Soma's final `done` message are mapped directly into Pi's `Usage` so Crumble's Usage tab reflects Soma's pricing.
9. **Graceful abort:** When Crumble aborts an in-flight turn after receiving the `{ stream }` ID line, the adapter sends `POST /v1/abort` and waits up to 5 seconds for Soma's final `done` line so partial replies and token usage are preserved before closing.
10. **Conversation-holding upstreams:** When an upstream reports `holdsConversation: true` (such as `claude-code` on Soma):
    - The adapter sends a stable `sessionId` (using `options.sessionId` when present, or a deterministic hash of system prompt + first message otherwise).
    - If a stream drops with a network error, the next request for that `sessionId` sets `afterFailedStream: true`.
    - When a turn finishes without tool calls (`stopReason !== "tool_calls"`), the adapter sends a best-effort `POST /v1/endrun` so Soma releases the upstream process promptly.

### Images & vision compatibility

11. **Image capability reporting (Soma):** `config.ModelInfo` gains `Input []string` (`json:"input,omitempty"`, values `"text"` and `"image"`):
    - Populated from `models.dev` `modalities.input` when `modelsDev` is configured.
    - Populated from ChatGPT's model list `input_modalities` for `codex` upstreams.
    - Populated from Melious / OpenAI-compatible `_meta` vision metadata when present.
    - Set to `["text", "image"]` for `claude-code` subscription models.
    - Overridable per model via `modelOverrides`.
12. **Vision routing in Crumble:** Models with `"image"` in `input` are marked `input: ["text", "image"]` in Pi:
    - Bots using them receive images directly (and those models appear in Crumble's **Vision model** picker).
    - Bots using text-only Soma models (`input: ["text"]`) automatically route images through Crumble's **Vision model** extension, just like any other text-only model.
13. **Blob transfer:** Before calling `POST /v1/stream`, every `ImageContent` block in user and tool-result messages is decoded from base64, hashed with SHA-256, and referenced via `block.blob` + `streamRequest.blobs`. If Soma responds `409 Conflict` with `{ missing }`, the adapter uploads each missing blob via `PUT /v1/blobs/{sha256}` and retries `POST /v1/stream` once.

### Error handling

14. **Protocol & auth errors:** Missing/mismatched `Soma-Protocol` headers, invalid tokens (`401`), unknown upstreams (`404`), and upstream `ProviderError` payloads (`rate_limit`, `auth`, `overloaded`, `server`, `network`, `context_length`) are surfaced as clear error messages on the assistant message / API response without leaking the bearer token.

## Decisions

- **Single `soma` provider with `<upstream>/<model>` IDs:** Crumble's `ProviderModels` registers a static set of providers per account. Using one `soma` provider avoids dynamic provider-registration churn while still letting one Soma server expose multiple upstreams (`chatgpt`, `claude`, `melious`, etc.) cleanly.
- **Add `GET /v1/upstreams` to Soma rather than requiring manual upstream lists in Crumble:** Keeps setup to just URL + token, stays backwards-compatible with `Soma-Protocol: 1`, and benefits any future Soma client.
- **Reuse `ApiKeyCredential.env` + `Secrets` instead of a new DB table:** `ProviderCredentialRepository` and `ProviderCredentials` already persist `key` in `Secrets` (giving 1Password / Bitwarden support for free) and `env` encrypted in `provider_credentials`. Adding optional `baseUrl` support to `PUT /v1/providers/{provider}` and `Provider` response is minimal and requires no database migration.
- **No automatic migration from built-in providers:** Existing bots keep their configured provider/model. Users opt in to Soma models per bot, judge model, or vision model.

## Interfaces and data

### Soma HTTP additions (`Soma-Protocol: 1`, backwards-compatible)

- `GET /v1/upstreams` → `200 OK`:
  ```json
  { "upstreams": ["chatgpt", "claude"] }
  ```
  Returns sorted names of all configured upstreams excluding `api: "soma"` entries.
- `GET /v1/info?upstream=<name>` → `wire.Info`:
  Each `ModelInfo` entry may include `"input": ["text", "image"]` (omitted when unspecified).

### Crumble API contract additions

- `Provider` response (`apps/server/src/contract/api-responses.ts`):
  - `baseUrl: z.string().nullable()` — saved server URL (or `null` when unset / not applicable).
  - `requiresBaseUrl: z.boolean()` — `true` for `soma`, `false` for other providers.
- `PUT /v1/providers/{provider}` (`apps/server/src/contract/api-contract.ts`):
  - Body extends `secretInput` with optional `baseUrl?: string`. Required and validated as an `http(s)` URL (no userinfo, query, or fragment) when `provider` requires a base URL; rejected if provided for providers that don't use one.
- Regenerate OpenAPI outputs under `openapi/`.

## Affected code

### Soma (`~/Developer/soma`)
- `wire/wire.go`: `Upstreams` response type.
- `server/server.go`: `GET /v1/upstreams` handler.
- `config/config.go`, `config/modelsdev.go`, `config/subscriptions.go`: `Input []string` on `ModelInfo` and `ModelsDevModel`, override handling, `claude-code` defaults.
- `provider/openai/models.go`, `provider/chat/models.go`: extract image input modality when reported by upstream catalogs.
- `README.md`, `CHANGELOG.md`: document `GET /v1/upstreams` and `input` modality metadata.

### Crumble (`~/Developer/crumble-project/bot`)
- `apps/server/src/providers/soma/plugin.ts`, `adapter.ts`, `client.ts` (new): Soma HTTP client, blob uploader, NDJSON stream adapter, `createProvider` + `CrumblePlugin`.
- `apps/server/src/app/builtin-plugins.ts`: register `somaPlugin(host.env)`.
- `apps/server/src/providers/provider-credentials.ts`, `provider-auth.ts`, `providers-api.ts`: persist/read optional `baseUrl` alongside `api_key` credential, expose `baseUrl` / `requiresBaseUrl`, validate URL on `PUT /v1/providers/{provider}`.
- `apps/server/src/contract/api-responses.ts`, `api-contract.ts`, `openapi/`: contract schema updates.
- `apps/web/features/providers/providers.tsx`, `provider-logos.ts`: Server URL field in `ProviderKeySheet` for `requiresBaseUrl` providers, display configured URL, Soma icon/tile.
- `apps/docs/` and `CHANGELOG.md`: document Soma provider setup and env fallback.

## Testing

- **Soma:** Unit tests via `./scripts/check.sh` covering `GET /v1/upstreams`, `ModelInfo.Input` resolution from `models.dev` / `codex` / `openai-chat` / `claude-code` / `modelOverrides`, and `GET /v1/info` serialization.
- **Crumble:** Unit/integration tests against a local stub HTTP server implementing Soma's `/v1/upstreams`, `/v1/info`, `/v1/stream`, `/v1/blobs/{sha256}`, `/v1/abort`, and `/v1/endrun`:
  - Discovery across multiple upstreams (including partial upstream failure tolerance).
  - Streaming text, thinking, tool calls, tool results, and server-reported usage/cost.
  - Image blob 409 upload + retry (both user images and tool-result images) and vision-model routing for text-only models.
  - Graceful abort and `holdsConversation` (`sessionId`, `afterFailedStream`, `endrun`).
  - Per-account URL+token persistence, password-manager reference compatibility, and `SOMA_URL`/`SOMA_TOKEN` env fallback.
- Run `bun run check` in `~/Developer/crumble-project/bot` and `bun run check` in `apps/docs`.

## Out of scope

- Running Axon or Glia coding jobs inside Crumble workspaces (separate follow-up integration).
- Syncing Soma's `/v1/usage` log retroactively into Crumble's usage history (Crumble already records usage per turn from `done.message.usage`).
- Managing Soma's own `models.json` or upstream OAuth logins from inside Crumble's UI.
- Apple / Android client UI changes (they consume the existing OpenAPI contract; native UI for `requiresBaseUrl` can follow separately).

## Open questions

None.
