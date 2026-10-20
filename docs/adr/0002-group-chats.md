# Group chats

Implements [feature 0001](https://github.com/crumble-project/spec/blob/main/features/0001-group-chats.md).

A group chat's shared transcript lives in its own Pi Durable store, `groups/<group id>.sqlite`, which holds only data entries and never calls a model. That reuses transcript paging, entry references, and request-ID deduplication, so every message is written once even when a post is retried or the server restarts. Group metadata and membership live in the product database next to bots.

Each member bot gets one conversation per group in its own Pi store, owned by a background task as coding jobs are. The ownership keeps it out of the bot chat transcript, which merges every ownerless conversation in the store, and out of the legacy-session fallback in `CrumbleService.chat`. That conversation is the bot's private working context for the group: a turn submits the group messages the bot has not seen yet. Turns run as executions, so admission, monitoring, and restart recovery stay in `CrumbleService`. When a turn finishes, the service posts the bot's answer to the group transcript with a request ID derived from the execution.

The turn queue, the one-turn-per-bot rule, the turn budget, and the paused state live in the product database and belong to a `GroupChats` module beside `BotMessaging`.

## Considered options

- **Group messages as rows in the product database.** Simpler to start, but it would rebuild paging, entry references, and exactly-once posting that Pi already provides.
- **Copying group messages into each member's bot chat.** Rejected in the feature specification: it mixes conversations and keeps diverging copies.

## Consequences

- Group snapshots are an HTTP response component, not a separately exported event schema. The contract release tooling requires every release to carry the same event schema files, so adding one would fail compatibility against `contract-v1.0.0`. Teaching it to accept added event schemas is a separate change.
