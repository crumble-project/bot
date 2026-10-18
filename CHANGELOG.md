# Changelog

## Unreleased

- Add the generated OpenAPI 3.1 contract at `openapi/openapi.json` for all 49 HTTP endpoints, including authentication and event payload schemas.
- Add offline `bun run openapi:generate` and `bun run openapi:check` commands. Include contract drift detection in `bun run check`.
- Bind HTTP handlers to shared route definitions while preserving existing request parsing and PATCH behavior.
