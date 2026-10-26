---
title: Schedules, messaging, and integrations
description: Run tasks on a schedule, let bots talk to each other, and connect external tools over MCP.
sidebar:
  order: 7
---

## Scheduled tasks

Every bot can schedule tasks. A task is a prompt that runs once at a set time or repeatedly on a cron schedule, and the result appears in the bot's chat.

Ask the bot directly, for example "Every Monday at 9, summarize my open pull requests." See and pause upcoming tasks on the **Tasks** page.

### Script tasks

A script task runs a shell command in its bot's [workspace](/concepts/workspaces) at the scheduled time instead of sending a prompt to the bot's chat. The bot needs coding jobs enabled, and it can create script tasks only for itself. The command runs in `/workspace` with that bot's [credentials](/concepts/credentials).

To convert an existing script task, edit it on the **Tasks** page, select **Prompt**, and enter a prompt. This remains available when coding jobs are disabled or the server has no workspaces.

The timeout defaults to 600 seconds and can be set from 1 to 3600 seconds. When it expires, the command's process tree is killed. Processes the command starts with `setsid` survive the timeout.

A run keeps the last 64 KiB and 2000 lines of combined output. With **Send results to the chat** on (the default), each finished run posts its result to the bot's chat. Runs are retained for 90 days; failures are not retried. If a server restart interrupts a run, it is recorded as interrupted and is not resumed.

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
