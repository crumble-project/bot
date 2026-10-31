# Discord message gateway implementation plan

**Goal:** Message existing Crumble bots from Discord, with a default recipient and explicit bot routing.
**Architecture:** Platform adapters contribute through `CrumblePlugin`. A shared gateway owns authorization, routing, persistent receipt tracking, submission to the existing bot chat, and delivery of the associated answer. Discord uses an outbound connection.
**Source:** Owner decisions in this chat, 2026-10-31.

## Decisions

- Discord is the only platform implemented now.
- Adapters are compiled in today. Installation without rebuilding belongs to a later change.
- New messages go to the configured default bot; a leading `@handle` selects a bot for that message only.
- A reply to a gateway answer selects its answering bot, unless a prefix overrides it.
- Gateway input and answers live in the existing bot transcript. Preserve the original message text.
- Only answers associated with gateway requests return to their originating destination. Never mirror other transcript activity.
- Configure exactly one owner user ID and allowed channel IDs. Only the owner can submit messages, with bot-chat owner authority. Direct messages have a separate enable switch. Default to disabled until configured. Legacy sender allowlists fail closed and require owner reconfiguration.
- Stable aliases map handles to bot IDs. Exact bot names may also resolve when unambiguous. Unknown or disabled recipients produce a routing error, never silently fall back.
- Retry retryable failures with persisted scheduling, starting at 5 seconds and capped at 15 minutes. Honor longer platform waits. Stop after 10 failures or 24 hours from receipt.
- Clear terminal gateway payloads immediately. Reply routing expires after 30 days; hourly cleanup removes compact duplicate receipts and indexed reply associations after that window.
- Failed connection attempts and explicit invalidation reconnect with 60-second exponential backoff capped at 15 minutes, resetting after five minutes continuously connected. Diagnostic errors don't replace a live client.
- Start with text messages. Explain unsupported attachments rather than silently discarding them.

## Constraints

- Use the existing Bun, Effect, Drizzle, Zod, React, and UI conventions.
- Read `apps/server/node_modules/effect/AGENTS.md` completely before Effect edits.
- Prefix shell commands with `trs`. Use Context7 for dependency documentation.
- No commits, live Discord messages, deployment, or real credentials are needed for implementation.
- Required checks: `bun run check` at the root and `bun run check` in `apps/docs`.
- Keep adapters behind an open string ID and a narrow interface; no core Discord branching.

## Out of scope

Other platforms, dynamic plugin installation, a plugin marketplace, transcript mirroring, voice, and attachment processing.

## Review focus

1. Replayed Discord events create one execution; crashes and retries preserve the originally selected bot and destination.
2. A newer app message or another gateway request cannot supply the wrong response. Read by submission ID, not the latest transcript entry.
3. Only the configured owner and explicitly allowed destinations submit work; bot/webhook messages cannot create loops.
4. Replies route correctly after restart, and prefix selection does not persist as the next message's default.
5. Long replies and failed sends retain delivery progress; reconnect or credential replacement cleans up the old connection.

## Shared adapter interface

New `apps/server/src/message-gateway/adapter.ts` exports these types:

```ts
export type GatewayMessage = {
  id: string;
  channelId: string;
  senderId: string;
  text: string;
  routingText?: string;
  isDirectMessage: boolean;
  replyTo?: string;
  hasAttachments?: boolean;
};
export type GatewayStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";
export type GatewayConnection = {
  send(input: {
    channelId: string;
    replyTo?: string;
    text: string;
    nonce: string;
  }): Promise<string>;
  close(): Promise<void>;
};
export type ChatAdapter = {
  id: string;
  label: string;
  secretKey: string;
  maxMessageLength: number;
  connect(host: {
    token: string;
    onMessage(message: GatewayMessage): Promise<void>;
    onInvalidated(error?: string): void;
    onStatus(status: GatewayStatus, error?: string): void;
  }): Promise<GatewayConnection>;
};
```

Gateway configuration per adapter: `enabled: boolean`, `defaultBotId: string | null`, `ownerId: string | null`, `allowedChannelIds: string[]`, `allowDirectMessages: boolean`, `aliases: { handle: string; botId: string }[]`.

The backend agent publishes exact HTTP routes and Zod response schemas to the UI agent before UI implementation. This is an implementation handoff, not an unresolved product decision.

## Files and delegated tasks

### Task 1: Gateway core and server integration

Own new `apps/server/src/message-gateway/` except the `discord/` subdirectory; modify `apps/server/src/plugins/plugins.ts`, server contract files, `apps/server/src/app/api.ts`, `apps/server/src/app/tenant.ts`, persistence wiring and migrations as needed.

- [x] Create the shared adapter types and publish HTTP configuration/status interfaces to the UI agent.
- [x] Add `chatAdapters?: ChatAdapter[]` to `CrumblePlugin`, with contribution discovery.
- [x] Implement validated configuration, durable inbound receipts and outgoing delivery progress, deterministic routing, and scoped background processing.
- [x] Integrate existing `Bots.sendChat` and submission-specific `BotRuntime.response`.
- [x] Add tests covering all five review cases, fake adapters, and real persistence reopen.
- [x] Update the contract version and regenerate OpenAPI.
- [x] Run focused backend checks.

### Task 2: Discord adapter

Own new `apps/server/src/message-gateway/discord/`, `apps/server/package.json`, root `bun.lock`, and `apps/server/src/app/builtin-plugins.ts`.

- [x] Implement the shared adapter interface and a Discord plugin contribution with a token setting.
- [x] Use a maintained Discord SDK for reconnects, heartbeat and REST rate limits, verifying current documentation.
- [x] Receive DMs and configured channel traffic; ignore bot/webhook messages; remove only the native mention of the Discord application when needed for prefix parsing, coordinating transcript preservation with core.
- [x] Send replies with mentions disabled, stable nonces, message references, and connection cleanup.
- [x] Test normalization and sending without contacting Discord.

### Task 3: Settings UI

Own new gateway UI under `apps/web/features/settings/`, integration into `settings.tsx`, and relevant exports in `apps/web/lib/api.ts`.

- [x] Consume the backend configuration/status contract after it is published.
- [x] Expose token configuration through existing plugin settings, default bot, owner ID/channel restrictions, DM switch, aliases, enable/disable, connection status, and actionable errors.
- [x] Reuse existing form and settings components; preserve unsaved edits during status refresh.
- [x] Run web type checks and focused validation.

### Task 4: Documentation and verification

Own documentation in `apps/docs`, a gateway adapter developer guide, and relevant changelog/glossary changes. Coordinate factual setup details with the Discord adapter agent.

- [x] Document Discord setup, owner IDs/channel restrictions, routing examples, transcript behavior, text-only scope, and retry limitations.
- [x] Document the compiled-in adapter interface and deferred external loading.
- [x] Run the docs check and report results.

The coordinator performs integration review and root checks, returning fixes to the responsible agents. The owner has already requested agent implementation; no additional plan approval is required.

## Verification

- Initial root `bun run check`: passed, 823 tests passed, 116 skipped, zero failed.
- After review fixes, root `bun run check`: passed, 848 tests passed, 116 skipped, zero failed. Eight additional offline adversarial probes passed.
- Owner-only settings DOM regression: passed. Rejects multiple owner IDs, preserves edits across status refresh and a failed disable with a deleted bot, and shows failed receipt counts.
- `bun run contract:validate`: passed.
- `bun run check` in `apps/docs`: passed.
- Settings verified in a mocked browser and with a DOM regression test.
- Read-only agent review completed with no unresolved findings.
- No live Discord credentials or messages used.
