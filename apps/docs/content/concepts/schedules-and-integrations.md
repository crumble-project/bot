---
title: Automations, Messaging, and Integrations
description: Run automations on a schedule, let bots talk to each other, and connect external tools over MCP.
sidebar:
  order: 9
---

This page covers the three ways a bot reaches past its own chat: on a
schedule, to your other bots, and to outside tools.

## Automations

An automation is work a bot does at a set time, once or on a cron schedule,
or each time a webhook arrives. Every bot can have automations, with no
capability to turn on. For webhooks, see
[Event automations](/concepts/event-automations).

The easiest way to make one is to ask, such as "Every Monday at 9, summarize
my open pull requests." You can also select **New automation** on the
**Automations** page.

The page lists every automation with its schedule, next run, and status.
Select an automation to edit it, or use its **More** menu to run, pause,
resume, or delete it. The **Runs** tab lists recent runs: select a prompt run
to open the bot's chat, or a script run to see its output.

A prompt automation sends its prompt to the bot's chat, and the bot answers
there. A script automation runs a shell command instead.

### Script Automations

A script automation runs a shell command in its bot's
[workspace](/concepts/workspaces) instead of sending a prompt. The bot needs
coding jobs enabled, and it can create script automations only for itself. The
command runs in `/workspace` with that bot's
[credentials](/concepts/credentials).

| Setting                      | Behavior                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| Timeout                      | 600 seconds by default, from 1 to 3600. The process tree is killed when it expires. |
| Output                       | The last 64 KiB and 2000 lines of combined output.                                  |
| **Send results to the chat** | On by default. Each finished run posts its result to the bot's chat.                |
| Retention                    | Runs are kept for 90 days.                                                          |

Failed runs aren't retried. If a server restart interrupts a run, it's
recorded as interrupted and isn't resumed. Processes the command starts with
`setsid` survive the timeout, so a script can leave something running on
purpose.

To turn a script automation back into a prompt, edit it on the
**Automations** page, select **Prompt**, and enter a prompt. This works even
when coding jobs are disabled or the server has no workspaces.

## Messaging Other Bots

With the **Messaging** capability, a bot can ask another of your bots a
question or hand it a piece of work.

Delegation goes one level deep. A bot that received delegated work can't pass
it on, which keeps a chain of bots from handing a task around until nobody
remembers who asked.

## Discord Messages

Connect Discord to your existing bot chats with a default bot, per-message
aliases, and explicit sender and channel restrictions. See
[Discord](/concepts/discord) for setup, routing, and delivery limits.

## MCP Integrations

MCP servers give bots extra tools, like access to your calendar or issue
tracker. Add servers in **Settings** > **Integrations**, then turn them on per
bot under **Integrations**.

Crumble connects to MCP servers over HTTP or HTTPS and supports these sign-in
methods:

| Sign-in method                           | Notes                                                      |
| ---------------------------------------- | ---------------------------------------------------------- |
| Bearer token                             | Can come from a password manager. See below.               |
| OAuth with dynamic client registration   |                                                            |
| OAuth with a client ID metadata document | Needs [`CRUMBLE_PUBLIC_URL`](/self-hosting/configuration). |
| OAuth with your own client ID and secret |                                                            |

If a server is offline or its sign-in has expired, the bot answers without
that server's tools.

### Tokens in a Password Manager

A bearer token can come from 1Password or Bitwarden Secrets Manager instead of
being stored in Crumble.
[Connect the password manager](/concepts/password-managers) first. Then, in
the server's editor, select the password manager above **Token** and paste the
reference.

Over the API, send `tokenReference` instead of `token` when you create or
update the server with `/v1/mcp-servers`:

```json
{
  "tokenReference": {
    "passwordManager": "1password",
    "reference": "op://Vault/Linear/token"
  }
}
```

Crumble reads the reference once to check it and changes nothing if it can't
be read. Send `"tokenReference": null` to remove it. If a token can't be read
later, the bot answers without that server's tools, and the server's `error`
says why.
