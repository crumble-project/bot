---
title: Schedules, messaging, and integrations
description: Run tasks on a schedule, let bots talk to each other, and connect external tools over MCP.
sidebar:
  order: 7
---

## Scheduled tasks

Every bot can schedule tasks. A task is a prompt that runs once at a set time or repeatedly on a cron schedule, and the result appears in the bot's chat.

Ask the bot directly, for example "Every Monday at 9, summarize my open pull requests." See and pause upcoming tasks on the **Tasks** page.

## Messaging other bots

With the **Messaging** capability, a bot can ask another of your bots a question or hand it a piece of work. Delegation goes one level deep: a bot that received delegated work can't delegate it again.

## MCP integrations

MCP servers give bots extra tools, like access to your calendar or issue tracker. Add servers in **Settings** > **Integrations**, then turn them on per bot under **Integrations**.

Crumble connects to MCP servers over HTTP or HTTPS and supports these sign-in methods:

- A bearer token.
- OAuth with dynamic client registration.
- OAuth with a client ID metadata document. This needs [`CRUMBLE_PUBLIC_URL`](/self-hosting/configuration).
- OAuth with your own client ID and secret.

If a server is offline or its sign-in has expired, the bot answers without that server's tools.
