# Changelog

## Unreleased

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
