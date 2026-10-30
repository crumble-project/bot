---
title: Workspaces and jobs
description: How bots write code and use a desktop in their own Linux workspace, and how you take control.
sidebar:
  order: 5
---

Each bot has a **workspace**: a Linux machine with a persistent `/workspace` disk that only that bot's jobs can reach. The machine starts when a job needs it and stops when it's idle. Files on the disk stay.

The server must support workspaces before bots can use them. See [Set up workspaces](/self-hosting/workspaces).

## Jobs

A bot doesn't do long work in the chat itself. It hands the work to a job that runs in the background, and the job's answer comes back to the chat. There are two kinds:

- A **coding job** edits files and runs shell commands. It needs the **Coding** capability.
- A **desktop job** uses a graphical desktop with a Chromium browser, with mouse and keyboard. It needs the **Bot desktop** capability. On web pages it reads the page and acts on its elements directly, which is faster than going through the screen; other apps and the browser's own menus it operates through their accessibility tree.

Ask in plain language, for example "Clone my site's repository and fix the broken link on the about page." The bot decides which kind of job to start.

Both kinds share the same machine. A coding job can start a web server, run browser tests against it, and then hand the address to a desktop job that checks the page by hand.

## Watch the bot desktop

Open a bot's desktop from the web app to watch its screen live. You can't type or click while the bot is in control.

## Take control

Sometimes a bot needs you, for example to sign in to a site or enter a two-factor code.

1. Click **Take control**. The bot's desktop work pauses.
2. Do what's needed on the desktop.
3. Click **Hand back**. The bot continues.

The bot stays paused until you hand back control, even if you close the page or the server restarts.

## Approve held actions

Before a desktop job clicks, types, sets a value, or presses a key, an **intent check** asks two questions: is the action irreversible, and did you ask for it? Reading the screen and opening pages aren't checked.

The [judge model](#choose-the-judge-model) answers from your own messages, the job's task, and the action with its target, such as the button's role and name and the page's host. It never reads the page's text, so a page can't talk it into an action. A button or link named like Pay, Buy, Order, Send, Delete, or Confirm, in several languages, or Enter in a form field, always counts as irreversible, whatever the judge says.

An irreversible action the judge isn't confident you asked for is held. A card in the bot's chat shows the action in plain words, the page, and the messages it was checked against.

- Select **Approve** to run the action. The job continues where it stopped.
- Select **Decline**, add a reason if you like, and select **Decline** again. The job is told you declined, with your reason, and reports back.

A held job waits without a time limit, and other desktop jobs of the bot wait behind it. If the server restarts while an action is held, the card shows **Expired** and the action doesn't run.

The job knows your words, not only the bot's summary of them. When the bot starts a job or sends it a message, it names your messages the task comes from, and your latest message is always included. A job an automation started uses the automation's instructions as your request. A script automation's output never counts as your request, since whatever the script reads can write it.

### Choose the judge model

Choose the judge model in **Settings** > **Judge model**. One judge model checks every desktop job on the account.

The default is GPT-6 Luna through OpenAI Decisions. It needs an OpenAI API key; signing in with ChatGPT isn't enough. Other classifier models your provider keys reach are listed too, such as Jev from TypeSafe.

How sure the judge must be that you asked depends on the model. For Jev it's 50%, set from Crumble's intent eval, where Jev rated every action the owner asked for at 55% or more and every one they didn't at 42% or less. A model that hasn't been evaluated, GPT-6 Luna included, must be 90% sure.

When no key reaches a classifier model, a small chat model from a provider you set up judges instead, such as Claude Haiku 5.5. It gives no confidence, so a button named like Pay or Send is held unless it answers that you asked for it. With no model available at all, only those named buttons and Enter in a form field are held.

## Give the bot a secret

To let a coding job use an API key or token without it ever entering the workspace, give the bot a [credential](/concepts/credentials).
