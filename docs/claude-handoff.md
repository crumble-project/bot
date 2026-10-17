# Crumble handoff for Claude

Continue in `/Users/leonhardbreuer/Developer/crumble-project`. There are two independent repositories: `bot/` (Bun/TypeScript server) and `desktop/` (native macOS, MyGo 0.5.5, Go 1.27). Preserve the uncommitted changes in both checkouts; they contain an unfinished migration.

## Latest user decisions

- Each bot has **one continuous chat**, like a WhatsApp DM. Remove sessions, new-chat controls, and conversation management from the product.
- Keep the entire transcript visible while Pi Durable compacts the smaller working context sent to the model.
- Replying to an old message must recall that message and bounded surrounding context. Persist the reply relationship and original display text.
- Use **DiceBear Critters** avatars. This works offline through the official Go generator, with stable seeds and a **New critter** profile control.
- Commit incrementally and **push both repositories** so the user can follow progress.

## Implemented

Server: Pi Durable 1.3.0, isolated SQLite stores per bot, authenticated API, encrypted provider keys, memory, schedules, execution history, MCP approvals, and bounded delegation. Desktop: native workspace, streaming, profiles, memory/task editors, integrations, and Critters avatars. The overall production-quality/parity goal remains unfinished; live providers have not been tested because no API keys are configured.

Pushed checkpoints: server `0e3c751`, `26827fd`, `6b615d9`; desktop `014cde2`, `af79a14`. Later integration changes remain **local and uncommitted**.

## Continue here

1. Finish the continuous-chat server integration in `src/runtime.ts`, `src/service.ts`, and `src/api.ts`. Runtime/service groundwork and reply persistence exist. Canonical chat API routes are still missing: `GET /v1/agents/:id/chat`, `GET /chat/history`, `POST /messages`, `GET /events`, `POST /abort`, and `POST /compact` under each agent.
2. Review `src/transcript.ts` and `docs/chat-runtime-research.md`. Full history comes from Pi's `entries()`; `viewState()` only contains active context. Keep Pi as the transcript source. Reply metadata uses agent-scoped entry refs, original text, and bounded quoted context. Add real Pi compaction/reply integration tests; current helper tests are lightweight.
3. Convert `desktop/controller.go`, `views.go`, and `main.go` to one chat per bot. `client.go` already contains canonical chat/history/reply methods. Implement older-history loading, reply previews, and preservation of loaded history during SSE updates. Remove obsolete session/archive UI. Scheduled and delegated work must appear in the same bot chat; current delegation still creates separate sessions and needs adaptation.
4. Verify compaction preserves visible history, old-message replies reach the model with bounded context, and retries/restarts preserve one input. Build, inspect the native app, then commit and push coherent checkpoints.

## Verified at handoff

- `bot`: `bun run typecheck` passes; `bun run check` has **32 passes, 2 failures** because API/recovery test doubles lack the new `runtime.openChat()` method.
- `desktop`: `go test ./...` currently fails at `controller.go:792`: `RestoreConversation` returns one value, but the unfinished archive controller expects two. Remove that superseded flow during the chat migration.
- Earlier native builds and race tests passed. The running app/server may use older code; rebuild/restart before visual verification.

Read `docs/product-brief.md` for the original goal; the continuous-chat decisions here supersede its multiple-session requirement. `GLOSSARY.md` in both working trees records the updated terminology.
