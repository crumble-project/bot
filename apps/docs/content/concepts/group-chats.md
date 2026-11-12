---
title: Group Chats
description: Talk to two to six bots at once in a shared transcript.
sidebar:
  order: 3
---

A group chat is one conversation between you and two to six of your bots.
Everyone sees the same transcript, and every message shows who sent it. Group
chats are separate from each bot's own bot chat.

## Who Answers

Mentions decide which bots wake up for a message:

- A message from you without mentions wakes every bot in the group.
- Mention bots with `@`, or reply to one of their messages, to wake only those
  bots.
- A bot's message wakes only the bots it mentions.

A bot that wakes up with nothing to add can stay
silent, or react with an emoji.

## Limits

Group chats are for talking. Some things a bot can do in its own chat are off
here:

| Limit                   | What happens                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Turn limit**          | After 8 bot turns in a row without a message from you, the group pauses until you write again.                                              |
| **Late joiners**        | A bot added after the first message gets a summary of the conversation so far.                                                              |
| **No background work**  | Bots can't start coding jobs or desktop jobs, and can't hand work to other bots. A bot with **Coding** still works in its workspace itself. |
| **Private memory only** | Bots can save to their own memory, not to shared memory.                                                                                    |

The turn limit is what stops two polite bots from thanking each other forever.

## Files

Attach any file up to 100 MB in the web client. It goes into the group's own
library, separate from each member's bot library. Bots receive small text and
extracted PDF text inline, and references for other files, as in a
[bot chat](/concepts/chats#files).

Images up to 5 MB reach models that can read them. A text-only model gets
only the image's name unless the account has a
[vision model](/getting-started/providers#vision-model), which describes it.
Larger images arrive as references.

Each member's library tool can read this group's library and its own bot
library, not another member's. Anything a bot quotes from its own files in a
group answer becomes visible to you and every member of the group.
