# Crumble architecture and delivery

Crumble is a single-owner, self-hosted personal agent server and an independent macOS application. The authenticated HTTP API is versioned under `/v1`. The desktop never imports server implementation code.

## Boundaries

- Product metadata lives in a SQLite database: agent profiles, the canonical chat record per bot, memory, schedules, execution history, integrations, and settings.
- Each agent owns a separate Pi Durable SQLite database. Pi owns conversation entries, model requests, tool calls, checkpoints, cancellation, retries, and stream state. Product code does not recreate its agent loop.
- Providers run on the server. Credentials are encrypted at rest using an installation key with owner-only permissions. Backups must include the key; encryption does not protect against a compromised server account.
- The API requires a bearer token, including for streams. The server binds loopback by default. Remote deployments require TLS through a trusted reverse proxy.
- An agent's enabled tools and MCP servers are explicit capabilities. No general host shell or unrestricted filesystem access is implied by an agent's instructions.
- One server process owns the data directory. Clients can reconnect and retrieve committed state without owning execution.

## Bot messaging

`BotMessaging` is the seam for communication between bots. Its interface has three operations: list permitted recipients, send a message with a stable request ID, and retrieve its result with an optional bounded wait. It owns exact-name resolution, ambiguity errors, current permissions, capacity limits, receipt ownership, and replay deduplication. `coordinationExtension` adapts this interface into model tools; it contains no dispatch policy.

Messages use the existing `CrumbleService.send` execution transport and the recipient's continuous chat. `ask_bot` waits on the durable submission, with a caller cancellation context and a 60-second limit. Cancelling the caller stops its waiter; the recipient's already admitted work continues. A timeout returns a pending receipt for a later check. Existing `delegate` and `delegation_status` tools use the same messaging module. Bot requests cannot initiate another delegation, preventing cycles between waiting bots.

Only the message and sender identity enter the recipient's model context. Only the completed response to that execution returns to the sender. Per-bot permission lists remain authoritative at dispatch and result access. A name collision requires an explicit bot ID rather than guessing.

Source chats store sent messages and observed terminal replies as data-only Pi transcript entries. These writes use stable request IDs, survive reconnects, and do not start extra model turns. The desktop renders them as bot communication cards with explicit sender, recipient, and status. The recipient's chat marks the incoming message with the sender's identity. Delivery is not a separate inbox or a second conversation system.

## Bot schedules

`BotSchedules` lets a bot list, create, update, delete, and run tasks. Every schedule targets one bot (`agentId`): the bot whose chat runs the prompt. The owner API and the desktop task form set that target explicitly. A bot with the `schedule` capability can target itself, or a bot it is allowed to message. It can change tasks that run on it and tasks it created. Owner-created tasks have no creator bot. `scheduleExtension` is the model tool; the scheduler still owns cron validation, next-run times, and dispatch.

## Inline visuals

`displayExtension` gives every bot the `show` tool. It validates one component (`stats`, `table`, or `chart`) and returns it as the tool result's `details`, which the transcript exposes as `toolDetails`. Clients render successful `show` results inline in chat; other tool results stay hidden. The tool is model-only (`callers: ["model"]`), so code mode offers it beside the code mode tool instead of to scripts.

## Verifiable milestones

1. Persistent agent lifecycle and actual Pi Durable conversation submission, cancellation, streaming, reopen, and isolation tests.
2. Native SwiftUI macOS client: connection setup, agents, conversation history, streamed chat, settings, memory and tasks. Build and exercise against the real server.
3. Persistent one-time and cron schedules, background execution history, failure and restart recovery, capability-configured skills and MCP tools.
4. Inter-agent delegation, diagnostics and parity acceptance tests. Refine empty, loading, offline, keyboard and accessibility behavior.
5. Product hardening: realistic crash/reconnect tests, native visual inspection, installation/backup documentation and an honest parity audit.

## Constraints

Pi Durable is experimental. Pin its package versions and validate migrations before upgrading. Initial scope is one authenticated owner, not multi-tenant hosting. Metadata and Pi stores have separate transactions; durable request IDs bridge dispatch/recovery so retrying admission does not duplicate a user turn.

See [product-parity.md](product-parity.md) for researched reference capabilities and acceptance criteria. A milestone being implemented does not imply the overall production-quality goal has been met.
