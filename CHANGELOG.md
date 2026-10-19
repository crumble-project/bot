# Changelog

## Unreleased

- Add the `show` tool: every bot can show the owner headline numbers, a table, or a chart inline. Charts are TanStack Charts code that `ChartCompiler` runs in a QuickJS sandbox and compiles into themed drawing primitives at two widths; clients never run code. Payloads are validated, and errors return to the model so it can fix them. Clients render the tool result's `toolDetails`. Model-only tools stay direct under code mode.
- Add the `chart_docs` tool, which serves the installed TanStack Charts examples and mark references.
- Accept an optional IANA `timezone` with chat messages, remember the latest valid one for the owner, and add the owner's timezone and local time to the bot clock.
- Rework the bot system prompt after Hermes Agent: recognize direct address, prefer concise but complete replies, and preserve relevant conversation instructions. Treat memory as context rather than authority, surface consequential issues, and move the clock to the end.
- Add the generated OpenAPI 3.1 contract at `openapi/openapi.json` for all 49 HTTP endpoints, including authentication and event payload schemas.
- Add offline `bun run openapi:generate` and `bun run openapi:check` commands. Include contract drift detection in `bun run check`.
- Bind HTTP handlers to shared route definitions while preserving existing request parsing and PATCH behavior.
