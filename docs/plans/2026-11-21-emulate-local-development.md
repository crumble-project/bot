# Credential-free local development implementation plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** Run Crumble locally with deterministic AI scenarios and no live provider credentials.
**Architecture:** A Bun development supervisor owns one Node Emulate sidecar and a watched Crumble entry point. An explicit local profile replaces the account model catalog with a preconfigured Pi HTTP provider. Interactive development and a separate local smoke command share the emulator scenarios and lifecycle helper.
**Source:** [Approved spec](../designs/emulate-local-development.md).

## Decisions

- Keep all existing `fauxProvider` tests; wholesale migration does not solve the development setup problem.
- Add `bun run dev:emulate`, using loopback, port `7338`, and repository-local `.cache/emulate/data`.
- Offer five scenario models: `local-reply`, `local-stream`, `local-tool`, `local-error`, and `local-stall`. The tool scenario calls `history_search` and then answers.
- Use the existing Pi OpenAI-compatible HTTP transport, nonsecret dummy authentication, and a local-only model catalog. There is no generic endpoint setting or production fallback.
- Keep normal authentication and production startup unchanged. No account/bot seeding, real integrations, or workspaces.
- Run emulator-backed checks only with the new `bun run check:emulate` command. Do not add them to default test discovery or CI.

## Constraints

- Crumble uses Bun `1.4.4` (`.bun-version`). Use Bun for dependency installation and application execution. Pin `emulate` to `0.14.0`; require Node `24+` for its sidecar. The available Node runtime is `26.10.0`.
- Before writing Effect code, read `apps/server/node_modules/effect/AGENTS.md` completely.
- "Nothing that needs a simulator or emulator runs in CI, in any workflow: no UI tests, no app-hosted tests. Those run locally."
- "CI unit-test jobs that run on push or pull requests must finish in at most two minutes; check a job's duration after changing it."
- No real keys, paid APIs, external network calls, automatic global tool installation, or modification of existing installation data during verification.
- No commits, staging, push, or pull request without explicit permission.

## Out of scope

Faux replacement, CI policy changes, other service emulators, real model inference, new UI screens, workspaces, gateways, schema changes, generic provider URL configuration, and automatic data resets.

## Review focus

1. Existing environment configuration must not redirect the local profile into real data, credentials, push transports, or workspaces.
2. A separate local catalog must not reintroduce live providers through plugin contributions or account restoration.
3. Tool-result requests must match a terminating scenario rule rather than recursively calling the tool.
4. App reload, early startup failure, occupied ports, and interrupts must not leave sidecars or duplicate app listeners.
5. Stalled/error scenarios must remain stoppable and bounded without provider fallback.

## Files

- `package.json`, `bun.lock`: pinned development dependency and explicit local commands.
- `apps/server/src/providers/emulate-profile.ts` (new): dependency-free profile type and scenario model IDs shared with the tools.
- `tools/emulate-scenarios.ts` (new): deterministic AI seed rules and expected reply text.
- `tools/emulate-service.ts` (new): Node-only sidecar entry point; the only runtime import of `emulate`.
- `tools/emulate-process.ts` (new): Bun-side child ownership, clean environment, and readiness protocol.
- `tools/dev-emulate.ts`, `tools/emulate-server.ts` (new): supervisor and watched app entry point.
- `apps/server/src/providers/emulate.ts` (new): Pi HTTP provider and strict loopback validation.
- `apps/server/src/providers/providers.ts`, `apps/server/src/app/server.ts`, `apps/server/src/app/tenant.ts`: explicit local catalog/profile propagation. `tenantPool` lives inside `server.ts:183`; no separate pool module is needed.
- `apps/server/src/providers/emulate.test.ts`, `tools/emulate-process.test.ts` (new): non-emulator provider/environment assertions.
- `apps/server/src/app/server.test.ts`, `apps/server/src/app/tenant.test.ts`: profile forwarding, restored accounts, and unchanged ordinary behavior.
- `tools/check-emulate.ts` (new): local authenticated app/runtime smoke checks, outside automatic test discovery.
- `apps/docs/content/contributing/index.md`, `CHANGELOG.md`: development instructions and behavior change.

### Task 1: Prove the real transport and provide deterministic scenarios

**Files:** dependency files; new profile, scenario, sidecar, process-helper and provider modules listed in Files. Begin `tools/check-emulate.ts` with the transport checks; Task 4 extends it.
**Interfaces:**
- Produces `EMULATE_MODEL_IDS`, the five literal IDs in Decisions; `EmulateModelId` is their union. The dependency-free profile module also exports `EmulateProfile = { baseUrl: string }`.
- Produces `emulateProvider(baseUrl: string): Provider<'openai-completions'>`. Accept only `http://127.0.0.1:PORT/v1`, with an explicit nonzero port and no credentials, query, or fragment.
- Produces `startEmulate(): Promise<{ url: string; close(): Promise<void> }>` in `tools/emulate-process.ts`; `url` is the listener origin. Each call owns an independent sidecar; `close` is idempotent.
- The sidecar uses published `createEmulator({ service: 'ai', hostname: '127.0.0.1', port: 0, seed: { ai: ... } })`, not the CLI's differently named `--host` option. See [published API types][emulate-api].
- Pi supports fixed dummy auth through `auth.apiKey.check` and `auth.apiKey.resolve`; neither reads ambient or saved credentials. Use `createProvider` with `openAICompletionsApi()` as in `apps/server/src/providers/melious.ts:28`. SDK definitions: `apps/server/node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts:170` and `apps/server/node_modules/@earendil-works/pi-ai/dist/models.d.ts:215` (version `1.4.0`).

- [x] Run `bun add --dev --exact --ignore-scripts emulate@0.14.0` in this worktree. Ignoring lifecycle scripts avoids the root `prepare` script modifying shared Git configuration. Do not link another worktree's dependencies or install global tools.
- [x] Implement the Node sidecar using `node --experimental-strip-types` and erasable TypeScript without path aliases. Emit `{ type: 'ready', url }` after listening; send diagnostics to stderr. Give startup 10 seconds and graceful shutdown 5 seconds before terminating only the owned child.
- [x] Set `strict: true` and match the exact model plus `format: 'openai-chat'`. Fixed reply text is `Local reply.`; streamed text is `This reply is streamed locally without live credentials.` with a 150 ms chunk delay. Export these expected strings from the scenario module. For the tool model, match `hasToolResult: false` plus declared `history_search`, call it with `{ query: 'local' }`, then match `hasToolResult: true` and answer `Local tool finished.`. Do not spend a global one-call budget that would break later chats. Use HTTP `400` and `Scripted local provider error.` for the error model; stall the streaming model after one content chunk for 30 seconds. See [AI rule documentation][emulate-ai].
- [x] Implement the text-only, zero-cost local provider and validate its URL before transport creation. `check` reports API-key availability; `resolve` supplies the constant nonsecret `emulate-local` key without a login flow.
- [x] Use the first local smoke checks to make real Pi HTTP calls for streaming and tool-result continuation. Assert incremental output, the expected tool name/arguments, and final reply after its result. Run `bun --no-env-file tools/check-emulate.ts` for this first transport-only version. Expected: streaming and the tool continuation pass, and owned resources close. Stop and revisit the design if success requires replacing Pi or implementing another simulated transport.

### Task 2: Wire the isolated, preconfigured local catalog

**Files:** server, tenant and provider-catalog modules; new `emulate.test.ts`; existing `server.test.ts` and `tenant.test.ts`.
**Interfaces:**
- Consumes `EmulateProfile` and `emulateProvider` from Task 1.
- Extends `ServerOptions` (`apps/server/src/app/server.ts:124`) and `TenantOptions` (`apps/server/src/app/tenant.ts:103`) with `emulate?: EmulateProfile`; `tenantPool` forwards it before account restoration.
- Extends `accountModels(credentials, contributions, emulate?)` with an optional final profile argument, preserving existing two-argument callers. Its local branch uses `createModels` and only `emulateProvider`, not `builtinModels` or contributed live providers (`apps/server/src/providers/providers.ts:16,24`; SDK `apps/server/node_modules/@earendil-works/pi-ai/dist/models.d.ts:207–214`). Pass the explicit branch through the existing `ProviderModels.layer` factory seam (`apps/server/src/providers/providers.ts:43`, `apps/server/src/app/tenant.ts:207`).

- [x] Thread the explicit profile through startup and every restored/new account. Preserve normal defaults when absent. For the profile, choose loopback, isolated data and local auth origins before `startServer` restores accounts; ignore inherited `CRUMBLE_PUBLIC_URL` and `BETTER_AUTH_URL`.
- [x] Build only the preconfigured local catalog. Do not give it the account credential store or register live plugin-provider contributions. Restored bots referencing nonlocal providers fail as unavailable rather than falling back; secondary model selection obeys the same catalog.
- [x] Force an empty workspace configuration for this profile and supply an unconfigured `PushTransports` service instead of its ambient-environment layer (`apps/server/src/push/push-transports.ts:52`; `apps/server/src/app/tenant.ts:287`). Normal startup keeps its existing layers.
- [x] Add non-emulator assertions: `expect(providerIds).toEqual(['emulate'])`; model IDs equal `EMULATE_MODEL_IDS`; empty-store auth resolves to `emulate-local`; non-loopback/credential-bearing URLs reject; a supplied live plugin provider is absent. Test new and restored account catalogs and preserve the existing ordinary host-key-isolation tests.
- [x] Run `bun test apps/server/src/providers/emulate.test.ts apps/server/src/app/tenant.test.ts apps/server/src/app/server.test.ts`. Expected: pass without starting Emulate or contacting external services.

### Task 3: Add the development command and process ownership

**Files:** supervisor/app entry points; process helper and its new unit test; `package.json`; documentation and changelog.
**Interfaces:**
- Consumes `startEmulate` and `EmulateProfile` from Tasks 1–2.
- Adds `startLocalApp(options: { baseUrl: string; dataDir: string; port: number; watch?: boolean }): Promise<{ url: string; close(): Promise<void> }>` to `tools/emulate-process.ts`. It owns the Bun app child, accepts port `0` for smoke checks, and shares the readiness/cleanup contract from Task 1.
- Produces `bun run dev:emulate`; the supervisor owns one sidecar and one watched app child. Use Bun's verified `--no-env-file`, `--watch`, and `--watch-kill-signal=SIGTERM` flags. Reloading the app does not restart the sidecar.
- The app entry point calls `startServer({ dataDir, hostname: '127.0.0.1', port, workspaceEnv: {}, emulate: { baseUrl } })`. Existing startup returns `{ server, auth, close }` (`apps/server/src/app/server.ts:421,467`); signal handlers await `close()` before exit.

- [x] Add an allowlisted child environment containing only needed OS/runtime variables such as `PATH`, `HOME`, temporary-directory and locale settings. Do not forward `CRUMBLE_*`, `BETTER_AUTH_*`, provider keys, `BUN_OPTIONS`, or `NODE_OPTIONS`; disable Bun dotenv loading in the app child. Pass explicit profile arguments, not inherited app configuration. Unit-test this filtering with dummy values and no subprocess or emulator.
- [x] Resolve profile paths relative to the repository, not the caller's directory. Start on `127.0.0.1:7338` with `.cache/emulate/data`. Reject the ordinary `data` location, and never auto-delete accounts or chats. Non-emulator tests verify that inherited data/listener/push/workspace values cannot override the profile.
- [x] Start Emulate before the watched app, then log addresses, data location, and scenario names. A missing Node executable or version below `24` produces an actionable error without installing anything. Readiness is the app's actual listening URL, not a guessed fixed address.
- [x] On interrupt, child exit, or partial startup failure, close owned child processes, including the watcher, using bounded graceful shutdown. Refuse an occupied app port; never terminate its listener. No failure path launches an ordinary/live app as fallback.
- [x] Document local account creation, scenario selection, Node/Bun prerequisites, retained data, and limits. Add an Unreleased entry.
- [x] Run `bun test tools/emulate-process.test.ts`. Then verify the actual web app: create a local account/bot without provider sign-in, exercise each scenario, reload the app, and confirm the account/transcript persist with one emulator listener. Stop the command and confirm both owned listeners close.

### Task 4: Verify the complete local path without changing CI

**Files:** extend `tools/check-emulate.ts` from Task 1; local-command documentation; `package.json` command entry.
**Interfaces:**
- Consumes `startEmulate` and `startLocalApp` from Tasks 1–3.
- Produces `bun run check:emulate`, running `tsc -p tools && bun --no-env-file tools/check-emulate.ts`. The existing `tools/tsconfig.json` extends the strict base configuration; root `typecheck` currently covers only server/web. The command returns nonzero on failed assertions and cleans up owned resources. The smoke script imports no `bun:test` hooks and has no default-test filename.
- Signup: `POST /api/auth/sign-up/email` with a dummy `name`, unique `example.test` email and password; use the returned token as `Authorization: Bearer TOKEN` (`apps/server/src/app/server.test.ts:46–65`).
- Create each bot with `POST /v1/agents`, explicit `provider: 'emulate'`, its scenario model ID, and reviews disabled; ordinary schema defaults cover the remaining fields (`apps/server/src/contract/agents.ts:51`; `apps/server/src/contract/api-contract.ts:714`).
- Submit `{ content, requestId: crypto.randomUUID() }` to `POST /v1/agents/ID/messages`; read `GET /v1/agents/ID/chat` and `GET /v1/agents/ID/events?partial=true`; stop with `POST /v1/agents/ID/abort` (`apps/server/src/contract/api-contract.ts:154,853,948,963`).

- [x] Start the actual app with `startLocalApp({ baseUrl, dataDir: TEMP_DIR, port: 0 })`, using clean child configuration and shared scenarios. Complete normal signup and assert provider discovery is already configured with exactly five local models before creating any bot or credential.
- [x] Assert exact fixed/final tool reply text from Task 1, at least two distinct nonempty partial-stream snapshots before completion, and the real tool arguments/result in the transcript. Confirm `GET /_ai/calls` shows the matching tool-call and tool-result rules rather than a default reply.
- [x] Assert a visible failed turn for the HTTP `400` model; a stalled turn accepts `/abort` and stops running; after closing Emulate a new turn fails rather than succeeding through another provider. Every wait has a deadline and every stream is canceled in cleanup. Verify unmatched raw model requests fail under strict mode.
- [x] Verify new/restored local accounts retain only the local catalog; a changed emulator port after restart cannot restore an old model endpoint. Exercise watcher reload, partial startup failure, and occupied-port cleanup with owned temporary resources. Preserve pre-existing listeners and non-test data. Do not add emulator startup to ordinary tests or any workflow.
- [x] Run `bun run check:emulate`, root `bun run check`, and `bun fmt --check tools/dev-emulate.ts tools/check-emulate.ts tools/emulate-*.ts`. Run `bun run check` in `apps/docs`, installing its dependencies with `bun install --frozen-lockfile --ignore-scripts` first if necessary. Report failures, skips, and unverified manual scenarios honestly.
- [x] Get a fresh-context `vet` review against the approved spec and this plan's Deviations. Resolve in-scope defects and rerun affected checks. Do not commit or stage without permission.

## Verified API sources

- [Published Emulate `0.14.0` metadata][emulate-package] and [API types][emulate-api]: `hostname`, root `seed.ai`, ephemeral ports, and awaitable close.
- [Pinned upstream runtime requirement][emulate-runtime]: Node `24+`. Local `node --help` confirms `--experimental-strip-types`; keep the sidecar's TypeScript erasable.
- [Pinned AI documentation][emulate-ai]: strict mode, model/format/tool-result matching, timing, native errors, and stalls.
- Pi SDK declarations cited in Task 1 were read from the existing checkout's installed `@earendil-works/pi-ai@1.4.0`; install this worktree's matching locked version before implementation. No runtime compatibility claim follows from those type definitions.

## Deviations

- Task 1 · added `emulateModels(baseUrl)` alongside `emulateProvider` so application catalogs and the transport probe share the same fixed-auth factory.
- Task 1 · declared the already-used `@earendil-works/pi-ai@1.4.0` as an exact root development dependency as well. Root tooling consumes its schema/types directly; this avoids importing through a workspace's `node_modules` path. No new SDK or production dependency was selected.
- Task 2 · retained the existing `app/tenant.test.ts` host-key-isolation tests unchanged. Added the new signup/restore assertions to `server.test.ts` and the pure provider suite instead.
- Tasks 2–3 · canonicalize local/ordinary data paths, including existing symlink parents, and reject overlapping directories. A fresh review found a filesystem-root edge case in the initial prefix comparison; a pure predicate regression failed before the separator-safe `relative` fix and passed afterward. No filesystem-root startup was attempted.
- Task 3 · declared the existing server dependency `zod@4.6.7` as a matching root development dependency for subprocess readiness/argument validation. It introduces no new production library.
- Task 3 · verified signup, provider selection, streaming, tool reply, provider error, Stop, fixed reply, and persistence across watcher reload in an isolated headless Helium profile. UI interactions and same-origin API submissions used only the generated local account. A screenshot is kept under ignored `.cache/emulate/`.
- Task 4 · failed executions produce an idle chat snapshot with `error`, not a snapshot whose status is `failed`. The smoke command correlates execution status by request ID and separately checks the transcript/error. It also confirms the stalled HTTP stream records `client_aborted`.
- Task 4 · additional temporary local lifecycle checks verified preserved occupied listeners, failed-start cleanup, idempotent close, closed listeners, and an actionable missing-Node error.
- Shipping checks · registered the two subprocess entry points in `.fallowrc.json`, since they are launched by path rather than imported. No analysis rule was disabled.

## Verification results

- Initial root `bun run check`: passed; 1,302 tests passed, 118 skipped, no failures (test phase 15.41 seconds locally).
- After integrating current `main`: root `bun run check` passed with 1,332 tests passed, 118 skipped, and no failures (15.86 seconds locally). The local Emulate smoke command and docs checks also passed again.
- `bun run check:emulate`: passed; real Pi transport, eight partial snapshots, actual local tool execution, provider error, stream abort confirmed as `client_aborted`, strict rejection, no fallback, restored transcript on a new emulator endpoint, and occupied-listener preservation.
- `apps/docs` `bun run check`: passed; no doctor or link-validation problems.
- Tool formatting and Git whitespace checks: passed.
- Fallow audit: passed after registering subprocess entries; warnings remain for development-tool dependency classification and complexity.
- Isolated browser walkthrough: passed; no live provider credentials used. Watcher reload retained the account and transcript. SIGINT exited the development supervisor with code zero and both listeners were confirmed closed.
- Fresh-context review: the single data-directory containment defect was fixed and verified in a follow-up review. No remaining concrete findings were reported. CI itself was not run or changed.

[emulate-package]: https://registry.npmjs.org/emulate/0.14.0
[emulate-api]: https://unpkg.com/emulate@0.14.0/dist/api.d.ts
[emulate-runtime]: https://github.com/vercel-labs/emulate/blob/66dc87dda12fdfc3b389dbeffb298c5128fe53c4/package.json#L28
[emulate-ai]: https://github.com/vercel-labs/emulate/blob/66dc87dda12fdfc3b389dbeffb298c5128fe53c4/apps/web/content/docs/ai.mdx
