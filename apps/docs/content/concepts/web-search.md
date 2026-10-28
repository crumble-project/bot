---
title: Web search
description: Let a bot search the web and read pages with Mixed.
sidebar:
  order: 8
---

A bot with the **Web search** capability can search the web and read pages in bot chats and group chats. New bots created in the web app have this capability on by default. Existing bots keep their current settings.

Mixed, the default web search provider, works without setup or an API key. Its free services are rate-limited, and every account on a server shares their limits.

In **Settings** > **Providers**, you can add an Exa API key and choose the account's default web search provider. Keys are shared by bots on the account. In a bot's settings, choose **Account default**, **Mixed**, or **Exa**. Exa requires a saved key.

## Privacy

Mixed sends search queries to Exa, Parallel, or Tavily. It sends page URLs to Jina Reader when a bot reads pages. These services may use the information they receive to improve their services. When you choose Exa, searches and page URLs go to Exa. Avoid asking a bot to search for sensitive information.

Parallel issues a session ID that the server keeps in memory and uses to associate a bot's searches with one another.

## Turn web search off

Turn off **Web search** in a bot's settings to stop it from searching the web and reading pages through Mixed.
