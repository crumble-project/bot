# Bundled default skills

Default skills available to every Crumble bot. The server loads each immediate subdirectory's `SKILL.md` (and optional `references/*.md` documents) at startup.

## Structure

```markdown
---
name: example
description: One-line summary of when this skill applies.
---

# Example

Instructions loaded when a bot calls the `skill` tool.
```

- **On-demand loading:** Bots see defaults by `name` and `description` in their working context and load `SKILL.md` or `references/<topic>.md` (up to 20 per skill) through the `skill` tool when needed.
- **Read-only:** Defaults are marked **Default · Every bot** and cannot be modified through the API or by bots; a bot refines a default by creating its own skill with the same name.
- **Configuration:** Served from `skills/` by default and bundled into the Docker image. Override with `CRUMBLE_SKILLS_DIR`.
