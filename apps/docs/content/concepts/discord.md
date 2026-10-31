---
title: Discord
description: Connect Discord to your existing bot chats, restrict access, and choose which bot answers.
sidebar:
  order: 11
---

The Discord message gateway sends your Discord messages to your existing
bot chats and returns their answers to Discord.

Discord is the only supported messaging platform. Crumble connects outward to
Discord, so you don't need a public webhook endpoint.

## Set up Discord

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Open **Bot** and create or reset the bot token.
3. Under **Privileged Gateway Intents**, turn on **Message Content Intent**.
4. Configure a server installation with the `bot` OAuth2 scope.
5. Grant **View Channels**, **Send Messages**, and **Read Message History** in the channels you plan to use.
6. Install the application in your Discord server.

For threads, also grant **Send Messages in Threads**. Channel permissions can
override server permissions. Crumble requests guild, guild-message,
direct-message, and message-content events; it doesn't need member or presence
intents.

Keep the bot token private. Use the bot token, not your Discord account token,
application ID, or public key. Discord can require approval for privileged
intents on verified applications. See
[Discord's Gateway intent documentation](https://docs.discord.com/developers/events/gateway#gateway-intents)
and [installation documentation](https://docs.discord.com/developers/quick-start/getting-started#adding-scopes-and-bot-permissions).

## Connect Crumble

1. Open **Settings** > **Message gateways**.
2. In **Credentials**, save the token under **Discord bot token**.
3. Select a **Default bot**.
4. Enter your numeric Discord user ID in **Owner Discord user ID**.
5. Enter each permitted channel ID in **Allowed channel IDs**.
6. Turn on **Allow direct messages** if you want direct messages.
7. Add any **Aliases** with a **Handle** and **Bot**.
8. Turn on **Enabled** and select **Save changes**.

Check **Connection status** after saving. The row shows pending deliveries and
retained failed receipts. **Reset** discards unsaved gateway
configuration edits. To stop receiving new messages, clear **Enabled** and
select **Save changes**.

## Owner access

The gateway starts disabled. Enter your own Discord user ID and permitted
channel IDs before using server channels. Use numeric Discord IDs, not display
names or channel names. Discord's **Developer Mode** exposes **Copy User ID**
and **Copy Channel ID** in context menus.

Only the configured owner can send messages to bots. These messages have the
same owner authority as messages in the bot chat, including desktop intent
checks. Don't enter another person's ID. Other Discord users can't submit work,
even in an allowed channel or through direct messages.

Server messages must come from an explicitly allowed channel. Direct messages
also require **Allow direct messages**. An empty owner ID blocks every sender;
an empty channel list blocks every server channel.

Configurations using the previous sender allowlist are disabled on upgrade.
Enter your owner ID and save the configuration before enabling the gateway.
Crumble never chooses an owner from that list.

Use a dedicated channel when other people share your Discord server.
**Every owner message in an allowed channel can reach a Crumble bot,
without mentioning the Discord application.** Bot and webhook messages are
ignored to prevent message loops.

## Choose a bot

Set a default bot for messages without an explicit recipient. Add stable
aliases for bots you want to address, such as `researcher` or `writer`.
Enter handles without `@`, using letters, numbers, underscores, or hyphens.
Aliases and bot names ignore case and normalize equivalent Unicode forms.
Aliases must be unique.
You can leave the default unset if every message uses an alias or a reply.
Messages without a recipient then receive a routing error.

| Discord message                            | Recipient                                              |
| ------------------------------------------ | ------------------------------------------------------ |
| `Summarize today's notes`                  | The configured default bot.                            |
| `@researcher Summarize today's notes`      | The bot mapped to `researcher`, for this message only. |
| A reply to a gateway answer                | The bot that produced that answer.                     |
| `@writer Rewrite this` as a reply          | The bot mapped to `writer`, overriding reply routing.  |
| A new message after `@writer Rewrite this` | The configured default bot again.                      |

Type the leading `@handle` as ordinary text. A native Discord mention of the
application isn't a bot alias. Crumble removes a leading mention of its own
Discord application for routing, while preserving it in the transcript.
A bot name can also select a bot when it identifies only one bot. Names can contain spaces; the longest matching
name wins. A matching alias takes precedence. Prefer aliases for stable
routing when you rename bots.
Unknown, ambiguous, deleted, or disabled recipients produce a routing error;
they don't silently select the default bot.

## Transcript and delivery

Your original message, including a routing prefix, enters the selected bot's
[continuous chat](/concepts/chats). The answer appears in that transcript and
returns to the originating Discord channel or direct message, labeled with
the answering bot's name.

Only the answer associated with that Discord request returns to Discord.
Messages sent in the web app, automations, and unrelated background activity
aren't mirrored. A reply in a shared Discord channel is visible to everyone
who can read that channel.

The first version accepts text only. Messages with attachments receive an
unsupported-attachment response instead of submitting their text alone.
Voice, images, and file processing aren't supported. Incoming text is limited
to 32,000 characters. Long answers are split into multiple Discord messages.
Outgoing text doesn't trigger Discord mentions.

Retryable submission and delivery failures retry while the gateway is enabled
and the owner and destination remain authorized. Retries back off from 5 seconds
to 15 minutes and respect longer platform retry delays. Retries stop after
10 failures or 24 hours from receipt. Permanent delivery errors and failed bot
executions require a new message.

Disabling the gateway or changing its owner or destination access pauses
pending deliveries. Restoring access resumes deliveries within the 24-hour
window. Failed connection attempts and invalidated sessions back off from
60 seconds to 15 minutes. The backoff resets after five minutes continuously connected.
Connection diagnostics alone don't restart a live Discord client; Discord
handles transient reconnects.

Crumble persists incoming message receipts and outgoing delivery progress.
Replayed events reuse their recorded request, and retries keep the original
recipient and destination. Reply routing expires 30 days after a receipt
finishes. Replying to an older answer then uses the default bot unless you
supply a leading alias. Duplicate receipts are removed after 30 days during
hourly cleanup. A replay after cleanup can submit again.

When a receipt finishes, Crumble clears its stored gateway input and answer.
The original message and answer remain in the bot transcript. An hourly cleanup
removes expired receipt and reply records.

This isn't an exactly-once delivery guarantee: a connection failure can leave
uncertainty about whether Discord accepted a message before Crumble recorded
it. Discord also doesn't guarantee delivery of every event while a connection
is unavailable.

If answers stop arriving, check the connection status and error in settings,
then check the token, Message Content Intent, owner ID, channel IDs, and
channel permissions. After replacing or resetting the token, save the new
token in Crumble.
