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

| Section         | What's there                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Bots**        | Each bot's chat, with its jobs and desktop.                                                                                               |
| **Group chats** | Chats with several bots.                                                                                                                  |
| **Memory**      | Every bot's memories and your shared memories. Edit or delete them here.                                                                  |
| **Automations** | Every automation with its schedule, next run, and status, plus a **Runs** tab with recent runs.                                           |
| **Activity**    | Everything bots did, by day. Filter by kind or bot, and revert a change to a skill or memory.                                             |
| **Theme**       | System, Light, or Dark. The choice is saved to your account, so your other devices use it too.                                            |
| **Settings**    | Providers, web search, credentials, logins, the judge and vision models, MCP integrations, skills, notifications, passkeys, and sign-out. |

Press `⌘K`, or `Ctrl+K`, or select **Search** in the sidebar to open the
command palette. It jumps to a bot, group chat, workspace page, or settings
section, creates a bot or group chat, and switches the theme. To search inside
conversations, ask a bot. It
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
until you open their chats. It also names the bot or group chat you have open.

### Push notifications on other devices

Server push notifications are separate from browser notifications and the tab
counter. A visible, focused web tab displaying a bot or group chat suppresses
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
