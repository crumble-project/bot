# Shared skill defaults

This directory contains the shared defaults that every Crumble bot follows. The server reads each immediate subdirectory's `SKILL.md` at startup. Defaults appear under **Shared** in the desktop app alongside optional skills from the database.

## Add or edit a default

1. Create a folder with a lowercase, hyphenated name.
2. Add `SKILL.md` with instructions. Optional frontmatter supports single-line `name:` and `description:` values.
3. Restart the server to load changes.

For example:

```markdown
---
name: example
description: Explain when these instructions apply.
---

# Example

Write the instructions here.
```

## Reference documents

A default may carry depth that bots need only sometimes, such as a decision table or provider quirks, as Markdown files in a `references` directory next to `SKILL.md`, for example `references/cron.md`. The server lists them with the skill and a bot loads one only when it asks for it. Name files by topic in lowercase with hyphens, and keep at most 20 per skill.

Bots see every default by name and description only and load its instructions when the task calls for it, so the description must say when the skill applies.

Defaults apply automatically to existing and new bots. The app displays them as read-only entries marked **Default · Every bot**. Optional shared skills remain editable in the app and enabled per bot. Personal skills remain in each bot's profile.

The server reads this directory by default and the Docker image bundles it. Set `CRUMBLE_SKILLS_DIR` to serve another directory; an explicitly configured missing directory prevents startup.
