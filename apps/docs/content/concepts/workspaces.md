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
- A **desktop job** uses a graphical desktop with a Chromium browser, with mouse and keyboard. It needs the **Bot desktop** capability.

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

## Give the bot a secret

To let a coding job use an API key or token without it ever entering the workspace, give the bot a [credential](/concepts/credentials).
