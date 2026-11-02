---
title: Memory and Skills
description: How bots remember facts, learn reusable instructions, and how you undo what they learned.
sidebar:
  order: 4
---

Memory is what a bot knows, and skills are how it does things. Both grow as
you use the bot, and you can see and undo every change to either.

## Memory

Memory holds facts that matter across conversations, like your preferences or
a project's details. A bot needs the **Memory** capability to save them.

A memory is either the bot's own, or **shared** with every one of your bots
that has memory turned on. Every memory records where it came from: a bot
chat, you, a scheduled task, another bot, or a group chat.

Review and edit memories on the **Memory** page.

The bot's [jobs](/concepts/workspaces#jobs) see its memories too, but only
read them.

Facts about a bot's workspace machine, such as where it cloned a
repository, aren't memories: the bot and its jobs keep them in
[workspace notes](/concepts/workspaces#workspace-notes).

## Skills

A skill is a set of instructions for one kind of task, like writing a weekly
report or deploying a project. A bot sees only each skill's name and one-line
description, and loads the full instructions when a task calls for them. That's
why a bot with fifty skills doesn't pay for fifty skills on every turn.

| Kind        | What it is                                              |
| ----------- | ------------------------------------------------------- |
| **Default** | Ships with the server. Bots can read it, not change it. |
| **Shared**  | Available to all your bots.                             |
| **Own**     | Belongs to one bot.                                     |

A bot can write its own skills. When it changes a shared or default skill, it
makes its own copy, which takes the original's place for that bot only. Your
other bots keep the original.

A bot's [jobs](/concepts/workspaces#jobs) see the same skill list and load
skills the same way, so what the bot learned from earlier jobs applies to the
next one. Jobs don't write skills.

Manage skills in **Settings** > **Skills**. To turn a shared skill on for a
bot, open the skill and select the bot under **Used by**.

### Acting on Several Skills

Use the checkboxes on the **Skills** page to select shared skills and bots' own
skills across sections. **Select all results** selects only the current filter
and search results; each section also has its own select-all checkbox. Changing
the filter keeps your selection. Default skills cannot be selected.

The action bar shows how many skills are selected:

- **Delete** asks once and lists every selected skill. Deleting a source skill
  keeps any bot-specific copies already made from it.
- **Update** checks GitHub and applies available updates to selected installed
  skills. It reports skills skipped because they aren't installed from GitHub or
  are already up to date. You can still review updates individually first.
- **Assign to bots** enables shared skills for the bots you choose. For a bot's
  own skill it copies the instructions, description, and reference documents.
  Copies are editable and remember their source by ID. Assigning again skips an
  existing linked copy, preserving its edits—even if it was renamed. Picking the
  source bot leaves its original unchanged.
- **Remove from bots** disables shared skills and deletes only copies linked to
  the selected bot-specific source, including edited copies. It never deletes
  unrelated skills with the same name, or the source itself.

If an action partly fails, successful changes remain. The results name failed
skills and bots with the reason, and keep failed skills selected so you can
retry. Successful and skipped skills are deselected. A copy whose source was
deleted remains an independent editable skill; manage it directly in its bot's
section.

### Installing Skills from GitHub

To add skills someone published on GitHub, select **Install from GitHub** on
the **Skills** page and enter `owner/repo`, or a github.com link to a folder.
Crumble lists every folder with a `SKILL.md`. Check the skills you want and
the bots that should use them, then select **Install**.

- **Only public repositories.** Crumble reads them without signing in.
- **Only the instructions.** Each skill imports its `SKILL.md` and the
  Markdown documents in `references/`. The list shows which other files, such
  as scripts, are left out, so a skill that depends on them may not work.
- **Installed skills are shared and read-only.** Nobody can edit them, not
  you, not a bot. To change one, select **Make a copy**, which creates a
  normal shared skill that doesn't get updates.
- **One name, one skill.** A skill whose name a shared skill already has
  can't be installed until you rename or delete the other one. An installed
  skill can have the same name as a default skill, and replaces it.

Crumble checks each installed skill's branch once a day, or when you select
**Check for updates**. A skill whose files changed shows **Update available**.
Updates never install on their own: open the skill, review the changes, and
select **Update**. The update is recorded on the **Activity** page, so you can
revert it.

## Learned Changes

After a turn with a lot of tool use, a background review looks at what the
bot did and may update its skills or memories. These are learned changes.
Every turn counts: chat turns, scheduled runs, event automations, and group chat
turns, plus each coding job's work once the job reports back. A review of a
group chat turn, like the turn itself, changes only the bot's own memory, never
shared memory. The review never saves instructions it finds in outside data,
such as an event's payload or a web page.

**Every change to a skill or memory is recorded with its before and after
state**, whether you made it, a bot did, or a review did. Open the **Activity**
page to see the diff and revert any change.

## Cleanup

Bots write skills faster than they retire them, so Crumble tidies up after
them. Every six hours, it checks the skills bots created. A skill unused for 14 days
is marked stale, and one unused for 30 days is archived. Loading a stale skill
makes it active again.

Pinned skills and skills that a scheduled task uses are never archived.
Archiving deletes nothing: an archived skill only leaves the bot's skill list.

## Pinned Skills

Pin one of a bot's own skills from its menu on the **Skills** page to keep it
as it is. Bots and reviews can't change or delete a pinned skill, and cleanup
never marks it stale. You can still edit it.
