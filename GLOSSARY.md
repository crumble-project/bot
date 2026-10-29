# Crumble

Crumble gives each bot an identity, ongoing responsibilities, and a continuous chat with its owner.

This is the canonical glossary for every Crumble repository. Other repositories link here instead of copying terms.

## Language

**Bot**:
An independently configured assistant with its own identity, memory, capabilities, and responsibilities.
_Avoid_: Persona, session

**Bot request**:
A bot's proposal for a new bot, which the owner approves, edits, or declines in the bot chat. An approved bot is independent of the bot that asked for it.
_Avoid_: Bot creation request

**Bot chat**:
The continuous direct-message exchange between a bot and its owner, including work the bot performs in the background.
_Avoid_: Conversation session, new chat

**Bot chat delivery**:
The progress of an owner's message from sending to confirmation in the bot chat's transcript, including failed sends and retries.
_Avoid_: Message execution, completed bot work

**Group chat**:
A conversation between the owner and several bots, with one shared transcript in which every message shows its sender. It is separate from each member's bot chat.
_Avoid_: Room, channel, group session

**Transcript**:
The complete visible history of a bot chat or group chat, including messages, replies, tool activity, and compaction events.
_Avoid_: Model context

**Working context**:
The selected recent messages, summaries, instructions, and recalled material available to the bot for its next response.
_Avoid_: Full history, transcript

**Compaction**:
Summarizing older working context while keeping the original transcript available to the owner.
_Avoid_: Deleting history, starting a new chat

**Reply**:
A new message linked to an earlier transcript message, recalling that message and bounded surrounding context for the bot.
_Avoid_: Fork, branch, session

**Shared**:
Available to every bot that opts in, as opposed to belonging to one bot. Memory, skills, and MCP servers are either shared or a bot's own.
_Avoid_: Global, public

**Skill**:
A package of instructions for a class of task: a main document with a name and description, plus optional reference documents loaded only when needed. A skill is a default, shared, or a bot's own.
_Avoid_: Prompt snippet, plugin

**Learned change**:
A change a bot or its review made to its own skills or memory, recorded with its source and reversible by the owner.
_Avoid_: Auto-save, self-update

**Coding job**:
Background work a bot hands to a separate agent that edits files and runs commands in the bot's workspace. The job's answer returns to the bot's chat.
_Avoid_: Subagent, session, sub-chat

**Automation**:
A prompt a bot receives once at a set time or repeatedly on a schedule, answered in its bot chat. The owner or a bot can create one.
_Avoid_: Task, scheduled task, routine, cron job

**Script automation**:
An automation that runs a shell command in its bot's workspace instead of sending a prompt to the bot chat. Only a bot with coding jobs has script automations, and only for itself.
_Avoid_: Script task, cron job, routine, script job

**Workspace**:
A bot's persistent files for coding jobs and desktop jobs, on a disk only that bot's jobs can reach. The machine running them starts and stops as needed.
_Avoid_: Sandbox, container, VM (in product language)

**Credential**:
A secret value the owner gives one bot for a list of hosts. The bot's jobs use it through a placeholder, so the value never enters the workspace.
_Avoid_: Secret, API key, environment variable (in product language)

**Password manager**:
1Password or Bitwarden Secrets Manager, connected to an account so credentials, provider API keys, and MCP server tokens can be read from it instead of stored in Crumble.
_Avoid_: Vault provider, secret store

**Web search provider**:
The service the owner chooses for the account through which every bot searches the web and reads pages.
_Avoid_: Search backend, search engine

**Mixed**:
The default web search provider, which spreads each account's searches across services that are free to use without a key.
_Avoid_: Free tier, keyless provider

**Bot desktop**:
A bot's own graphical desktop, with a browser and apps, inside its workspace. Not the Crumble desktop client.
_Avoid_: Den, bot screen, virtual desktop, computer

**Desktop job**:
Background work a bot hands to a separate agent that operates the bot desktop's windows with mouse and keyboard. The job's answer returns to the bot's chat.
_Avoid_: Den job, computer use session, browser agent

**Taking control**:
The owner operating the bot desktop directly, which pauses desktop work until the owner hands control back.
_Avoid_: Takeover, remote control, screen sharing
