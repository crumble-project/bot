# Changelog

## Unreleased

- Send a heartbeat as soon as `GET /v1/events` opens. Browsers expose a streamed response only after its first body chunk, so on a server without bots to replay previews for, web clients waited up to 15 seconds to connect.
- Add a web UI at `/ui`, served by the server itself, with the macOS app's abilities: the native apps' drawn bot avatars, live in the sidebar, details, and editor; bot chats with live replies rendered as Markdown, including Mermaid diagrams drawn by Pele, which the server serves unbundled under `/ui-modules/pele` so each diagram type loads only when shown; attachments, replies, reactions, @mentions, display cards and charts, coding and desktop job details, and earlier-message loading; group chats; the full bot editor; a details panel with routines and memory; the bot desktop with take control and hand back; Memory, Tasks, and Activity pages; settings with General, Providers (account sign-in and API keys in one list), Integrations (including MCP OAuth), and Skills sections; and browser notifications for replies. It is built with React, TanStack Router, TanStack Query, Tailwind CSS, and shadcn/ui, bundled by Bun on first request, and keeps the server token in the browser's local storage.
- Upgrade Pi to 1.4.0 (chord, pi-ai, pi-codemode, pi-durable, pi-env, pi-mcp). Opening a bot's or group's storage migrates it to pi-durable's SQLite schema version 2, which 1.3.0 cannot open: back up the data directory before upgrading, because a server cannot go back to an earlier release afterwards. A task cut off by 5 crashes in a row is now parked instead of run again.
- Add provider account sign-in through Pi AI, such as ChatGPT, Codex, Claude, and GitHub Copilot ([feature 0004](https://github.com/crumble-project/spec/blob/main/features/0004-provider-account-login.md)). Clients start a sign-in session on the server and relay its steps: links, device codes, and text, secret, selection, and pasted-code prompts. Sessions end after 10 minutes without an answer, 30 minutes in total, or a server restart. Provider credentials are now typed and encrypted in a new `provider_credentials` table; saved API keys move there on startup, so back up the data directory before upgrading. Pi AI refreshes account tokens; the server serializes refreshes, sign-ins, key changes, and sign-out per provider. One credential store and model catalog now serve the API and every bot. `GET /v1/models` lists only models the saved or ambient credential can use.

- Add `history_search` and `history_read` model tools for searching original message text and reading surrounding messages after compaction. Bot chats can retrieve their own messages and current groups; group turns can retrieve only their shared group messages. Results are bounded, reuse a fixed search cutoff, and recheck current access. Existing group lookup and the public HTTP contract are unchanged. Indexing is deferred.

- Start the bot desktop's Chromium without the "Restore pages?" bubble. Stopping the machine kills Chromium, so it offered to restore pages after every boot, in front of the owner and the desktop job. Needs a rebuilt desktop image.
- Tell bots to send to an existing desktop job to check or continue its work, since a new job repeats everything, such as submitting a form, and to ask the owner before retrying anything that submits, buys, or sends. Tell desktop jobs to look at the screen after an unverifiable action and to check boxes and choices before submitting.
- Notify the owner of the bot's answer to a coding or desktop job's report. Reports reach the bot's chat without an execution, so these answers sent no reply event before; a desktop job asking for a login only reached the owner if they opened the chat. The job reporter now waits for the bot's answer and announces it once as a `reply` event with origin `coding` or `desktop` and the new `jobName`, through the activity stream and push. Reactions and tool calls without text announce nothing.
- Let the owner watch and take control of a bot desktop. `POST /v1/agents/{id}/desktop/viewer` issues a single-use link to a server-hosted noVNC page whose WebSocket reaches the bot desktop's VNC server through an exec stream; the link expires after a minute and is spent when its WebSocket connects. `PUT /v1/agents/{id}/desktop/control` takes control (`owner`) or hands it back (`bot`), and `GET /v1/agents/{id}/desktop/events` streams each change. The viewer's keyboard, pointer, and clipboard input reaches the bot desktop only while the owner holds control. Meanwhile the bot's desktop job waits at its next `computer_use` call, without a time limit; after hand-back it refuses actions it planned before and captures first. The lease is stored, so the owner keeps control across server restarts and client disconnects. An open viewer or an owner holding control keeps the bot's machine from its idle stop.
- Report each job's own token usage and cost in `GET /v1/agents/{id}/coding-jobs` and `GET /v1/agents/{id}/desktop-jobs`, as the `usage` field the chat snapshot already has for the bot's chat. Jobs run in their own conversations, so their spend was not visible before.
- Add `GET /v1/agents/{id}/desktop-jobs`, `GET /v1/agents/{id}/desktop-jobs/{name}/history`, and the `desktop` capability. Bots get the `desktop` tool only when the server has a desktop workspace image (`CRUMBLE_WORKSPACE_DESKTOP_IMAGE`). Adding or removing a bot's `desktop` tool restarts its workspace machine with the image it needs. Group turns cannot start desktop jobs.
- Add desktop jobs. A bot with the `desktop` tool hands work to desktop jobs: background agents that operate its bot desktop with the `computer_use` tool, one job at a time, and report to its chat like coding jobs. They have no shell, memory, delegation, scheduling, or integrations. A job runs on the bot's new `desktopModel`, or on the bot's own model when it is unset. The chat preview reads "Desktop job <name>". Contract 1.4.0 adds `desktopModel` to agents.
- Keep each bot's workspace machine between boots instead of replacing it: programs installed outside `/workspace` now survive idle stops and server restarts, until the workspace image changes. A machine left running by a server that died is taken over with its installs.
- Confirm group messages after storing the message and pending turns, without waiting for bot startup. Pending turns survive restarts; the API response is unchanged.

- Add group chats: the owner can create, rename, change, and delete group chats of two to six bots, and post messages into a shared transcript that keeps each message's sender. Each group's transcript is its own Pi store.
- Let bots answer in group chats. An owner message wakes the bots it mentions, or every member without a mention; a bot message wakes only the bots it mentions, and a reply wakes the bot it answers. Each bot runs one turn per group at a time, in its own working conversation for the group; mentions that arrive meanwhile start one follow-up turn. A bot answers, reacts with an emoji, or calls the new `pass` tool to stay silent, and cannot delegate or start coding jobs from a group. After eight bot-started turns since the owner's last message the group pauses until the owner writes again, and the owner can stop every turn at once. Answers are posted exactly once across restarts. Group turns send no bot chat notifications.
- A bot added to a group after its first message, or added again after leaving, gets a short summary of the earlier conversation on its first turn. Its own model writes the summary once, outside the group's queue, so a slow summary never holds up the other bots or Stop; the bot waits as queued meanwhile.
- Notify the owner of the first bot answer to each of their group messages, from a bot that message woke, and of every bot message that mentions `@owner`, through the activity stream and push notifications. Group notifications are titled with the bot and the group, carry the group's ID, and are not suppressed while that bot's chat is open.
- Let the owner attach images and text files to group messages. Each member turn receives the attachments of the messages it has not seen, newest first up to eight; a model that cannot read images gets their names instead.
- Record where every new memory was saved: the owner's bot chat, the owner directly, a scheduled task, another bot's request, or a group chat. A group turn can change only the bot's own memory, not shared memory.
- Contract bundles may add event schemas in a minor release; removing one requires a new major version.
- Add the `group_chats` tool to bot chats: a bot can list its group chats and read their recent messages when the owner asks about them. Group turns don't get it.
- Move the product brief and parity research to the spec repository, remove the outdated Claude handoff, and replace the local glossary with a link to the canonical glossary there.
- Describe execution fields on schedule admission results so generated clients preserve the bot and conversation needed after starting a task.

- Export and validate versioned HTTP and event contracts, check release compatibility, and publish immutable contract bundles from CI.

- Correct nullable resource response schemas and mark attachment index path parameters as required for generated clients.

- Add `GET /v1/capabilities`, `GET /v1/agents/{id}/coding-jobs`, and `GET /v1/agents/{id}/coding-jobs/{name}/history`, so clients can tell whether coding is available, list a bot's jobs with their status, and page through a job's messages and tool calls.
- Add coding jobs. A bot with the `coding` tool can start, message, stop, and check named jobs that read, write, edit, and run commands in its workspace. Starting a job or messaging it ends the bot's turn, because clients show the job as a card; the chat preview reads "Coding job <name>". Each job's answer returns to the bot's chat once, including after a restart. Jobs have no memory, delegation, scheduling, integrations, or jobs of their own, and the bot's chat never gets a shell.
- Add Microsandbox workspaces: one microVM per bot with its files on a persistent, journaled disk volume that survives image changes. Jobs can make HTTP(S) requests to the internet through a replaceable network policy, which allows everything by default and now sees each connection's host and port. Other protocols and private address ranges are blocked. The VM starts on first use and stops when idle. Set `CRUMBLE_WORKSPACE_IMAGE` to an image built from `workspace-image/Dockerfile` to enable them; without it, no bot is offered the `coding` tool. On Linux in Docker, add `compose.kvm.yaml`.
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

## Contract 1.7.0

- Add `POST /v1/providers/{provider}/login`, `GET` and `DELETE /v1/provider-logins/{id}`, and `POST /v1/provider-logins/{id}/responses` with the `ProviderLoginSession`, `ProviderLoginPrompt`, and `ProviderLoginEvent` schemas. Unknown or expired sessions, including those lost on restart, return 410.
- Add `authMethods`, `credentialType`, and `activeLoginId` to `Provider`.
- `DELETE /v1/providers/{provider}` now removes an account sign-in as well as an API key. Clients that only set API keys keep working unchanged.

## Contract 1.6.0

- Add optional `jobName` to `ReplyEvent`, set when the bot answered a coding or desktop job's report.
- Document the `ReplyEvent.origin` values, now including `coding` and `desktop`.

## Contract 1.5.0

- Add `GET` and `PUT /v1/agents/{id}/desktop/control` with the `DesktopControl` schema (`holder`: `bot` or `owner`, `changes`, `updatedAt`) and the `DesktopControlInput` body.
- Add `GET /v1/agents/{id}/desktop/events`, a server-sent event stream of `control` events carrying `DesktopControl`, and heartbeats.
- Add `POST /v1/agents/{id}/desktop/viewer`, returning `DesktopViewer` (`path`, `expiresAt`): a single-use, server-relative link to the viewer page.
- Export `desktop-control.schema.json`, the JSON Schema of each `control` event.

## Contract 1.4.0

- Add `GET /v1/agents/{id}/desktop-jobs` and `GET /v1/agents/{id}/desktop-jobs/{name}/history`, shaped like the coding job routes.
- Add `desktop` to `Capabilities`.
- Add optional `desktopModel` to `Agent`; requests may send `null` to clear it.
- Add optional `usage` to `CodingJob` and `DesktopJob`: the Pi Durable usage document of the job's own conversation.

## Contract 1.3.0

- Accept `attachments` on group messages, which may then have empty content, and add `GET /v1/group-chats/{id}/attachments/{entryId}/{index}`. Group messages list their attachments in `attachments`.
- Add optional `groupId` and `groupName` to `ReplyEvent` for bot answers in group chats.
- Add `source` to `Memory`: a `MemorySource` naming the chat, owner, scheduled task, bot, or group chat a memory was saved from, or `null` for memories saved before sources were recorded.
- Export `group-chat-snapshot.schema.json`, the JSON Schema of each `snapshot` event on the group chat stream, so clients can generate and validate group snapshots as they do bot chat snapshots.

## Contract 1.2.0

- Accept an optional `replyTo` on group messages, and add `POST /v1/group-chats/{id}/stop`.
- Add `GroupActivity` to `GroupChatSnapshot`: whether the group is paused, the bot-started turn count, and each member's status and latest turn error. Group messages carry `replyTo` and `replyPreview`, and a bot's reaction is a `toolResult` message with `toolName` `react` and the emoji in `toolDetails`.

## Contract 1.1.0

- Add group chat endpoints under `/v1/group-chats`: list, create, read, update, and delete groups; read a `GroupChatSnapshot` and paged history; post owner messages, which return a `GroupMessageReceipt`; and stream `GroupChatSnapshot` events.

## Contract 1.0.0

- Publish the initial independently versioned HTTP API and snapshot, activity, and heartbeat event schemas.
- Include checksums, this contract changelog excerpt, and the source commit in every contract bundle.
- Encode nullable resource responses as unions and require every path parameter.
