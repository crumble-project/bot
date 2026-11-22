# Credential-free local development

**Status:** approved

## Problem

Exercising Crumble locally requires live provider credentials. Developers need repeatable bot replies, streaming, tool activity, and failures without connecting personal accounts or paying for model calls.

The existing `fauxProvider` tests cover runtime behavior, but they do not provide an interactive development environment through Pi's real HTTP transport.

## Solution

Add an opt-in `bun run dev:emulate` command that starts Emulate and Crumble together. The web app offers a clearly named local provider with deterministic scenarios. After creating a normal local account, developers can create bots and exchange messages without entering provider keys.

This first slice covers model-dependent bot chat and local tool execution. It does not emulate every external service Crumble supports.

## Behavior

1. Starting the command launches the AI emulator on IPv4 loopback before starting Crumble. Crumble defaults to `127.0.0.1:7338` and an isolated `.cache/emulate/data` directory. Startup prints the app address, emulator address, data location, and scenario names.
2. The local provider is already configured with nonsecret dummy authentication. The model picker offers only local scenario models in this profile. Normal account creation and sign-in remain unchanged.
3. Named scenario models provide a fixed reply, a visibly streamed reply, a tool round trip, a provider error, and a stalled stream that the owner can stop. Scenario selection uses the existing model picker, not a new settings screen.
4. The tool scenario calls the existing `history_search` tool, receives its result, and returns a final reply. It needs no workspace, external MCP server, or network service. The transcript shows the actual tool activity.
5. Scenario rules are deterministic and bounded. Unknown models or unmatched requests fail visibly rather than producing an accidental successful test. A provider error follows Crumble's existing error handling and retry behavior.
6. If the emulator fails to start or becomes unavailable, the command or affected model call fails clearly. No model request falls back to a live provider. An occupied app port fails rather than terminating another process.
7. Stopping the command closes the app and emulator. Development reloads do not leave duplicate listeners or orphaned child processes. Emulator state resets on restart; local account and chat data persist. No existing database is deleted automatically.
8. Ordinary `bun run dev`, production startup, existing accounts, and faux-based tests retain their behavior. The profile never opens the ordinary `data` directory or imports saved provider credentials from another installation.

## Decisions

- Keep `fauxProvider`: replacing the existing test suite would add migration work without solving the immediate local-development problem.
- Start with one OpenAI-compatible protocol through Pi's existing HTTP transport. Follow the explicit provider URL pattern in `apps/server/src/providers/melious.ts`; do not implement another fake Pi provider.
- Register the local provider only in the explicit development profile. Do not expose a generic provider URL setting or modify production provider endpoints.
- Restrict model availability to local scenarios in this profile. Adding an emulator provider beside live providers is insufficient to prevent accidental live model calls.
- Use a pinned development dependency for Emulate. Keep Bun for Crumble and its package management. Check Emulate's supported Node runtime when launching it; do not assume Bun compatibility or install global tools automatically.
- Preserve the no-emulators-in-CI policy. Emulator-backed verification runs only through a separate local command, outside default test discovery and `bun run check`.
- Seed no external integrations or network-capable workspace. This is not a process-wide network sandbox: bundled scenarios and model routing are local, but arbitrary integrations enabled manually are outside this guarantee.

## Interfaces and data

- New development and local-verification commands; no public API contract or database schema change.
- Reuse `startServer` listener/data options and account-scoped model construction. Profile selection must happen before account restoration.
- New scenario definitions are shared by interactive development and local verification.
- Ignore generated profile state through the existing `.cache` rule. Never copy, overwrite, or remove ordinary installation data.

## Affected code

- `package.json` and `bun.lock`: development dependency and explicit commands.
- `tools/dev-emulate.ts` and `tools/emulate-scenarios.ts` (new): lifecycle ownership and deterministic scenario definitions.
- `apps/server/src/providers/emulate.ts` (new): local model metadata and Pi HTTP provider configuration, following `providers/melious.ts`.
- `apps/server/src/app/server.ts`, `apps/server/src/app/tenant.ts`, `apps/server/src/app/builtin-plugins.ts`, and `apps/server/src/providers/providers.ts`: opt-in profile wiring before restoration, preserving ordinary account credential isolation.
- `tools/check-emulate.ts` (new): separately invoked local smoke verification.
- `apps/docs/content/contributing/index.md` and `CHANGELOG.md`: setup, scenario selection, limitations, local verification, and the new command.

## Testing

Approved testing seams:

- Configuration/lifecycle checks that need no emulator can remain in the ordinary suite. They verify explicit opt-in, loopback restrictions, isolated data selection, and unchanged normal startup defaults.
- A separate local smoke command uses real Pi HTTP requests and Crumble's authenticated API/runtime. It verifies incremental streaming, the `history_search` round trip, provider errors, stopping a stalled reply, and failure without live fallback. Use `apps/server/src/app/e2e.test.ts` as prior art for submission and transcript persistence, without replacing that test.
- Manual verification in the actual web app confirms a new local account can select a scenario and receive replies without provider sign-in.

Run `bun run check` and `bun run check` in `apps/docs` after implementation. Do not add emulator-dependent checks to any CI workflow.

Pi/Emulate compatibility is not yet proven. A successful real HTTP streaming and tool-call exchange is a prerequisite for claiming the feature works. If compatibility requires replacing Pi or creating another simulated transport, stop and revisit the design.

## Out of scope

- Wholesale faux migration or changes to CI policy.
- GitHub, Google Workspace, push, payment, or other service emulation.
- Credential-free real inference, model-quality evaluation, or emulated browser interfaces.
- Workspaces, desktop jobs, gateway provisioning, or automatic account/bot seeding.
- New production settings, authentication bypasses, or automatic data resets.

## Open questions

None.
