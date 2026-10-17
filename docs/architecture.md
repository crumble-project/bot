# Crumble architecture and delivery

Crumble is a single-owner, self-hosted personal agent server and an independent macOS application. The authenticated HTTP API is versioned under `/v1`. The desktop never imports server implementation code.

## Boundaries

- Product metadata lives in a SQLite database: agent profiles, session names, memory, schedules, execution history, integrations, and settings.
- Each agent owns a separate Pi Durable SQLite database. Pi owns conversation entries, model requests, tool calls, checkpoints, cancellation, retries, and stream state. Product code does not recreate its agent loop.
- Providers run on the server. Credentials are encrypted at rest using an installation key with owner-only permissions. Backups must include the key; encryption does not protect against a compromised server account.
- The API requires a bearer token, including for streams. The server binds loopback by default. Remote deployments require TLS through a trusted reverse proxy.
- An agent's enabled tools and MCP servers are explicit capabilities. No general host shell or unrestricted filesystem access is implied by an agent's instructions.
- One server process owns the data directory. Clients can reconnect and retrieve committed state without owning execution.

## Verifiable milestones

1. Persistent agent lifecycle and actual Pi Durable conversation submission, cancellation, streaming, reopen, and isolation tests.
2. Native mygo macOS client: connection setup, agents, conversation history, streamed chat, settings, memory and tasks. Build and exercise against the real server.
3. Persistent one-time and cron schedules, background execution history, failure and restart recovery, capability-configured skills and MCP tools.
4. Approval lifecycle, inter-agent delegation, diagnostics and parity acceptance tests. Refine empty, loading, offline, keyboard and accessibility behavior.
5. Product hardening: realistic crash/reconnect tests, native visual inspection, installation/backup documentation and an honest parity audit.

## Constraints

Pi Durable is experimental. Pin its package versions and validate migrations before upgrading. Initial scope is one authenticated owner, not multi-tenant hosting. Metadata and Pi stores have separate transactions; durable request IDs bridge dispatch/recovery so retrying admission does not duplicate a user turn.

See [product-parity.md](product-parity.md) for researched reference capabilities and acceptance criteria. A milestone being implemented does not imply the overall production-quality goal has been met.
