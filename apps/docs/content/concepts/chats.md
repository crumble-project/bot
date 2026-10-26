---
title: Chats and history
description: How a bot chat lasts indefinitely, what the bot sees on each turn, and how it finds earlier messages.
sidebar:
  order: 2
---

Each bot has one bot chat with you. There is no "new chat" button: you keep talking in the same place, whether the last message was a minute or a month ago.

## What you see and what the bot sees

The **transcript** is everything in the chat: your messages, the bot's replies, tool activity, and background work. It's permanent. Nothing in it is deleted to save space.

The **working context** is the part the bot actually reads when it answers: recent messages, summaries of older ones, its instructions, and anything it recalled. It's much smaller than the transcript.

When the working context gets large, the bot **compacts** it: older messages are replaced by a summary in the working context. The transcript stays exactly as it was.

## Point the bot at an earlier message

Reply to a message to bring it back into focus. The bot reads that message and the messages around it before it answers.

## Ask the bot to find something

Bots can search and read their own transcripts, including messages that were compacted away. Ask in plain language, for example "What did I say about the domain renewal in March?"

A bot searches only what it's allowed to see:

- In its bot chat, it searches that chat and the group chats it belongs to.
- In a group chat, it searches only that group chat.
