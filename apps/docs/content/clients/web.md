---
title: Web App
description: Find your way around the web app the server serves at /ui.
sidebar:
  label: Overview
  order: 1
---

The server serves the web app at its root, such as `http://127.0.0.1:7337`.
Sign in with the account you created when you
[installed the server](/getting-started/server).

## Sidebar

| Part            | What's there                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Header**      | The **Activity** and **Settings** icons. On a phone, a **Search** icon too.                                                                                                                                                                         |
| **Pinned bots** | Up to nine bots as round portraits, three per row, above the list so they stay in view while you scroll. Right-click a portrait, or press and hold it, then select **Unpin**. Drag one onto another to reorder. Your other apps show the same pins. |
| **Automations** | Every automation with its schedule, next run, and status, plus a **Runs** tab with recent runs.                                                                                                                                                     |
| **Bots**        | Each unpinned bot's chat, with its jobs and desktop. Select **+** to create a bot, or **More** > **Pin** on a bot to pin it.                                                                                                                        |

**Activity** lists everything bots did, by day. Filter by kind or bot, and
revert a change to a skill or memory.

Each bot's avatar shows what it's doing, and a dot marks a bot with replies you
haven't seen. The sidebar updates as bots work, whether or not their chats are
open. Point at a bot, or use a screen reader, to read why its avatar looks
the way it does, such as "has a question", "needs your decision", or "last reply
failed".

When the web app loses its connection to the server, the sidebar shows
**Reconnecting…** or **Disconnected** below the header.

Memory, theme, and sign-out live in **Settings**:

- **Settings** > **General** > **Appearance** sets the theme to System, Light,
  or Dark, and **Avatars** to Flat or Fluffy. Fluffy gives larger, animated
  avatars fur in browsers with WebGL2. Small avatars, and the Apple and Android
  apps, stay flat. Both choices are saved to your account.
- **Settings** > **Memory** shows every bot's memories and your shared
  memories. Edit or delete them there. The old `/memory` address redirects to
  it.

On a computer, press `⌘K` or `Ctrl+K` to open the command palette. On a phone,
select **Search** in the sidebar header. The palette jumps to a bot, workspace
page, or settings section, creates a bot, and switches the theme. To search
inside conversations, ask a bot. It
[searches its transcripts](/concepts/chats#searching-the-transcript) for you.

## Request Cards

When a bot needs a decision from you, it puts a card in the bot chat.

A bot with **Create bots** asks for a new bot with a bot request card. Review
the proposed identity, model, capabilities, and integrations. Select **Edit**
to change the proposal, then **Approve** or **Decline**. An approved bot is
independent of the one that proposed it, and opens its own chat.

A credential request card shows the hosts the credential is for. Select
**Add credential** to enter the value or a password manager reference, or select
**Decline**. The value goes straight to the credentials service and never
appears in the transcript.

A call request card shows whom a bot wants to phone, the goal, and the
opening it will say. Select **Approve** to dial or **Decline** to refuse; see
[The bot calls someone else](/concepts/voice-gateway#the-bot-calls-someone-else).

After you decide, a card collapses to show the outcome. Bot request decisions
also appear as centered notices in the chat.

## Passkeys

A passkey signs you in with your device's screen lock or a security key
instead of your password. Your password keeps working either way.

To add one, sign in with your password, then select **Add passkey** in
**Settings** > **General**. Next time, select **Sign in with a passkey**, or
pick the passkey your browser offers in the email field. Open a passkey's
**More** menu to rename or remove it.

If your browser doesn't offer to create a passkey, check the address. Passkeys
need a hostname, so on the server's own machine open
`http://localhost:7337` rather than `127.0.0.1`. A passkey belongs to the
address you added it on and stops working if the server's address changes,
though you can rename or remove it from any address. See
[Configuration](/self-hosting/configuration#passkeys).

## Notifications

Turn on browser notifications in **Settings** > **General**. The browser asks
for permission the first time.

You're notified of bot replies from chats you don't have open, and of desktop
job actions waiting for your approval. Each kind has its own sound:

| Event                                  | Sound             |
| -------------------------------------- | ----------------- |
| A bot replies                          | A reply sound     |
| An action waits for your approval      | A bell            |
| A bot asks for a credential or a login | A mechanical bell |

Turn the sounds off with **Sound** in the same section.

The tab title counts replies you haven't seen yet, such as `(3) Atlas | Crumble`,
until you open their chats. It also names the bot chat you have open.

### Push notifications on other devices

Server push notifications are separate from browser notifications and the tab
counter. A visible, focused web tab displaying a bot chat suppresses
pushes for that chat on every device of your account.

The web app also acknowledges each reply after its text or matching request
card appears in the viewport. Loading cards and offscreen content do not
count. Acknowledgements survive server restarts; opening a chat alone does not
mark every reply seen.

New pushes wait at least three seconds in the server's queue. This gives
clients time to report attention before delivery. A push already accepted by
Apple or Firebase cannot be recalled.

Apple and Android clients can still receive pushes, but their foreground
chats do not suppress pushes elsewhere until those clients adopt attention
reporting.

## Installing as an App

In Safari, use **Add to Dock** to open Crumble in its own window.
