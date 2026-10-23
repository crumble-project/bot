# Provider account login milestone 1: server implementation plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use checkboxes.

**Goal:** Expose Pi AI's provider login interactions through authenticated HTTP operations, with encrypted typed credentials and safe refresh.

**Specification:** [Accepted feature 0004](https://github.com/crumble-project/spec/blob/main/features/0004-provider-account-login.md). The acceptance update is currently local spec commit `115ced3`; publish it before implementation review.

**Parent issue:** [spec#7](https://github.com/crumble-project/spec/issues/7).

**Architecture:** A `ProviderAuth` module owns login sessions and exposes their safe public state. One encrypted `CredentialStore` adapter and one shared Pi AI `Models` collection serve API handlers and every bot runtime. Pi AI owns authentication protocols, token refresh, and request-auth derivation; Crumble owns persistence, interaction transport, cancellation, and lifecycle.

**Tech stack:** Existing Bun, TypeScript, SQLite, Zod, Hono OpenAPI, and `@earendil-works/pi-ai` 1.3.0. No new dependencies.

## Global constraints

- Follow `../spec/GLOSSARY.md` and feature 0004. Do not change MCP sign-in or implement provider OAuth protocols.
- “Existing API-key setup and saved API keys continue to work.”
- “Each provider has one saved credential for the Crumble server, shared by bots configured to use that provider.”
- “Unfinished login sessions expire after 10 minutes without owner interaction or 30 minutes after starting, whichever comes first. Shorter provider deadlines still apply.”
- “Background polling and provider progress do not extend these limits.”
- “A refresh that finishes after sign-out must not restore the removed credential.”
- “Provider access tokens and refresh tokens never appear in client responses, logs, transcripts, or model tools.”
- Keep contract major version 1 and existing API-key operation IDs. No simulator or emulator jobs in CI.
- No new permanent tests unless the owner requests them or a demonstrated bug needs a regression test. Use existing tests and temporary acceptance probes. Do not begin tasks by writing tests.
- No real provider requests, account sign-ins, credentials, or paid models in default verification. Fake only the external provider; use real Store, Pi AI Models, runtime, and HTTP handlers.
- Commits, pushes, tags, releases, branch switches, and public issue/PR actions require owner authorization. Do not treat commands in this plan as authorization.

## Scope

Implementation happens on `feat/0004-provider-account-login`. This plan covers bot and its public contract only. Later delivery order is Apple shared code and macOS, then iOS, then Android. A server milestone does not complete feature 0004.

## Inspected seams

Line ranges refer to the checkout used for planning; locate by symbol after upstream changes.

| Existing path | Relevant behavior |
| --- | --- |
| `src/store.ts:129–145,798–879` | SQLite schema, settings, and AES-GCM-encrypted string credentials shared with MCP |
| `src/runtime.ts:61–68,248–270,302–312` | String credential callback, read-only API-key adapter, per-bot Models creation |
| `src/providers.ts` | Existing Melious registration; keep it available |
| `src/api.ts:800–855` | Separate Models collection, provider discovery, model refresh, API-key writes/deletes |
| `src/api.ts:119–137` | Generic error handler logs unexpected errors; raw provider exceptions must not reach it |
| `src/api-responses.ts:396–413` | Existing provider/configuration response schemas |
| `src/api-contract.ts:703–733` | Existing provider routes and operation IDs |
| `src/server.ts:158–161,263–283,316–350` | Runtime wiring, API wiring, shutdown, startup-failure cleanup |
| `docs/api-contract.md` | Contract generation, versioning, compatibility, and release process |
| `docs/provider-login-research.md` | Nine OAuth providers, remote paths, callback-port limitations, and offline OpenAI probes |

Before implementation, reread these installed types and implementations:

- `node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts`
- `node_modules/@earendil-works/pi-ai/dist/auth/resolve.js`
- `node_modules/@earendil-works/pi-ai/dist/models.js`, `login`, `logout`, and `getAuth`

The refresh implementation deliberately finishes and persists an already-started refresh despite caller cancellation, under a provider lock. Preserve that behavior. Do not discard a newly rotated refresh token merely because its request disconnected.

## File map

| Path | Responsibility |
| --- | --- |
| Modify `src/store.ts` | Typed encrypted provider rows, migration of existing provider keys, non-secret enumeration |
| Create `src/provider-credentials.ts` | Implement Pi AI CredentialStore with shared per-provider serialization |
| Create `src/provider-auth.ts` | Own sessions, interactions, safe status, login persistence guard, logout, and lifecycle |
| Modify `src/providers.ts` | Own the provider Models factory alongside Melious registration |
| Modify `src/runtime.ts` | Consume the shared Models/typed credentials seam, removing the API-key-only adapter |
| Modify `src/api-responses.ts` | Add provider auth metadata and session response schemas |
| Modify `src/api-contract.ts` | Add request schemas/routes and increment the compatible contract version |
| Modify `src/api.ts` | Adapt authenticated requests to ProviderAuth; retain API-key compatibility |
| Modify `src/server.ts` | Construct one owner of auth state and close it before releasing storage |
| Regenerate `openapi/openapi.json` and the three existing event-schema artifacts | Generated contract; only actual generator changes are retained |
| Modify `README.md`, `docs/architecture.md`, `CHANGELOG.md` | Describe login, persistence, limitations, and contract changes |
| Update existing test fixtures only where signatures change | Preserve existing test coverage without adding an unsolicited permanent suite |

## Task 1: Persist typed credentials without changing MCP storage

**Files:** `src/store.ts`, new `src/provider-credentials.ts`.

**Interface:** Import `Credential`, `CredentialInfo`, `CredentialStore`, and `AuthOperationOptions` from Pi AI. Add these Store methods:

```typescript
getProviderCredential(providerId: string): Credential | undefined;
setProviderCredential(providerId: string, credential: Credential): void;
deleteProviderCredential(providerId: string): boolean;
listProviderCredentials(): CredentialInfo[];
migrateProviderCredentials(providerIds: readonly string[]): void;
```

The adapter has this concrete constructor and implements every existing CredentialStore method with its installed signature:

```typescript
export class ProviderCredentials implements CredentialStore {
  constructor(store: Store);
  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined>;
  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]>;
  modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined>;
  delete(providerId: string, options?: AuthOperationOptions): Promise<void>;
  commitLogin(
    providerId: string,
    credential: Credential,
    isCurrent: () => boolean,
    onCommitted: () => void,
  ): Promise<boolean>;
}
```

- [ ] Add a separate `provider_credentials` table with `provider` primary key, `type`, and encrypted `value`. `type` is constrained to `api_key` or `oauth`. Enumerating metadata must not decrypt values.
- [ ] Extract the existing AES-GCM encryption/decryption operations into private Store helpers and reuse them for both tables. Preserve the existing `credentials` table representation for MCP.
- [ ] Serialize complete typed credentials as JSON before encryption. Validate the discriminator and required fields on read; preserve provider-specific JSON fields such as `clientId`, scopes, account IDs, enterprise URL, model IDs, and API-key environment values. Reject malformed typed rows instead of interpreting them as raw keys.
- [ ] Migrate legacy rows only for IDs returned by the registered provider catalog. In one SQLite transaction, convert each existing string key into `{ type: "api_key", key }` and remove its legacy row. Never overwrite an existing typed row. Never migrate `mcp:` keys or MCP OAuth storage. The migration must be idempotent.
- [ ] Implement a promise queue per provider in the single ProviderCredentials instance. `modify` reads the current value after acquiring its queue, awaits the callback, writes before releasing the queue, and returns the post-write value. A callback returning `undefined` leaves the current value unchanged.
- [ ] Serialize `delete` on that same queue. Rejected callbacks leave the previous row intact and release the queue. Waiting callers honor cancellation; do not release the queue early if a started callback still owns a rotating refresh token.
- [ ] Implement `commitLogin` on the same queue, separate from Pi AI's `modify` contract. After all asynchronous preparation and queue waits finish, call `isCurrent()` synchronously immediately before the Store write. Return false without writing if it fails. Otherwise write synchronously, invoke the nonthrowing synchronous `onCommitted()` state transition, and return true. There must be no await or promise continuation between the guard, write, and state transition. If persistence throws, do not invoke `onCommitted`. This guard applies only to login persistence, not refresh mutations.
- [ ] Use the existing exclusive data-directory ownership to justify process-local queues. Do not introduce a second server process or share this SQLite store on a network filesystem.

**Verification:** Run `bun test test/store.test.ts`. Use a temporary real Store directory to round-trip fake API-key and OAuth credentials, reopen it, and inspect metadata without exposing plaintext. Exercise two concurrent `modify` callbacks with a deferred promise: the second must see the first callback's committed value. Queue deletion after refresh; the final stored value must be absent. Confirm an MCP key and its original encrypted format remain usable.

**Rollback:** This is a data migration, not a code-only rollback. Back up the complete data directory and `.secret.key` before deployment. An older server does not understand the new provider table; do not silently duplicate OAuth credentials into legacy key rows.

## Task 2: Define the public session contract

**Files:** `src/api-responses.ts`, `src/api-contract.ts`.

Define schemas first, then infer application types from them. Do not maintain duplicate handwritten wire types. The following TypeScript is the required wire shape, not a second implementation:

```typescript
type LoginMethod = {
  type: "api_key" | "oauth";
  label: string;
  subscription: boolean;
};

type LoginPrompt = {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
};

type LoginEvent =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string;
      intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

type LoginSession = {
  id: string;
  provider: string;
  method: "api_key" | "oauth";
  status: "pending" | "succeeded" | "failed" | "cancelled" | "expired";
  createdAt: number;
  expiresAt: number;
  prompt: LoginPrompt | null;
  events: LoginEvent[];
  failure: null | {
    code: "provider_failure" | "callback_unavailable" | "storage_failure";
    message: string;
  };
};
```

- [ ] Use discriminated prompt schemas: `select` requires options; other prompts do not. Do not serialize AbortSignals, callback functions, credentials, or prompt responses.
- [ ] Extend Provider with additive fields `authMethods: LoginMethod[]`, `credentialType: "api_key" | "oauth" | null`, and `activeLoginId: string | null`. Preserve `provider`, `name`, and `configured` and their meanings. `configured` can remain true through ambient credentials after saved credentials are removed; do not claim the environment was revoked.
- [ ] Derive interactive methods from `provider.auth.apiKey?.login` and `provider.auth.oauth?.login`. Prefer `loginLabel`, then method `name`. Ambient-only auth is not an interactive method.
- [ ] Add these operations under the existing bearer-authenticated `/v1` group:

| Method and path | Operation ID | Request | Success |
| --- | --- | --- | --- |
| POST `/v1/providers/{provider}/login` | `startProviderLogin` | `{ method: "api_key" | "oauth" }` | 202 LoginSession |
| GET `/v1/provider-logins/{id}` | `getProviderLogin` | None | 200 LoginSession |
| POST `/v1/provider-logins/{id}/responses` | `answerProviderLogin` | `{ promptId: string, value: string }` | 200 LoginSession |
| DELETE `/v1/provider-logins/{id}` | `cancelProviderLogin` | None | 200 LoginSession |

- [ ] Document 400 for invalid input/unsupported method, 401 for missing authentication, 404 for unknown provider, 409 for active-provider conflict or stale prompt, and 410 for an unknown/evicted login session, including sessions lost on server restart. Do not claim that an unknown ID was definitely created before a restart.
- [ ] Keep `PUT /v1/providers/{provider}` and `DELETE /v1/providers/{provider}` and their existing operation IDs. PUT still accepts `{ apiKey }`; DELETE still returns 204 and now removes either saved credential type.
- [ ] Bound request values at 16,384 Unicode code points and reject oversized answers without echoing them. State reads and discovery never extend session lifetime.

**Verification:** Run `bun run openapi:generate`, `bun run openapi:check`, and `bun test test/openapi.test.ts`. Generation must be deterministic and require no provider calls. Inspect the generated union schemas and ensure no credential payload fields appear in session responses.

## Task 3: Implement the login state machine

**Files:** new `src/provider-auth.ts`; consume Task 1 and Task 2 interfaces.

Import wire types inferred from response schemas and Pi AI `Models`, `AuthType`, `AuthInteraction`, and `AuthPrompt`. The module's public interface is:

```typescript
export class ProviderAuth {
  readonly models: Models;
  constructor(store: Store, credentials: ProviderCredentials, models: Models);
  start(providerId: string, method: AuthType): LoginSession;
  get(sessionId: string): LoginSession;
  answer(sessionId: string, promptId: string, value: string): LoginSession;
  cancel(sessionId: string): LoginSession;
  setApiKey(providerId: string, value: string): Promise<void>;
  signOut(providerId: string): Promise<void>;
  activeLoginId(providerId: string): string | null;
  close(): Promise<void>;
}
```

- [ ] Use random UUIDs for sessions/prompts. Store pending promise resolvers privately, never in response objects. Return fresh public projections so an HTTP caller cannot mutate live state.
- [ ] Select the provider method with `method === "oauth" ? provider.auth.oauth : provider.auth.apiKey`; wire method `api_key` is not the property name `apiKey`. Require the selected method's `login` function and supply the interaction with a nonoptional session AbortSignal and `{ agentName: "Crumble", getDeviceId }`. This uses Pi AI's existing login flow while allowing Crumble to guard the persistence step explicitly. Do not call `Models.login` and then try to undo a cancelled write.
- [ ] Persist a stable random installation UUID in the existing settings table under `provider-auth-device-id`; reuse it after restart. It is not a credential or the client's installation ID.
- [ ] Translate every installed AuthEvent and AuthPrompt variant. `prompt()` creates a new ID and returns a promise; `answer()` consumes exactly that outstanding prompt. Validate select option IDs. Reject overlapping prompts from a malfunctioning provider with a sanitized session failure.
- [ ] Honor both the session AbortSignal and each prompt's signal. Remove listeners when a prompt resolves or aborts. A withdrawn prompt rejects its promise, disappears from public state, and rejects late answers with 409.
- [ ] Start both inactivity and absolute clocks on session creation. Only an accepted prompt answer resets inactivity. Authorization-link opening is client-local and does not reset server time. Provider deadlines may finish a flow earlier. Use a real timer to abort abandoned sessions even when no client polls.
- [ ] On flow completion, call `credentials.commitLogin`. Its `isCurrent` callback checks that the session is pending, remains the provider's active session, and is neither aborted nor expired. Its `onCommitted` callback synchronously marks success and performs terminal-session cleanup after the write. Do not use a guard inside an async `modify` callback: awaiting that callback introduces a cancellation window before persistence even if its body has no await.
- [ ] A rejected commit guard, storage failure, or cancellation must not overwrite the previous credential. Once the guarded write and success transition finish, later cancellation cannot relabel the login as cancelled. Keep a successfully persisted login successful even if later model-catalog refresh fails; report catalog retrieval errors separately and allow retry.
- [ ] For API-key replacement and sign-out, invalidate and abort any pending login synchronously, then await the credential queue write/delete. This prevents a paused login from writing after the newer operation. A running refresh completes before the queued replacement/delete; never acknowledge sign-out until deletion finishes.
- [ ] Remove prompt answers immediately after delivering them to the provider. On terminal state, remove prompts and authorization/device URLs/codes from retained public state. Keep at most 64 terminal sessions, evicting oldest first after 10 minutes; cap active sessions at 16 with an explicit capacity error. These are internal retention bounds, not extensions of login validity.
- [ ] Bound event history to 32 current interaction events; coalesce progress updates. Preserve the current authorization/device step while pending. Reject unexpectedly oversized provider events with a generic error instead of serializing unbounded provider data.
- [ ] Sanitize failures at the module boundary. Never copy a provider exception message, cause, token response, callback URL, or entered value to logs or the failure response. Known callback-port conflicts may use a fixed actionable message. Unknown failures use fixed `provider_failure` copy.
- [ ] Keep provider-specific remote hints in this server module, not clients: Radius browser login has no remote manual fallback; its `select` prompt must identify device code as the remote choice before submission. Preserve the provider option IDs. Include OpenAI's callback-port requirement as a non-secret setup hint. These exceptions explain installed-library behavior, not reimplemented auth flows.
- [ ] `close()` rejects new sessions, aborts pending interactions, clears timers/listeners, and waits for outstanding credential mutations before storage closes.

**Verification:** Use a temporary fake provider login method registered on a real Models collection and actual encrypted Store. Drive each event/prompt through the module, answer a select with its ID, cancel a prompt, deliver a stale answer, and release a delayed login after sign-out. Observe status transitions through the public interface, not private maps. No fake server storage or fake ProviderAuth implementation.

## Task 4: Share credentials and models across API and runtimes

**Files:** `src/providers.ts`, `src/runtime.ts`, `src/server.ts`, `src/api.ts`, existing fixture callers.

Move the existing factory out of runtime and change its signature:

```typescript
export function providerModels(credentials?: CredentialStore): Models;
```

Its implementation remains `builtinModels({ credentials })` plus `models.setProvider(meliousProvider())`. With no argument, Pi AI's existing default store supports catalog-only callers. Remove the old read-only string adapter rather than retaining a compatibility shim.

- [ ] Construct the catalog to obtain registered provider IDs, migrate legacy credentials, then create exactly one ProviderCredentials adapter and one Models collection for the running server. Construct ProviderAuth with those instances.
- [ ] Pass the shared Models through the existing runtime `models` callback property. Remove the obsolete `credentials` string callback and the second string parameter of the function-form Models factory after updating every repository caller. Preserve injection of a test Models collection and `models(agent)` factories.
- [ ] Give `createAPI` an explicit optional `providerAuth` option. Production always supplies the shared instance. Existing API-only fixtures may construct their own instance, but any fixture starting a login must close it. Do not silently create an independent auth module in production.
- [ ] Replace the API's private authenticated Models collection with `providerAuth.models`. Catalog-only provider validation must use the registered collection so injected provider fakes and supported providers are consistent.
- [ ] On provider discovery, report saved credential metadata separately from `checkAuth` results. On model discovery, use credential-aware Pi AI filtering, not only unfiltered `getModels()`, so account/provider restrictions are respected. Preserve the endpoint's existing chat-model response shape.
- [ ] Ensure a runtime whose existing model ID remains present still uses fresh credentials on the next request. Share catalog refresh results across all runtime instances; do not make key replacement require reopening chats.
- [ ] Close ProviderAuth on normal shutdown and startup failures, before releasing the data-directory lock and closing Store. Preserve existing group, job, MCP, and workspace lifecycle order.
- [ ] Convert auth errors returned by provider/model discovery into safe HTTP errors before the generic handler can log raw provider exceptions. Do not globally suppress unrelated application errors.

**Verification:** Run `bun test test/runtime.test.ts test/runtime-behavior.test.ts test/api.test.ts test/server.test.ts test/store.test.ts`. Fix only fixture signature changes, preserving assertions. Use a fake expired OAuth credential with concurrent real `Models.getAuth` calls: the external refresh counter must increment once and all consumers must use the persisted replacement. Repeat with a queued sign-out and confirm the final credential is absent.

## Task 5: Bind HTTP operations and verify the server acceptance paths

**Files:** `src/api.ts`; use the existing route registration and bearer middleware.

- [ ] Register the four session routes from Task 2 and map calls directly to ProviderAuth. Do not expose provider login as a model tool or write interaction events to bot transcripts.
- [ ] Route existing API-key PUT and provider DELETE through `setApiKey` and `signOut`. Preserve current response shapes/status codes and existing client behavior.
- [ ] Present inactive/expired sessions explicitly. Polling does not refresh expiration. Discovery returns the active session ID for reconnecting clients without retaining entered secrets.
- [ ] Apply constant safe error messages to login failures and rejected answers. Do not put request bodies in errors or structured logging. Treat authorization URLs, device codes, and manual callback responses as sensitive interaction data even though they are not stored provider tokens.
- [ ] Run the existing full check before adding any permanent test file. The owner has not requested a permanent auth suite.

Use this temporary acceptance matrix with actual `app.request`, Store, ProviderAuth, and Models. Substitute only provider login/refresh/network methods. Create the temporary probe under the system temporary directory with absolute imports, not under a committed test path.

| Probe | Observable assertion |
| --- | --- |
| Existing key | A legacy fake key migrates and existing provider GET/PUT/DELETE behavior still works |
| All interactions | Fake flow emits each notification and awaits text, secret, select, manual-code answers; only current prompt is answerable |
| Persistence | Successful fake login returns succeeded after encrypted storage; reopening Store returns the full credential including extension fields |
| Replacement failure | Failed or cancelled fake login leaves the original key unchanged |
| Cancellation race | Release a delayed provider result after cancel, key replacement, and sign-out; none restores the stale credential. Also cancel in a queued microtask before the guarded write and confirm the old credential survives; cancel after the committed state transition and confirm the session remains succeeded. |
| Refresh race | Two Models requests refresh an expiring token once; queued delete completes with no stored credential |
| Provider failure | Fake exception includes a secret sentinel; neither HTTP response nor captured error logging contains it |
| Authorization | Every login operation without bearer auth returns 401; knowing a session ID is insufficient |
| Reconnect | Two authenticated clients read the same outstanding prompt without extending expiry |
| Restart | A new auth module rejects an old session with 410 but reads saved credentials |
| Scope | Login produces no bot transcript entries or executions and does not modify MCP credentials |
| Remote provider paths | Re-run actual OpenAI/Codex library functions with fake fetch responses, never a real account |
| Timeouts | In an isolated probe process with controlled clock/timers, advance to 10-minute inactivity and 30-minute lifetime; polling/progress cannot extend either |

Assertions for the two most consequential races must include these exact outcomes:

```typescript
assert.equal(refreshCalls, 1);
assert.equal(await credentials.read(providerId), undefined);
assert.equal(auth.get(cancelledSessionId).status, "cancelled");
assert.equal(responseText.includes(secretSentinel), false);
assert.equal(capturedLogs.includes(secretSentinel), false);
```

Here `credentials` is Task 1's adapter, `auth` is Task 3's module, and counters/sentinels are owned by the fake external provider. Never introduce test-only behavior into production auth code to make these assertions pass.

## Task 6: Generate, document, and hand off the contract

**Files:** `src/api-contract.ts`, generated `openapi/` artifacts, `README.md`, `docs/architecture.md`, `CHANGELOG.md`, this plan.

- [ ] Inspect current `info.version` and published contract versions. Choose the next available compatible minor version; do not reuse a number from this plan or bump the package version instead.
- [ ] Add its `## Contract X.Y.Z` changelog section with new operations and additive fields. Explain that older API-key clients keep working.
- [ ] Document account login, provider settings shared by bots, remote browser/device-code steps, internal callback-port conflicts, encrypted storage/migration, and session timeouts. State that logout removes the saved credential but does not revoke provider grants or ambient credentials.
- [ ] Document that remote authentication requires HTTPS or an encrypted private connection. Do not imply the existing plain LAN HTTP setup encrypts login answers or the server bearer token.
- [ ] Run these commands from `bot/` and record actual results:

```bash
bun run openapi:generate
bun run check
bun run contract:validate
bun run contract:compatibility
```

- [ ] Read the full diff and verify no raw credential, callback URL, device code, or temporary probe is committed. Record remaining live-verification gaps, not a blanket claim that all feature acceptance criteria passed.
- [ ] Obtain authorization before staging explicit paths, committing, pushing, or opening the milestone PR. Link the accepted specification; do not close spec#7.
- [ ] After merge, use the existing contract release workflow with owner authorization. Confirm the published contract artifacts and checksums before starting the Apple milestone. `bun run contract:bundle` can provide a local provenance bundle only after clean contract sources are committed; it is not a published release.

## Acceptance ownership

| Feature requirement | Milestone responsibility |
| --- | --- |
| Provider methods, interaction types, pending/success/failure, safe state | Tasks 2, 3, 5 |
| Encrypted typed credentials, existing keys, refresh, concurrency, restart | Tasks 1, 3, 4, 5 |
| Cancellation, stale answers, sign-out races, expiration | Tasks 3, 5 |
| Remote-library paths and callback limitations | Task 3 plus offline probes in Task 5 |
| Authenticated operations, secret handling, no transcript/tool exposure | Tasks 2, 3, 4, 5 |
| Model availability without runtime restart | Task 4 |
| Compatible contract and documentation | Tasks 2, 6 |
| Real macOS-to-Docker OpenAI sign-in | Later Apple milestone, owner-assisted, no password/token sharing |
| macOS, iOS, and Android presentation | Later client milestones after server merge |

## Completion gate

This milestone is ready when server behavior and the contract pass the checks and offline probes, the migration/rollback implications are documented, and no runtime uses the old string-only credential adapter. The feature stays Accepted until client milestones and owner-assisted remote sign-in satisfy the remaining acceptance criteria.
