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

**Message gateway**:
A connection that sends the owner's messages from an external platform to an existing bot chat and returns only their associated answers. Discord is the first supported platform.
_Avoid_: Chat mirror, new session

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

**Installed skill**:
A shared skill installed from a folder in a public GitHub repository. Nobody can edit it; the owner updates it from upstream or makes an editable copy.
_Avoid_: Imported skill, remote skill

**Pinned skill**:
A bot's own skill the owner pinned: bots and reviews can't change it, and cleanup leaves it alone. The owner can still edit it.
_Avoid_: Locked skill, immutable skill

**Learned change**:
A change a bot or its review made to its own skills or memory, recorded with its source and reversible by the owner.
_Avoid_: Auto-save, self-update

**Coding job**:
Background work a bot hands to a separate agent that edits files and runs commands in the bot's workspace. The job's answer returns to the bot's chat.
_Avoid_: Subagent, session, sub-chat

**Automation**:
A prompt a bot receives once at a set time, repeatedly on a schedule, or whenever an event arrives at an event source, answered in its bot chat. The owner or a bot can create one.
_Avoid_: Task, scheduled task, routine, cron job

**Script automation**:
An automation that runs a shell command in its bot's workspace instead of sending a prompt to the bot chat. Only a bot with coding jobs has script automations, and only for itself.
_Avoid_: Script task, cron job, routine, script job

**Event relay**:
The Doorstep server that receives webhooks for the account and forwards them to Crumble over Crumble's own outbound connection, so Crumble needs no public address.
_Avoid_: Webhook proxy, tunnel

**Event source**:
One webhook address on the event relay, named by the owner and usable by every bot of the account. Each event that arrives there starts the automations that use the source.
_Avoid_: Webhook, hook, trigger

**Workspace**:
A bot's persistent files for coding jobs and desktop jobs, on a disk only that bot's jobs can reach. The machine running them starts and stops as needed.
_Avoid_: Sandbox, container, VM (in product language)

**Credential**:
A secret value the owner gives one bot for a list of hosts. The bot's jobs use it through a placeholder, so the value never enters the workspace.
_Avoid_: Secret, API key, environment variable (in product language)

**GitHub App**:
A GitHub identity the owner creates in Crumble on one GitHub account and assigns to bots. In that account's repositories, the bots' coding jobs commit, push, and open pull requests as its `slug[bot]` user, through the `GH_TOKEN` credential, or as the owner when the owner signed in through it. A bot uses at most one per account.
_Avoid_: GitHub integration, machine user, bot account

**Login**:
A username and password, with an optional one-time code, that a bot's desktop jobs can fill into web pages on given hosts. Unlike a credential's, the value enters the workspace, in the page it is filled into; the password never reaches the bot's model or transcript.
_Avoid_: Account, saved password (in product language)

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

**Intent check**:
A check, before a desktop job's acting call runs, of whether the action is irreversible and whether it follows from the owner's request. Run by the judge model, never by the job itself. An action that fails it is held until the owner approves or declines it.
_Avoid_: Guardrail, safety check, approval gate

**Judge model**:
The model the owner chooses for the account that runs every intent check.
_Avoid_: Classifier, checker model, supervisor
