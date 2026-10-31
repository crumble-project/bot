---
title: Bots
description: What a bot is, and the capabilities you can turn on for each one.
sidebar:
  order: 1
---

A bot is an assistant you configure once and keep. It has a name, a model,
standing instructions, and one [continuous chat](/concepts/chats) with you.
Unlike a chat thread you throw away, a bot builds up memory and skills over
time.

Bots don't share much by default. Each one has its own chat, its own
[workspace](/concepts/workspaces), and its own private memory and skills. What
they can share, you turn on.

## Capabilities

Capabilities decide what a bot is allowed to do. Every bot can run
[automations](/concepts/schedules-and-integrations#automations) and run code in
code mode. Turn on the rest per bot in its settings:

| Capability       | What the bot can do                                                    | Details                                                                           |
| ---------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Memory**       | Save facts to its private memory and to memory shared with your bots.  | [Memory and Skills](/concepts/memory-and-skills)                                  |
| **Messaging**    | Ask your other bots questions, or hand work to them.                   | [Messaging Other Bots](/concepts/schedules-and-integrations#messaging-other-bots) |
| **Coding**       | Start coding jobs that edit files and run commands in its workspace.   | [Workspaces and Jobs](/concepts/workspaces)                                       |
| **Bot desktop**  | Use a graphical desktop with a browser in its workspace.               | [Workspaces and Jobs](/concepts/workspaces)                                       |
| **Integrations** | Use tools from MCP servers you connect.                                | [MCP Integrations](/concepts/schedules-and-integrations#mcp-integrations)         |
| **Web search**   | Search the web and read pages.                                         | [Web Search](/concepts/web-search)                                                |
| **Create bots**  | Propose new bots, which you edit, approve, or decline in the bot chat. | [Request Cards](/clients/web#request-cards)                                       |

Coding and bot desktop also need a server that supports workspaces. See
[Set Up Workspaces](/self-hosting/workspaces).

## Visuals and Reactions

Bots can show stats, tables, and charts inline in the chat. When a reply would
be overkill, they react to your message with an emoji instead.
