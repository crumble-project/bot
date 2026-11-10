---
title: Voice Gateway
description: Call your bots from a phone, give each bot a line, and issue the token the voice gateway connects with.
sidebar:
  order: 13
---

The voice gateway carries phone calls between you and your bots. It's a
separate program, [crumble-voice](https://github.com/crumble-project/voice),
that runs on your network next to your telephone system, such as a home router
with IP phone accounts. Each bot that should take calls gets its own line.
When you call a line, what you say arrives in that bot's
[chat](/concepts/chats) and the bot's answer is read aloud to you.

Crumble keeps the voice gateway's lines and your numbers. Network settings,
SIP passwords, and speech settings stay in the voice gateway's own
configuration. See the crumble-voice README for installing and running it.

## Issue the voice gateway token

The voice gateway connects to Crumble with a voice gateway token, not with your
password.

1. Open **Settings** > **Voice gateway**.
2. Next to **Voice gateway token**, select **Issue token**.
3. Copy the token and give it to the voice gateway. It's shown only once.
4. Select **Done**.

Crumble stores only a hash of the token. If you lose it, select **Issue new
token**. The current token stops working at once, and the voice gateway
disconnects until it uses the new one. To cut the voice gateway off, select
**Revoke**.

The token reaches only your lines and the chats of the bots that have one. It
can't read other bots, change settings, or sign in to your account. Still,
anyone with the token can send messages to the bots that have a line, as you,
so keep it as private as a password.

## Add your numbers

Under **Your numbers**, select **Number** and enter each phone number you call
from, as your telephone system shows it. A number uses digits, `*`, and `#`,
with an optional leading `+`, up to 32 characters. You can add up to 20.

A call from one of these numbers reaches a bot as you, with the same
authority as a message you type in the bot chat. Calls from any other number
never reach a bot: the voice gateway handles them itself, for example by
playing a recording.

The order matters: use the arrows to put the number a bot should call first.
To turn the voice gateway on, add at least one number.

## Give a bot a line

A line is an account on your telephone system, such as an IP phone account on
your router, that one bot answers.

1. Create the account on your telephone system and note its username and
   password.
2. In **Settings** > **Voice gateway**, under **Lines**, select **Line**.
3. Enter the account's SIP username and choose the bot.
4. Optionally, enter a display name. Callers hear the bot's name when it's
   empty.
5. Turn on **Voice gateway** under **Connection** and select **Save**.

Give the SIP password to the voice gateway, not to Crumble. A username uses
letters, numbers, and `.`, `_`, `~`, `+`, or `-`, up to 64 characters, and
can't be `.` or `..`. Each username and each bot can have only one line, and
you can add up to 64 lines.

**Can call you** stays off for a new line. Turn it on to let that line's bot
call you; see [Calls from a bot](#calls-from-a-bot).

If you delete a line's bot, the line shows **Bot deleted**: choose another bot
or remove the line before saving. If you disable a line's bot, the line shows
**Bot disabled**. The voice gateway leaves it out until you enable the bot
again.

**Connection** shows whether the voice gateway is connected. While it's
connected and has reported its lines, each saved line shows **Registered**, or
why your telephone system didn't accept it, for example a missing password. **Reset**
discards unsaved edits.

## Spoken messages

What you say on a call becomes a spoken message in the bot's chat. The
transcript shows your words with **Spoken on a call** under them. The bot is
told that its answer is read aloud, so it answers briefly in plain sentences,
without lists, tables, code, or links.

## Calls from a bot

A bot whose line has **Can call you** turned on can call you with its
`call_owner` tool. The bot is offered the tool only while the voice gateway is
on, the bot is enabled, and a voice gateway that can place calls is
connected. The bot uses it when you ask it to call you, or for news too urgent
to wait for a chat message.

The bot writes only a greeting. Crumble chooses the number: always the first
one under **Your numbers**. The bot can't dial anything else.

1. The voice gateway dials you from the bot's line. Your phone rings for up to
   3 minutes.
2. When you answer, you hear the greeting and the bot's turn ends. What you
   say next arrives in the bot's chat as spoken messages, as on a call you
   placed.
3. If you don't answer, the line is busy, or the call fails, the bot learns
   why and carries on in its chat.

Crumble checks the line again when the bot places the call, so turning off
**Can call you**, removing the line, disabling the bot, or turning off the
voice gateway stops a call the bot was about to place. If you stop the bot's
turn while your phone rings, the voice gateway hangs up. One tool call rings
you at most once, even if the voice gateway reconnects or Crumble restarts.

## Calls in the chat

Each call shows in the line's bot chat, so the bot and you can see what
happened on the phone:

- **Call started** marks a call you placed.
- The bot's name followed by **called you** marks a call the bot placed, with
  the greeting it said quoted below.
- **Call ended** shows how long the call lasted and, unless it was hung up
  normally, why it ended: for example, the voice gateway lost its connection.

When a call ends, the bot gets one turn to finish what the call left open,
for example to call you back as it promised. If nothing is open, it reacts to
the call's end with 👍 and writes nothing, and you get no notification. The
bot gets this turn after a call it placed, and after a call you placed once
you said something. It gets none when the bot is disabled or the voice
gateway token was revoked.

Crumble also ends a call itself when the voice gateway can't report it: after
60 seconds without a connected voice gateway, 15 seconds after the voice
gateway reconnects without confirming the call, when the line gets another
bot or is turned off, when the token is issued again or revoked, or 4 hours 5
minutes after the call started.

While a line has a call, or a call the bot placed is ringing, the bot isn't
offered `call_owner`, and a call it tries anyway is refused.

During a call, the bot can hang up with the `hang_up` tool, for example when
you say goodbye or ask it to. The voice gateway reads the bot's reply aloud,
waits for about 3 seconds of silence, and ends the call. The chat then shows
"Call ended" with "the bot hung up".

## Limits

- One voice gateway per account. A second voice gateway with the same token
  replaces the first.
- Nothing limits how often a bot calls you. If a bot calls too often, turn off
  **Can call you** for its line.
- Restarting Crumble ends the calls bots are placing. The voice gateway hangs
  up a phone that still rings. A call already answered survives the restart:
  Crumble ends it only if the voice gateway doesn't reconnect within a minute.
- Crumble can't check caller IDs. Anyone who can send traffic from your
  telephone system's address can claim to call from your number and reach
  your bots as you.
