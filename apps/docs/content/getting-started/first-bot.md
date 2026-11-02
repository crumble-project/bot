---
title: Create Your First Bot
description: Give a bot a name, a model, and instructions, then start chatting.
sidebar:
  order: 3
---

A bot is something you set up once and keep, so the few minutes you spend on
its instructions pay off for months.

1. In the web app, click **+** next to **Bots** in the sidebar.
2. Pick an avatar, choose its body and eye colors, and enter a name.
3. Choose a model and a reasoning level.
4. Write the bot's instructions: who it is, what it's responsible for, and how
   it should talk to you.
5. Turn on the [capabilities](/concepts#capabilities) you want. You can change
   them later.
6. Click **Save**.

The bot's chat opens. Say hello.

## Customize an avatar

In the bot's settings, click its avatar to open the editor. Choose a shape from
**Gallery**, or paste an Open Bot Avatar definition into **Import**. Invalid
geometry is rejected with validation errors. Click **Save** to keep your changes.

To design a shape, open **Generate** and enter a description. Click
**Copy generation prompt**, give the prompt to any bot or model, then paste its
JSON response into **Import**. The copied prompt includes your description.
Crumble doesn't call a model from the avatar editor. A bot can also suggest its
own definition in chat for you to import.

The `/avatars` page previews idle, working, and sleeping states. Select a bot
and click **Save avatar to bot** to apply your choice. Sleeping avatars use a
dimmed still image. Live avatars respect your system's reduced-motion setting.

Native apps keep their existing seeded avatars until native rendering is
available. Changing the web avatar doesn't change that seed.

## Things to Try

Ask the bot to remind you of something next week. Every bot can run
[automations](/concepts/schedules-and-integrations#automations), so it doesn't
need anything turned on for that.

Tell it something about yourself and ask it to remember. This one needs the
**Memory** capability. Without it, the fact stays in the
[transcript](/concepts/chats), but the bot can't save it to memory.

Add a second bot and start a [group chat](/concepts/group-chats) with both.
