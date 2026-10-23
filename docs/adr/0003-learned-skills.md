# Learned skills

Implements [feature 0005](https://github.com/crumble-project/spec/blob/main/features/0005-learned-skills.md).

Every skill is a row in the `skills` table, with `agent_id` set for a bot's own skills and null for shared ones, the same split the `memories` table uses. Reference documents are rows in `skill_documents`, keyed by skill and relative path. Default skills stay files in the skills directory, read at startup; their `references/*.md` files become documents the same way.

Bots see skills only by name and description in their instructions and load content through the `skill` model tool. A bot's own skill shadows a shared skill of the same name, which shadows a default, so a bot can refine a skill it cannot change.

## The agent's inline `skills` field

Contract 1.x clients read and write a bot's own skills as `{ name, instructions }` entries on the agent. The field stays, as a view: reading lists the bot's skill rows by name and instructions; writing replaces them by name. A name that already exists keeps its row, and with it the description, documents, provenance, and usage counters a client that only knows the inline field cannot see. Names the write omits are deleted, as before. The full records live behind `GET /v1/agents/{id}/skills`.

## Writes, reads, and the change record

A bot changes its skills only through the `skill_manage` tool, which validates and applies a batch inside one store transaction. The tool refuses to patch, rewrite, or delete a skill the turn has not loaded; reads are tracked per turn, keyed by the conversation and the submissions the run answers, because the run's task ID changes with every tool round. Every store write to skills and memories takes the actor and source as a parameter and appends a `learned_changes` row with the full before and after state, so a revert needs nothing but that row. Recording is telemetry: a failure to record is logged and never fails or undoes the write, inside or outside a transaction. Shared and default skills are read-only for bots; a bot shadows one by name.

The skill migration moves the schema and the inline skills in one transaction, and transfers any inline skills still on an agent row at every startup, so an interrupted migration can neither lose skills nor keep them in two places.

## The review

A review is a separate conversation in the bot's own Pi store, owned by a background anchor task like a group conversation, and marked by a `ReviewConversation` doc that names the execution it reviews and the stores it may change. `configure` reads the doc and gives that conversation the review model, the review prompt, and only the memory, skill, and `skill_manage` tools, so a review cannot reach the chat, jobs, delegation, or integrations. The tool context carries the reviewed execution, which makes the actor `review` and the source that execution in the change record. The review's input is the turn in full, preceded by the recent chat for the referents of corrections, and the bot's standing instructions; the earlier chat gives way first when the budget binds. The budget covers every model request the review makes: a generation hook on the review extension adds up each request's messages and throws before a request that would exceed `budgetChars`, which is the configured token cap lowered to 75% of the review model's context window. The digest may take at most half of it. Per-bot counters of tool-activity rounds live in `review_counters` and are owned by the review module alone: after a turn it reads how many rounds followed the turn's last skill or memory write and sets the counter to that, or adds the whole turn when nothing was written. Reviews in flight are listed in `pending_reviews`, and a restart aborts and forgets them instead of resuming. A review's changes are found by the execution recorded in their source, and the result is kept in `review_results` for `GET /v1/agents/{id}/reviews`.

## The curator

A deterministic pass over bot-created skills runs on startup and every six hours. It uses the skill's last use, or its creation when never used, so a never-used skill gets the full periods before it goes. Transitions are recorded with the `curator` actor and are reversible like any other change.

## Considered options

- **Bot-created skills in a separate table, owner-written ones inline.** Rejected: the specification lets a bot patch any of its own skills, and two homes for one concept would leak into every reader.
- **Breaking the inline field in a contract major version.** Rejected for now: the view costs one query per agent read and keeps every installed client working.
- **Marking reviews by request ID instead of a doc.** Rejected: the tools need the reviewed execution during the call, and a conversation-scoped doc is what group turns already use for the same need.
- **Posting the learned notice into the bot chat transcript.** Rejected for now: a transcript entry that is not an input or a model message has no precedent here; the `learned` activity event carries the change IDs and clients render the notice.
- **Files on disk for every skill, as Hermes Agent does.** Rejected: per-bot scope, the shared library, and the owner's edit and delete controls already live in the product database.

## Consequences

- `Store.updateAgent` with `skills` deletes rows a stale client write omits, including bot-created ones; the change record in a later milestone makes that reversible.
- Loading a default skill records no usage, because defaults have no row. The curator only manages bot-created skills, which always have one.
