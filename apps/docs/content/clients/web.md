---
title: Web app
description: Find your way around the web app the server serves at /ui.
sidebar:
  label: Overview
  order: 1
---

The server serves the web app at `/ui`, for example `http://127.0.0.1:7337/ui`. Sign in with the account you created when you [installed the server](/getting-started/server).

## Sidebar

| Section         | What's there                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Bots**        | Each bot's chat, with its jobs and desktop.                                                                                   |
| **Group chats** | Chats with several bots.                                                                                                      |
| **Memory**      | Every bot's memories and your shared memories. Edit or delete them here.                                                      |
| **Automations** | Every automation with its schedule, next run, and status, plus a **Runs** tab with recent runs.                               |
| **Activity**    | Everything bots did, by day. Filter by kind or bot, and revert a change to a skill or memory.                                 |
| **Settings**    | Providers, web search, credentials, logins, the judge model, MCP integrations, skills, notifications, passkeys, and sign-out. |

Press `⌘K` (or `Ctrl+K`) to jump to a bot or group chat. To search inside conversations, ask a bot.

## Request cards

The bot chat shows a bot request card when a bot with **Create bots** asks for a new bot. Review the proposed identity, model, capabilities, and integrations. Select **Edit** to change the proposal, then select **Approve** or **Decline**. An approved bot is independent and opens its own chat.

Credential requests use a card too. Review the host list, enter the value in the password field, and select **Save**, or select **Decline**. The value is sent to the credentials service and never appears in the transcript. Cards collapse to show their outcome after you decide. Bot request decisions also appear as centered notices in the chat.

## Passkeys

Sign in with your device's screen lock or a security key instead of your password. To add a passkey, sign in with your password, then select **Add passkey** in **Settings** > **General**. Next time, select **Sign in with a passkey**, or pick the passkey your browser offers in the email field. Open a passkey's **More** menu to **Rename** it or **Remove** it. Your password keeps working.

Passkeys need an address with a hostname, so on the server's own machine open `http://localhost:7337/ui` rather than `127.0.0.1`. You can rename or remove passkeys from any address. A passkey belongs to the address you added it on, and stops working if the server's address changes. See [Configuration](/self-hosting/configuration#passkeys).

## Notifications

Turn on browser notifications in **Settings** > **General**; the browser asks for permission the first time. You're notified of bot replies from chats you don't have open, and of desktop job actions waiting for your approval. Each notification plays a sound: one for replies, a bell for approvals, and a mechanical bell when a bot asks for a credential or login; turn it off with **Sound** in the same section. The tab title counts replies you haven't seen yet, such as `(3) Atlas | Crumble`, until you open their chats. It also names the bot or group chat you have open.

## Install as an app

In Safari, use **Add to Dock** to open Crumble in its own window.
