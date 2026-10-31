---
title: Message gateway adapters
description: Add a compiled-in chat adapter without putting platform-specific routing in the gateway.
sidebar:
  order: 3
---

A chat adapter connects an external messaging platform to the account's
message gateway. Discord is the only adapter shipped today.

Adapters are compiled into the server through `CrumblePlugin.chatAdapters`.
Installing or loading third-party adapters without rebuilding is deferred.
There is no adapter marketplace or dynamic loading API.

## Contribution boundary

The source contract is
[`message-gateway/adapter.ts`](https://github.com/crumble-project/bot/blob/main/apps/server/src/message-gateway/adapter.ts).
The plugin contract is
[`plugins/plugins.ts`](https://github.com/crumble-project/bot/blob/main/apps/server/src/plugins/plugins.ts).
Both paths are relative to `apps/server/src`.

| Adapter member     | Responsibility                                                                    |
| ------------------ | --------------------------------------------------------------------------------- |
| `id`               | Stable, open string identifier. Keep it unique across contributions.              |
| `label`            | Display name for settings.                                                        |
| `secretKey`        | Fully qualified plugin secret key, such as `discord:token`.                       |
| `maxMessageLength` | Maximum text length accepted by one outbound message.                             |
| `connect(host)`    | Open the platform connection using `host.token` and return a `GatewayConnection`. |

Declare the secret with `CrumblePlugin.settings`; use a `secret` setting.
Contribute the adapter through `chatAdapters`, then register the plugin in
`apps/server/src/app/builtin-plugins.ts`.

The shared gateway owns account configuration, owner and destination
authorization, bot routing, durable receipts, bot submission, answer selection,
text splitting, and delivery progress. Pending receipts retain their original
owner and destination; authorization is checked again before processing.
Only the configured `ownerId` can submit messages, with the same owner authority
as bot chat input. Keep platform branches out of that shared logic. Adapter IDs
don't require a closed union of supported platforms.

## Receive messages

Call `host.onMessage` with a `GatewayMessage` for each supported platform event:

| Field             | Meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `id`              | Stable platform message ID, reused when an event is replayed.         |
| `channelId`       | Stable destination ID for both inbound messages and outbound answers. |
| `senderId`        | Stable user ID used for authorization.                                |
| `text`            | Original message text, preserved in the bot transcript.               |
| `routingText`     | Optional text used only to resolve a leading recipient.               |
| `isDirectMessage` | Whether the destination is a direct message.                          |
| `replyTo`         | Optional platform message ID to which this message replies.           |
| `hasAttachments`  | Whether unsupported attachments accompany the message.                |

Ignore the platform's bot and webhook messages before calling `onMessage`.
Report attachments even when the event also contains text. Don't silently
drop attachments or resolve a bot inside the adapter. If the platform adds a
native application mention, strip only that leading mention in `routingText`.
Preserve `text`, including every mention and routing prefix.

Routing uses a leading literal `@handle`, then a recorded gateway reply,
then the configured default bot. Explicit routing lasts for one message.
Unknown recipients don't fall back. Reply associations and selected
recipients must survive restarts. Reply routing expires 30 days after
completion; later replies use the default bot unless an explicit recipient
overrides it. Duplicate receipts are removed by hourly cleanup after 30 days.

The gateway submits input to the existing bot transcript. It reads the answer
by submission ID, rather than selecting the transcript's newest answer.
Unrelated app messages, automations, and background activity never become an
external response merely because they arrived later.

## Send answers

`GatewayConnection.send` receives `channelId`, optional `replyTo`, `text`,
and `nonce`. Return the platform's sent message ID. Preserve the supplied
nonce across attempts, and use platform deduplication when available.

Disable automatic user, role, and everyone mentions. Use a platform reply
reference when `replyTo` is present. Let failures reject instead of reporting
success before the platform accepts the message. Throw `GatewayTransportError`
with `permanent`, optional `status`, and optional `retryAfterMs`. Include
`rateLimit` metadata when a platform limit applies, so the gateway respects the
adapter or channel cooldown. Retryable failures use persisted exponential
backoff from 5 seconds to 15 minutes, honoring longer platform waits. Receipts
stop after 10 failures or 24 hours. Permanent errors stop immediately.

When a receipt finishes, its gateway input and answer are cleared. Compact
duplicate receipts and indexed reply associations remain for 30 days and are
pruned hourly. The bot transcript keeps its original message and answer.

A successful send can still be followed by a crash before its message ID is
persisted. Stable nonces and saved progress reduce duplicates; they don't
provide an unconditional exactly-once guarantee. Don't claim that the
adapter recovers events the platform never delivered.

## Connection lifecycle

Report `connecting`, `connected`, `disconnected`, or `error` through
`host.onStatus`. Include an actionable error without exposing the token.
Use the platform SDK for heartbeat, transient reconnects, and rate-limit behavior.
`onStatus("error", error)` reports a diagnostic without replacing a live client.
Call `host.onInvalidated(error)` only when the client cannot recover its session.
Failed connection attempts and invalidated sessions use exponential backoff
from 60 seconds to 15 minutes. Five minutes continuously connected resets the backoff.

`GatewayConnection.close` must release the client, listeners, and network
connection. Disabling an adapter, replacing its token, and stopping the
account runtime must close the previous connection.

## Verification

Use a fake platform client without real credentials or network requests.
Cover normalization, bot and webhook rejection, attachment detection, reply
references, disabled mentions, stable nonces, send errors, and cleanup.
Shared gateway tests cover authorization, routing, replayed events, concurrent
submissions, persisted reply associations, and partial delivery after restart.

For owner setup and platform permissions, see [Discord](/concepts/discord).
