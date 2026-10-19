# Changelog

## Unreleased

- Add `GET /v1/capabilities`, `GET /v1/agents/{id}/coding-jobs`, and `GET /v1/agents/{id}/coding-jobs/{name}/history`, so clients can tell whether coding is available, list a bot's jobs with their status, and page through a job's messages and tool calls.
- Add coding jobs. A bot with the `coding` tool can start, message, stop, and check named jobs that read, write, edit, and run commands in its workspace. Starting a job or messaging it ends the bot's turn, because clients show the job as a card; the chat preview reads "Coding job <name>". Each job's answer returns to the bot's chat once, including after a restart. Jobs have no memory, delegation, scheduling, integrations, or jobs of their own, and the bot's chat never gets a shell.
- Add Gondolin workspaces: one micro-VM per bot on a persistent, journaled disk. Jobs can make HTTP(S) requests to the internet through a replaceable network policy, which allows everything by default. Other protocols and private address ranges are blocked. The VM starts on first use and stops when idle. Set `CRUMBLE_WORKSPACE_IMAGE` to an image built from `workspace-image/gondolin.json` to enable them; without it, no bot is offered the `coding` tool.
- Remove the unused agent `folder` field from the API and drop its column from existing databases. Requests that still send `folder` are accepted and the value is ignored.
- Add a Docker image and Compose file. The build fetches and bundles the shared skills from GitHub at a configurable ref, runs as a non-root user, keeps the data directory and its lock on one volume, and checks `/health`.
- Teach the `show` tool to draw Sankey links as translucent bump curves with labels beside the nodes. TanStack's `link` mark is straight without a `curve`, so flows drew as overlapping slanted bars.
- Add the `react` tool: a bot can acknowledge a message with one emoji instead of replying. The reaction ends the turn, shows as "Reacted 👍" in chat previews and bot responses, and sends no reply notification.
- End the turn after a successful `show`, so a visual is not followed by a message restating it. Reply notifications now preview only text written after the latest input.
- Add the `show` tool: every bot can show the owner headline numbers, a table, or a chart inline. Charts are TanStack Charts code that `ChartCompiler` runs in a QuickJS sandbox and compiles into themed drawing primitives at two widths; clients never run code. Payloads are validated, and errors return to the model so it can fix them. Clients render the tool result's `toolDetails`. Model-only tools stay direct under code mode.
- Add the `chart_docs` tool, which serves the installed TanStack Charts examples and mark references.
- Accept an optional IANA `timezone` with chat messages, remember the latest valid one for the owner, and add the owner's timezone and local time to the bot clock.
- Rework the bot system prompt after Hermes Agent: recognize direct address, prefer concise but complete replies, and preserve relevant conversation instructions. Treat memory as context rather than authority, surface consequential issues, and move the clock to the end.
- Add the generated OpenAPI 3.1 contract at `openapi/openapi.json` for all 49 HTTP endpoints, including authentication and event payload schemas.
- Add offline `bun run openapi:generate` and `bun run openapi:check` commands. Include contract drift detection in `bun run check`.
- Bind HTTP handlers to shared route definitions while preserving existing request parsing and PATCH behavior.
