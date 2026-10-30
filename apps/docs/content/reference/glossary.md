---
title: Glossary
description: The words Crumble uses, and the ones it avoids.
sidebar:
  order: 2
---

These definitions are copied from the canonical [glossary](https://github.com/crumble-project/bot/blob/main/GLOSSARY.md) in `crumble-project/bot`. If they differ, that file wins.

### Bot

An independently configured assistant with its own identity, memory, capabilities, and responsibilities.

Avoid: Persona, session.

### Bot request

A bot's proposal for a new bot, which the owner approves, edits, or declines in the bot chat. An approved bot is independent of the bot that asked for it.

Avoid: Bot creation request.

### Bot chat

The continuous direct-message exchange between a bot and its owner, including work the bot performs in the background.

Avoid: Conversation session, new chat.

### Bot chat delivery

The progress of an owner's message from sending to confirmation in the bot chat's transcript, including failed sends and retries.

Avoid: Message execution, completed bot work.

### Group chat

A conversation between the owner and several bots, with one shared transcript in which every message shows its sender. It is separate from each member's bot chat.

Avoid: Room, channel, group session.

### Transcript

The complete visible history of a bot chat or group chat, including messages, replies, tool activity, and compaction events.

Avoid: Model context.

### Working context

The selected recent messages, summaries, instructions, and recalled material available to the bot for its next response.

Avoid: Full history, transcript.

### Compaction

Summarizing older working context while keeping the original transcript available to the owner.

Avoid: Deleting history, starting a new chat.

### Reply

A new message linked to an earlier transcript message, recalling that message and bounded surrounding context for the bot.

Avoid: Fork, branch, session.

### Shared

Available to every bot that opts in, as opposed to belonging to one bot. Memory, skills, and MCP servers are either shared or a bot's own.

Avoid: Global, public.

### Skill

A package of instructions for a class of task: a main document with a name and description, plus optional reference documents loaded only when needed. A skill is a default, shared, or a bot's own.

Avoid: Prompt snippet, plugin.

### Learned change

A change a bot or its review made to its own skills or memory, recorded with its source and reversible by the owner.

Avoid: Auto-save, self-update.

### Coding job

Background work a bot hands to a separate agent that edits files and runs commands in the bot's workspace. The job's answer returns to the bot's chat.

Avoid: Subagent, session, sub-chat.

### Automation

A prompt a bot receives once at a set time or repeatedly on a schedule, answered in its bot chat. The owner or a bot can create one.

Avoid: Task, scheduled task, routine, cron job.

### Script automation

An automation that runs a shell command in its bot's workspace instead of sending a prompt to the bot chat. Only a bot with coding jobs has script automations, and only for itself.

Avoid: Script task, cron job, routine, script job.

### Workspace

A bot's persistent files for coding jobs and desktop jobs, on a disk only that bot's jobs can reach. The machine running them starts and stops as needed.

Avoid: Sandbox, container, VM (in product language).

### Credential

A secret value the owner gives one bot for a list of hosts. The bot's jobs use it through a placeholder, so the value never enters the workspace.

Avoid: Secret, API key, environment variable (in product language).

### Login

A username and password, with an optional one-time code, that a bot's desktop jobs can fill into web pages on given hosts. Unlike a credential's, the value enters the workspace, in the page it is filled into; the password never reaches the bot's model or transcript.

Avoid: Account, saved password (in product language).

### Password manager

1Password or Bitwarden Secrets Manager, connected to an account so credentials, provider API keys, and MCP server tokens can be read from it instead of stored in Crumble.

Avoid: Vault provider, secret store.

### Bot desktop

A bot's own graphical desktop, with a browser and apps, inside its workspace. Not the Crumble desktop client.

Avoid: Den, bot screen, virtual desktop, computer.

### Desktop job

Background work a bot hands to a separate agent that operates the bot desktop's windows with mouse and keyboard. The job's answer returns to the bot's chat.

Avoid: Den job, computer use session, browser agent.

### Taking control

The owner operating the bot desktop directly, which pauses desktop work until the owner hands control back.

Avoid: Takeover, remote control, screen sharing.
