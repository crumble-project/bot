---
title: Automations, messaging, and integrations
description: Run automations on a schedule, let bots talk to each other, and connect external tools over MCP.
sidebar:
  order: 8
---

## Automations

Every bot can have automations. An automation is a prompt that runs once at a set time or repeatedly on a cron schedule, and the result appears in the bot's chat.

Ask the bot directly, for example "Every Monday at 9, summarize my open pull requests," or select **New automation** on the **Automations** page. The page lists every automation with its schedule, next run, and status. Select an automation to edit it, or use its **More** menu to run, pause, resume, or delete it. The **Runs** tab lists recent runs: select a prompt run to open the bot's chat, or a script run to see its output.

### Script automations

A script automation runs a shell command in its bot's [workspace](/concepts/workspaces) at the scheduled time instead of sending a prompt to the bot's chat. The bot needs coding jobs enabled, and it can create script automations only for itself. The command runs in `/workspace` with that bot's [credentials](/concepts/credentials).

To convert an existing script automation, edit it on the **Automations** page, select **Prompt**, and enter a prompt. This remains available when coding jobs are disabled or the server has no workspaces.

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

A bearer token can also be read from 1Password or Bitwarden Secrets Manager instead of being stored in Crumble. Connect the password manager first, as described in [Password managers](/concepts/password-managers). Then, in the server's editor, select the password manager above **Token** and paste the reference. Over the API, send `tokenReference` instead of `token` when you create or update the server with `/v1/mcp-servers`:

```json
{
  "tokenReference": {
    "passwordManager": "1password",
    "reference": "op://Vault/Linear/token"
  }
}
```

Crumble reads the reference once to check it and changes nothing if it can't be read. Send `"tokenReference": null` to remove it. When a token can't be read later, the bot answers without that server's tools, and the server's `error` says why.
