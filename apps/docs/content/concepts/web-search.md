---
title: Web Search
description: Let a bot search the web and read pages with Mixed.
sidebar:
  order: 10
---

A bot with the **Web search** capability can search the web and read pages, in
bot chats and in group chats. New bots created in the web app have it on by
default. Existing bots keep their current settings.

## Providers

| Provider            | Setup            | Notes                                                                                  |
| ------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| **Mixed** (default) | None, no API key | Its free services are rate-limited, and every account on the server shares the limits. |
| **Exa**             | An Exa API key   | The key is shared by the bots on your account.                                         |

In **Settings** > **Web search**, add an Exa API key and choose the account's
default provider. In a bot's settings, choose **Account default**, **Mixed**,
or **Exa**. Exa only works once a key is saved.

## Sources

The bot cites each fact it takes from a page with a link to that page. In the
web app, links to pages the bot searched or read in that turn appear as small
source chips with the site's name at the end of the message. Hover over a chip
to see the page title.

Links the bot gives you to open, and citations of pages it didn't search or
read in that turn, stay in the text as ordinary links.

## Privacy

Searching the web means telling someone what you searched for:

| Provider | Where queries go         | Where page URLs go |
| -------- | ------------------------ | ------------------ |
| Mixed    | Exa, Parallel, or Tavily | Jina Reader        |
| Exa      | Exa                      | Exa                |

These services may use what they receive to improve their services. **Avoid
asking a bot to search for anything sensitive.**

Parallel issues a session ID, which the server keeps in memory and uses to
associate a bot's searches with one another.

## Turning Web Search Off

Turn off **Web search** in a bot's settings, and the bot stops searching the
web and reading pages.
