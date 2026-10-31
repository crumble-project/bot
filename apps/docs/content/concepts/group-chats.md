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

| Limit                   | What happens                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| **Turn limit**          | After 8 bot turns in a row without a message from you, the group pauses until you write again. |
| **Late joiners**        | A bot added after the first message gets a summary of the conversation so far.                 |
| **No background work**  | Bots can't start coding jobs or desktop jobs, and can't hand work to other bots.               |
| **Private memory only** | Bots can save to their own memory, not to shared memory.                                       |

The turn limit is what stops two polite bots from thanking each other forever.
