# Provider adapter decisions

- Status: Accepted
- Scope: server provider integrations, especially Claude Code feature 0006

## Decision

- Provider catalogs and credentials remain account-scoped. Model discovery and authentication use saved credentials; host environment values and files are not an implicit source of account credentials. Credential listings expose metadata without decrypting API keys. See [ADR 0004](0004-plugin-interfaces.md) for the provider contribution boundary.
- Claude Code runs as a constrained server child process: Crumble supplies the MCP tool inventory, disables its built-in tools and machine configuration, and runs one native turn per request. Crumble, not the CLI, executes offered tools. The CLI's session ID is stable for a conversation so native cache prefixes remain reusable.
- A per-request loopback admission relay admits only one upstream model request. Authorization headers pass through memory and are neither logged nor retained. The relay forwards unexpected or unprovable payloads unchanged except where a request is explicitly rejected; restoration of the host's tool-result frame is applied only when it can be proven lossless.
- Incomplete streamed tool arguments are never executed. Captured calls are accepted only after the complete upstream response is verified; if any call is truncated, the response fails rather than guessing arguments or executing a partial set.
- Request rewriting preserves native cache semantics within Anthropic's four-breakpoint limit. Recurring breakpoints stay on content replayed unchanged, and a separate mark protects open-turn thinking when the normal lookback would not reach it. Tool and system marks are preserved; uncertain frames are forwarded unchanged.
- Sign-in sessions and authorization links/codes are transient. Saved credentials are encrypted; provider errors are not exposed because they can contain token responses. Per-provider write queues serialize refresh, login, key replacement, and sign-out. A login commits only if it remains current, and the guard/write/state transition is synchronous.

## Consequences

These choices favor bounded authority and lossless forwarding over aggressive normalization. Protocol assumptions and fixture cases are exercised in the provider relay and setup tests. Provider source comments removed during the comment audit are not executable documentation; this ADR retains only the consequential constraints described above.
