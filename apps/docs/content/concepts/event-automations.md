---
title: Event Automations
description: Run an automation each time a webhook arrives, through a Doorstep event relay.
sidebar:
  order: 12
---

An event automation runs each time a webhook arrives at an event source,
instead of at a set time. Use one to triage new GitHub issues, react to a
payment, or handle a form submission.

Webhooks reach Crumble through an event relay: a
[Doorstep](https://github.com/crumble-project/doorstep) server that receives
webhooks for your account and holds them. Crumble opens its own connection to
the relay, so your server needs no public address. Events that arrive while
your server is offline wait on the relay for up to seven days.

## Set up the event relay

1. Run a Doorstep relay, or use one someone runs for you. Doorstep's README
   covers the single binary and Cloudflare Workers.
2. Create a Doorstep account with the relay's admin token, and keep the
   account token it returns.
3. In Crumble, open **Settings** > **Event relay**.
4. Next to **Doorstep account token**, select **Add**. Paste the token, or
   select a connected [password manager](/concepts/password-managers) and
   paste a reference to it.
5. In **Relay URL**, enter the relay's address, such as
   `https://relay.example.com`, and select **Save**.

The **Relay URL** row shows **Connected** once the relay accepts the token. If
the connection drops, Crumble reconnects automatically with a growing delay.

## Add an event source

An event source is one webhook address on the relay. Every bot of the account
can use it.

1. In **Settings** > **Event relay**, select **Add source**.
2. Enter a name, such as `GitHub issues`, and select **Add**.
3. Copy the webhook address and paste it into the provider's webhook settings.

Crumble shows the address only once. Anyone who has it can send events to the
source, so keep it private. To revoke an address, delete the source; you can
delete a source only while no automation uses it.

## Create an event automation

On the **Automations** page, select **New automation**. Under **When**, choose
**When an event arrives** and pick a source. You can also ask a bot, such as
"When an issue arrives from GitHub issues, label and summarize it."

Every event from the source starts every enabled automation that uses it.
Choose which events the provider sends in its own webhook settings, and use a
separate source for each purpose. One automation handles its events one at a
time, oldest first.

## What the bot receives

A prompt automation sends its prompt to the bot's chat, followed by the event:
the method, query string, headers, and body. The chat shows only the prompt,
labeled with the automation and the source.

The event is marked as untrusted data from outside Crumble. Text in a webhook
can come from anyone, such as the author of a GitHub issue, so the bot must not
follow instructions in it. [Intent checks](/concepts/workspaces#what-counts-as-your-request) count only the
automation's prompt as your request, never the event.

Bodies longer than 32 KiB are cut, and bodies that aren't UTF-8 text are left
out. In both cases the bot reads the rest with its `event_payload` tool, a page
at a time.

A script automation gets the event in a file instead. These environment
variables are set for its command:

| Variable               | Value                                                           |
| ---------------------- | --------------------------------------------------------------- |
| `CRUMBLE_EVENT_ID`     | The event's ID.                                                 |
| `CRUMBLE_EVENT_SOURCE` | The event source's name.                                        |
| `CRUMBLE_EVENT_FILE`   | A JSON file with the event. Its `body` field is base64-encoded. |

## Limits

| Limit      | Value                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------- |
| Body size  | 1 MiB, enforced by the relay.                                                            |
| Delivery   | At least once. Crumble ignores a repeated event, so each automation runs once per event. |
| Retries    | A failed hand-off to the bot's chat is retried every 30 seconds, up to 10 attempts.      |
| Retention  | Crumble keeps events for 30 days.                                                        |
| Signatures | Crumble doesn't check provider signatures. The secret address is the only check.         |
