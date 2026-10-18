# Crumble handoff for Claude

Continue in `/Users/leonhardbreuer/Developer/crumble-project`. There are two independent repositories: `bot/` (Bun/TypeScript server) and `desktop/` (native macOS, SwiftUI, Swift 6.2, macOS 26 or later). The Go and MyGo client was retired on 2026-10-18 in favour of the SwiftUI app.

## Latest user decisions

- Each bot has **one continuous chat**, like a WhatsApp DM. Remove sessions, new-chat controls, and conversation management from the product.
- Keep the entire transcript visible while Pi Durable compacts the smaller working context sent to the model.
- Replying to an old message must recall that message and bounded surrounding context. Persist the reply relationship and original display text.
- Bot avatars are drawn in SwiftUI (`desktop/Sources/Crumble/BotAvatar.swift`) after Hermex's flat faces: a seeded shape and colour with capsule eyes that blink, sway and hop while working, and breathe while paused.
- Commit incrementally and **push both repositories** so the user can follow progress.

## Implemented

Server: Pi Durable 1.3.0, isolated SQLite stores per bot, authenticated API, encrypted provider keys, memory, schedules, execution history, MCP integrations, and bounded delegation. Desktop: native workspace, streaming, profiles, memory/task editors, integrations, and generated bot avatars. The overall production-quality/parity goal remains unfinished; live providers have not been tested because no API keys are configured.

Pushed checkpoints: server `0e3c751`, `26827fd`, `6b615d9`, `7340298` (continuous chat); desktop `014cde2`, `af79a14`, `a97bba0` (continuous chat).

## Continuous chat status

Done:

- Server routes under `/v1/agents/:id`: `chat`, `chat/history`, `messages`, `events`, `abort`, `compact`. Session routes (`/v1/conversations/*`, conversation create/list/archive/restore) are removed.
- The transcript comes from Pi `entries()` across every conversation in the bot's store, so legacy sessions are merged into one transcript. Pages end on entry boundaries.
- Replies persist `replyTo`, `replyPreview`, and quoted context IDs in the `crumble.message` entry. Pi deduplicates by `requestId`, so retries reuse one input.
- Delegation sends into the target bot's chat. `delegation_status` returns only the assistant output after that input. A bot with an active delegated execution cannot delegate.
- Desktop: one chat per bot, older-history loading that survives SSE snapshots, reply previews, origin labels for tasks and bots, a Compact control, and inline compaction summaries.
- Real Pi integration tests in `test/chat.test.ts` cover compaction, paging, replies, and restart idempotency.

Open:

- Live providers remain untested; no API keys are configured.
- The owner has exercised the SwiftUI app against a running server.
- Each SSE snapshot re-reads the newest page from every conversation in the bot's store. Watch this once chats grow or many legacy sessions exist.
- Pi skips compaction while recent context is under 20,000 tokens, so Compact appears to do nothing in short chats. Decide whether the UI should say so.

## Verified at handoff

- `bot`: `bun run check` passes (38 tests).
- `desktop`: `swift test` and `./scripts/build-app.sh` pass.

Read `docs/product-brief.md` for the original goal; the continuous-chat decisions here supersede its multiple-session requirement. `GLOSSARY.md` in both working trees records the updated terminology.
