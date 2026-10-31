---
title: Web App
description: Find your way around the web app the server serves at /ui.
sidebar:
  label: Overview
  order: 1
---

The server serves the web app at `/ui`, such as `http://127.0.0.1:7337/ui`.
Sign in with the account you created when you
[installed the server](/getting-started/server).

## Sidebar

| Section         | What's there                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Bots**        | Each bot's chat, with its jobs and desktop.                                                                                   |
| **Group chats** | Chats with several bots.                                                                                                      |
| **Memory**      | Every bot's memories and your shared memories. Edit or delete them here.                                                      |
| **Automations** | Every automation with its schedule, next run, and status, plus a **Runs** tab with recent runs.                               |
| **Activity**    | Everything bots did, by day. Filter by kind or bot, and revert a change to a skill or memory.                                 |
| **Settings**    | Providers, web search, credentials, logins, the judge model, MCP integrations, skills, notifications, passkeys, and sign-out. |

Press `⌘K`, or `Ctrl+K`, to jump to a bot or group chat. To search inside
conversations, ask a bot. It
[searches its transcripts](/concepts/chats#searching-the-transcript) for you.

## Request Cards

When a bot needs a decision from you, it puts a card in the bot chat.

A bot with **Create bots** asks for a new bot with a bot request card. Review
the proposed identity, model, capabilities, and integrations. Select **Edit**
to change the proposal, then **Approve** or **Decline**. An approved bot is
independent of the one that proposed it, and opens its own chat.

A credential request card shows the hosts the credential is for. Enter the
value in the password field and select **Save**, or select **Decline**. The
value goes straight to the credentials service and never appears in the
transcript.

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
`http://localhost:7337/ui` rather than `127.0.0.1`. A passkey belongs to the
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

## Installing as an App

In Safari, use **Add to Dock** to open Crumble in its own window.
