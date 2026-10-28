---
title: Memory and skills
description: How bots remember facts, learn reusable instructions, and how you undo what they learned.
sidebar:
  order: 4
---

## Memory

Memory holds facts that matter across conversations, like your preferences or a project's details. A bot needs the **Memory** capability to save them.

A memory is either the bot's own or **shared** with every one of your bots that has memory turned on. Every memory records where it came from: a bot chat, you, a scheduled task, another bot, or a group chat.

Review and edit memories on the **Memory** page.

## Skills

A skill is a set of instructions for one kind of task, like writing a weekly report or deploying a project. A bot sees only each skill's name and one-line description, and loads the full instructions when a task calls for them. This keeps the working context small even with many skills.

There are three kinds:

- **Default** skills come with the server. Bots can read them but not change them.
- **Shared** skills are available to all your bots.
- A bot's **own** skills belong to that bot.

A bot can write its own skills. When it changes a shared or default skill, it makes its own copy, which takes the original's place for that bot only.

Manage skills in **Settings** > **Skills**. Turn a shared skill on for a bot by selecting the bot under the skill.

## Learned changes

After a turn with a lot of tool use, a background review looks at what the bot did and may update its skills or memories. These are learned changes.

Every change to a skill or memory, whether made by you, a bot, or a review, is recorded with its before and after state. Open the **Activity** page to see the diff and revert any change.

## Cleanup

Every six hours, Crumble checks skills that bots created. A skill unused for 14 days is marked stale, and a stale skill is archived after 30 days. Pinned skills and skills that a scheduled task uses are never archived.
