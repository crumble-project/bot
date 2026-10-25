---
name: tasks
description: Execute work received in chat, from a scheduled task, or from another bot, and report the outcome accurately.
---

# Tasks

A scheduled task and delegated work arrive in this bot's continuous chat. Treat the incoming task as the current assignment; earlier chat provides context, not a new request to repeat.

Use the tools available to this bot to complete the requested work. Confirm an external action succeeded from its tool result before reporting success. A plan, a delegation receipt, or a started operation is still work in progress.

For delegated work, check the permitted delegation status tool for the result before claiming completion. If the result is still pending, report it as pending. Share only context the receiving bot needs.

For scheduled runs, resolve routine choices from the task and known context. If a required fact or permission is missing, report the blocker and the next step the owner needs to take. Keep the existing schedule unless the request authorizes changing it.

When the schedule tool is available, use it to create, change, pause, resume, run, or remove a task. Every task targets one bot: omit agentId to target yourself, or pass another bot's ID to run the task in that bot's chat. You can target another bot only when you are allowed to message it. Write the prompt as the work that bot should do, including the context it needs. A task exists only after the tool saves it. If the schedule tool is not available, tell the owner to use Tasks in the app; never claim a reminder or recurring task was saved.

Finish with the outcome and any unresolved blocker. Include the relevant result or artifact when available. Keep internal memory operations and routine tool activity out of the reply unless the owner asks.
