# Password managers implementation plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** Owners connect 1Password or Bitwarden Secrets Manager and point bot credentials, provider API keys, and MCP server tokens at a vault reference instead of storing the value in Crumble.

**Architecture:** The read side is done: every secret table has `value | (password_manager, reference)` columns, `SecretValues` reads and caches references, and the credential proxy, `ProviderCredentials`, and `McpConnections` read through it. This plan adds the write side: an HTTP API to connect password managers, a reference alternative on each secret's save endpoint (checked by one read on save), the web UI for both, docs, and one deferred race fix in `McpConnections`.

**Source:** GitHub issue crumble-project/bot#48. Done so far on branch `feat/improve-credentials`: commits `39a83be`, `3d115c2`, `ce7c5ce`, `6296c17`, `57bfaa9`, `8178c5f`.

## Decisions

- Cache timings stay as built in `apps/server/src/password-managers/secret-values.ts:53-62` (fresh 1 h, background refresh after 55 min, stale use up to 2 h while unreachable), not the issue's 5 min. Already shipped in `ce7c5ce`.
- A reference is sent as `{ passwordManager, reference }`, the same pair `SecretSource` uses (`secret-values.ts:24`). Each save input accepts either its value field or this pair, never both.
- Saving a reference checks its format with `PasswordManagers.checkReference` and reads it once through `SecretValues.readNow`, which ignores cached values so a stale or deleted reference can't pass; a failed read rejects the save with `InvalidInput` and the read's message. The value is never returned.
- Saving a value over a reference, or a reference over a value, replaces the other source in the same row (the database allows exactly one, `password-managers/schema.ts:42`). Editing or deleting a reference calls `SecretValues.forget` for the old reference.
- Responses show where a secret comes from (`passwordManager`, `reference`, both nullable) but never a value. A reference is not secret.
- A bot credential's "last read error" is the `error` of its newest use (`credential_uses.error`, added in `6296c17`); no new column.
- Saving a new token for a connected password manager calls `SecretValues.disconnect(id)` so the old client and its cached values are dropped.
- Disconnecting while secrets use it fails with `Conflict` (existing `PasswordManagerRepository.delete`, `password-manager-repository.ts:41`). The connection list response includes `usedBy` so the web dialog can name them.
- Web only. Apple and Android clients keep working because every new response field is optional or nullable; they get no new UI here.
- One contract minor bump for the whole plan: 3.3.0 to 3.4.0, made in Task 1; later tasks add lines to the same changelog section.

## Constraints

- Read `apps/server/node_modules/effect/AGENTS.md` before writing Effect code (`bot/AGENTS.md`).
- Product language follows `GLOSSARY.md`; add **Password manager** there (Task 8). Never "vault provider" or "secret store" in UI copy.
- Tests use the fake vendor in `apps/server/test/support/fake-password-manager.ts`; never the real 1Password or Bitwarden APIs, never network.
- Write-only fields: tokens, API keys and values never appear in a response or a log.
- Web editing opens in `EditorSheet`, never a modal (owner preference).
- Contract: version in `apps/server/src/contract/api-contract.ts:1018`; changelog `CHANGELOG.md` under `## Unreleased` plus a `## Contract 3.4.0` section; regenerate with `bun run openapi:generate`.
- Check command, from `bot/`: `bun run check` (agents check, lint, format, typecheck, OpenAPI check, tests). CI unit tests stay under two minutes.
- Docs: each task that changes endpoints or behavior updates the matching `apps/docs` page in the same change (`bot/AGENTS.md`); Task 8 adds the concepts page, the glossary, and UI steps. After changing `apps/docs`, run `bun run check` from `apps/docs`.

## Out of scope

- Browsing or picking vault items; the owner pastes a reference.
- Bitwarden Password Manager (personal vaults); only Secrets Manager.
- Writing or rotating values in the password manager.
- Password manager references for OAuth provider sign-ins, MCP OAuth state, or MCP OAuth client secrets.
- Apple and Android UI.

## Review focus

1. A reference save while the password manager is unreachable: rejected with "<name> could not be reached", nothing written. Test in Tasks 3-5.
2. Replacing a reference with a value must not ask the password manager (the provider path already tests this in `provider-credentials.test.ts`). Test for bot credentials and MCP tokens.
3. Saving a new token for a connected password manager while a read is in flight: the read is interrupted and its value not cached (`SecretValues.disconnect`). Test in Task 1.
4. A bot credential request answered with a reference must start the bot turn exactly like a value answer. Test in Task 3.
5. `usedBy` after a secret switches from reference back to value: the password manager no longer lists it and can be disconnected. Test in Task 1 or 3.

## Files

| File                                                                                                                           | Responsibility                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/password-managers/password-managers-api.ts` (new)                                                             | List, connect, disconnect routes.                                                                                             |
| `apps/server/src/password-managers/secret-references.ts` (new)                                                                 | `secretReferenceInput` schema and `checkSecretReference`.                                                                     |
| `apps/server/src/contract/api-contract.ts`                                                                                     | New routes; reference alternatives on three inputs; version 3.4.0.                                                            |
| `apps/server/src/contract/api-responses.ts`                                                                                    | Connection response; `passwordManager`/`reference` on credential, provider, MCP server responses; `lastError` on credentials. |
| `apps/server/src/app/api.ts`                                                                                                   | Register the new routes.                                                                                                      |
| `apps/server/src/credentials/{credentials.ts,agent-credential-repository.ts}`                                                  | Save a reference for a bot credential.                                                                                        |
| `apps/server/src/providers/{provider-credential-repository.ts,provider-auth.ts,providers-api.ts}`                              | Save a reference for a provider API key.                                                                                      |
| `apps/server/src/credentials/secret-repository.ts`, `apps/server/src/integrations/mcp-servers-api.ts`                          | Save a reference for an MCP token.                                                                                            |
| `apps/server/src/integrations/integrations.ts`                                                                                 | Task 9 race fix.                                                                                                              |
| `apps/web/features/settings/password-managers.tsx` (new), `apps/web/app/router.tsx`, `apps/web/features/settings/settings.tsx` | Settings > Password managers.                                                                                                 |
| `apps/web/components/secret-source-field.tsx` (new)                                                                            | Value-or-reference input shared by three editors.                                                                             |
| `apps/web/features/{credentials/credentials.tsx,settings/settings.tsx,integrations/integrations.tsx}`                          | Use the shared field; show last read error.                                                                                   |
| `GLOSSARY.md`, `apps/docs/content/...`                                                                                         | Task 8.                                                                                                                       |
| `CHANGELOG.md`, `openapi/`                                                                                                     | Every server task.                                                                                                            |

### Task 1: Connect and disconnect password managers over HTTP

**Files:** create `apps/server/src/password-managers/password-managers-api.ts`; modify `api-contract.ts`, `api-responses.ts`, `app/api.ts`, `CHANGELOG.md`, `openapi/`; test `apps/server/src/password-managers/password-managers-api.test.ts`.
**Interfaces:**

- Consumes: `PasswordManagerRepository.list | save | usedBy | delete` (`password-manager-repository.ts:27-43`), `PasswordManagers.connect | name` (`password-manager.ts:150-165`), `SecretValues.disconnect` (`secret-values.ts:107`).
- Produces:
  - `GET /v1/password-managers` (`listPasswordManagers`): `{ passwordManagers: { id: "1password" | "bitwarden"; name: string; connected: boolean; connectedAt: string | null; usedBy: SecretUsingPasswordManager[] }[] }`, one entry per supported vendor.
  - `PUT /v1/password-managers/{id}` (`connectPasswordManager`), body `{ token: string }` (1..16000, write-only): signs in once in a scope, then saves and calls `SecretValues.disconnect(id)`. Rejected token: 400 `InvalidInput` "<name> rejected the token"; unreachable: 503 `Unavailable` "<name> could not be reached".
  - `DELETE /v1/password-managers/{id}` (`disconnectPasswordManager`): 204, or 409 `Conflict` from the repository; on success also `SecretValues.disconnect(id)`.

- [x] Write failing tests: connect with `FAKE_TOKEN` then list shows `connected: true`; a wrong token answers 400 and stays disconnected; a token PUT while connected drops cached values (`state.reads` grows on the next read); delete with a secret using it answers 409 and the list's `usedBy` names it; delete without users answers 204.
- [x] Run `bun test apps/server/src/password-managers/password-managers-api.test.ts`. Expected: fails, routes missing.
- [x] Implement the routes, following `credentials-api.ts` (a `register…Routes(options)` function) and register it in `app/api.ts`.
- [x] Bump the contract to 3.4.0, add `## Contract 3.4.0` to `CHANGELOG.md` listing the three routes and the existing `CredentialUse.error` field, run `bun run openapi:generate`.
- [x] Run `bun run check` from `bot/`. Expected: passes.
- [x] Checkpoint: `feat(password-managers): connect and disconnect password managers over HTTP`.

### Task 2: Check a reference before saving it

**Files:** create `apps/server/src/password-managers/secret-references.ts`; test `secret-references.test.ts`.
**Interfaces:**

- Produces:
  - `secretReferenceInput = z.object({ passwordManager: z.enum(["1password", "bitwarden"]), reference: z.string().trim().min(1).max(1000) })`.
  - `type SecretReference = z.infer<typeof secretReferenceInput>`, used by every later task.
  - `checkSecretReference(source: SecretReference): Effect<void, InvalidInput, PasswordManagers | SecretValues>`: `checkReference`, then `SecretValues.readNow` (asks the password manager whatever is cached, then caches the answer); a `SecretUnavailable` becomes `InvalidInput` with its message.

- [x] Write failing tests: a malformed reference fails with the vendor's format message and reads nothing; a missing item fails with "Fake has no item that matches"; a not-connected password manager fails with "Fake isn't connected"; a valid one succeeds and the next `SecretValues.read` is a cache hit (`state.reads === 1`).
- [x] Implement. Run the test file. Expected: passes.
- [x] Checkpoint: `feat(password-managers): check a secret reference before saving it`.

### Task 3: Bot credentials from a password manager

**Files:** modify `shared/domain.ts:312` (`credentialSaveInput`), `credentials/credentials.ts`, `credentials/agent-credential-repository.ts:70`, `api-responses.ts:381` (`credentialResponse`), `CHANGELOG.md`, `openapi/`; test `credentials/credentials.test.ts`.
**Interfaces:**

- Consumes: Task 2 `secretReferenceInput`, `checkSecretReference`.
- Produces: `credentialSaveInput` gains `reference?: SecretReference`, refined so `value` and `reference` are exclusive; `AgentCredentialRepository.save` input takes `value?: string; reference?: SecretReference`; `AgentCredential` gains `passwordManager: PasswordManagerId | null; reference: string | null; lastError: string | null`.

- [x] Write failing tests: saving with a reference then reading through the proxy sends the vault value; a failed check rejects the save and writes no row; answering a credential request with a reference starts the bot turn; replacing a reference with a value reads nothing from the password manager and `usedBy` no longer lists it; changing or deleting a reference calls `forget` (next read hits the fake); `list` shows `lastError` from the newest failed use.
- [x] Implement: check before reading the saved credential, so a save made during the read isn't overwritten; `forget` the previous reference after the write.
- [x] Docs: password manager endpoints in `reference/api.md`; saving a credential as a reference over the API in `concepts/credentials.md`.
- [x] Changelog line under 3.4.0, regenerate OpenAPI, `bun run check`. Expected: passes.
- [x] Checkpoint: `feat(credentials): save bot credentials as password manager references`.

### Task 4: Provider API keys from a password manager

**Files:** modify `api-contract.ts:88` (`providerKeyInput`), `providers/providers-api.ts:109`, `providers/provider-auth.ts:140`, `providers/provider-credential-repository.ts`, `api-responses.ts:617` (`providerResponse`), `CHANGELOG.md`, `openapi/`; test `providers/provider-credentials.test.ts` and `app/api.test.ts` (it already exercises `/v1/providers/{provider}`; there is no providers API test file).
**Interfaces:**

- Produces: `providerKeyInput` becomes `{ apiKey: string } | SecretReference`; `ProviderCredentialRepository.setReference(providerId: string, source: SecretReference): Effect<void>`; provider response gains `passwordManager`, `reference` (nullable). The Exa key route (`api-contract.ts:214`) keeps `{ apiKey }` only: build it from a separate schema rather than the widened one.

- [x] Write failing tests: PUT with a reference stores it and the model call gets the vault key; a failed check answers 400 and keeps the previous credential; the Exa key route still rejects a reference body.
- [x] Implement through `ProviderCredentials`'s queue so a reference save serializes with OAuth refresh, then `forget` the previous reference.
- [x] Docs: reading a provider key from a password manager over the API in `getting-started/providers.md`.
- [x] Changelog, OpenAPI, `bun run check`. Expected: passes.
- [x] Checkpoint: `feat(providers): save provider API keys as password manager references`.

### Task 5: MCP tokens from a password manager

**Files:** modify `api-contract.ts:121` (`mcpInput`), `integrations/mcp-servers-api.ts:82,176`, `credentials/secret-repository.ts`, `api-responses.ts:716` (`mcpServerResponse`), `CHANGELOG.md`, `openapi/`; test `app/api.test.ts` (its MCP server tests start at line 615; there is no `mcp-servers-api.test.ts`).
**Interfaces:**

- Consumes: `SecretRepository.source` (`secret-repository.ts`, added in `8178c5f`), `McpIntegrations.disconnect`.
- Produces: `mcpInput` gains `tokenReference?: SecretReference | null` (null removes it), exclusive with `token`; `SecretRepository.setReference(key: string, source: SecretReference): Effect<void>`; server response gains `tokenPasswordManager`, `tokenReference` (nullable).

- [x] Write failing tests: create with `tokenReference` and the connection sends `Bearer <vault value>`; PATCH from reference to `token` reads nothing; PATCH to a new reference disconnects the open connection; a failed check answers 400 and leaves the server unchanged.
- [x] Implement; call `integrations.disconnect` whenever the token source changes.
- [x] Docs: reading an MCP token from a password manager over the API in `concepts/schedules-and-integrations.md`.
- [x] Changelog, OpenAPI, `bun run check`. Expected: passes.
- [x] Checkpoint: `feat(integrations): save MCP tokens as password manager references`.

### Task 6: Settings > Password managers (web)

**Files:** create `apps/web/features/settings/password-managers.tsx`; modify `apps/web/app/router.tsx` (route `/settings/password-managers` beside `providersRoute`, line ~246), `apps/web/features/settings/settings.tsx` (`SECTIONS`), `apps/web/lib/api.ts` (query for `GET /v1/password-managers`).
**Interfaces:** Consumes Task 1 routes.

- [x] One row per vendor: the vendor's logo (`simple-icons`), its name, and "(used by N)" when `usedBy` is not empty; no status line or names (the owner chose this, so 30 users don't flood the row). Not connected: a Connect button. Connected: a row menu with Replace token and Disconnect, disabled while in use. Connect and Replace open an EditorSheet with a password input.
- [x] Errors from connect show in the sheet under the field.
- [x] Verify in the browser against `bun run dev` with a fake or real test token; screenshot connected and in-use states. Run `bun run check`. (Owner verified on a seeded test account.)
- [x] Docs: connecting in Settings > Password managers in `concepts/credentials.md`.
- [x] Checkpoint: `feat(web): connect password managers in settings`.

### Task 7: Pick a reference in each secret editor (web)

**Files:** create `apps/web/components/secret-source-field.tsx`; modify `features/credentials/credentials.tsx`, `features/settings/settings.tsx` (provider key editor), `features/integrations/integrations.tsx` (token field).
**Interfaces:** Consumes the inputs and responses of Tasks 3-5.

- Produces: `SecretSourceField({ value, onChange, connected }: { value: SecretSourceDraft; onChange(next: SecretSourceDraft): void; connected: PasswordManagerId[] })` with `SecretSourceDraft = { kind: "value"; value: string } | { kind: "reference"; passwordManager: PasswordManagerId; reference: string }`.

- [x] The field offers "In Crumble" or one option per connected password manager; with none connected it is the plain value input plus a link to Settings > Password managers.
- [x] Editors show an existing reference as text; saving sends the matching input shape; save errors show under the field.
- [x] Credential rows show `lastError` when set.
- [x] Verify each editor in the browser; `bun run check`.
- [x] Checkpoint: `feat(web): read secrets from a password manager`.

### Task 8: Glossary and docs

**Files:** `GLOSSARY.md` (after **Credential**, line 73); `apps/docs/content/concepts/credentials.md`, `apps/docs/content/getting-started/providers.md`, `apps/docs/content/concepts/schedules-and-integrations.md`; create `apps/docs/content/concepts/password-managers.md` with frontmatter `sidebar.order: 7`, shifting `schedules-and-integrations.md` to 8 and `web-search.md` to 9 (concepts pages order themselves by frontmatter, e.g. `credentials.md:5` is `order: 6`); add the term to `apps/docs/content/reference/glossary.md`, the docs copy of the glossary.

- [x] Glossary: **Password manager**: 1Password or Bitwarden Secrets Manager, connected to an account so credentials, provider API keys and MCP server tokens can be read from it instead of stored in Crumble. _Avoid_: vault provider, secret store.
- [x] Docs describe connecting, reference formats (`op://vault/item/field`, Bitwarden secret ID), the cache timings from Decisions, and the error each kind of secret shows.
- [x] Run `bun run check` from `apps/docs`. Expected: passes.
- [x] Checkpoint: `docs: password managers`.

### Task 9: Don't cache an MCP connection opened across a disconnect

**Files:** modify `apps/server/src/integrations/integrations.ts` (`McpConnections.connection`, `disconnect`, `close`); test `integrations/integrations.test.ts`.
**Interfaces:** none new.

- [x] Write failing test `"a disconnect during a token read leaves no connection open"`: a `token` that resolves only after `disconnect(serverId)` is called; afterwards the factory's client was closed and the next call opens a new one.
- [x] Implement a per-server generation counter bumped by `disconnect` and `close`; `connection` records it before the token read and, if it changed by the time `connect` finishes, closes the new client and throws "MCP server credentials changed; retry this task".
- [x] Run `bun test apps/server/src/integrations`, then `bun run check`. Expected: passes.
- [x] Checkpoint: `fix(integrations): drop MCP connections opened across a disconnect`.
