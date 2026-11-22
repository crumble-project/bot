# Remove group chats

**Status:** draft for approval.

## Goal

Crumble supports only the continuous direct chat between each bot and its owner. Remove group chats completely from this repository.

The owner confirmed that existing group chats, their history, and their uploaded files can be permanently deleted.

## Behavior

1. The web client has no group-chat navigation, creation, membership management, transcript, composer, or library.
2. Owners and bots cannot create, read, update, or send messages to group chats through the server.
3. Group chats do not start or resume work after an upgrade. Remove group-only orchestration, prompts, tools, and event handling.
4. Direct bot chats retain their existing behavior, history, files, replies, notifications, and background work.
5. Bots that belonged to groups remain intact. Removing a group does not delete a member bot or its own data.
6. Old group-chat links cannot reopen a group or expose its data. The web client recovers to the normal bot interface.

## Data removal

The upgrade permanently removes group records, memberships, transcripts, group-only runtime state, and group library entries.

Remove files stored only for groups. Preserve any file bytes still referenced by a bot's library, including identical uploads shared by content hash.

Cleanup must finish before normal server work starts. Interrupted cleanup must be safe to retry without deleting direct-chat data.

Preserve the existing migration history. Add forward migration and upgrade cleanup as needed; do not reset the database or run cleanup against production during implementation.

This change does not erase backups, bot memory, or copies already present in a bot's own chat or workspace. It provides no export or conversion into direct chats. Self-hosters must back up before upgrading; restoring a backup is the recovery path.

## Interfaces and implementation scope

- Remove group endpoints, event variants, types, and generated OpenAPI definitions. No deprecated group API or compatibility shim remains.
- Remove group-only services, storage, UI components, and tests. Simplify shared code only where its group branch becomes unnecessary.
- Preserve direct-chat API behavior. Older native clients lose group functionality; changes to the Apple and Android repositories are outside this change.
- Update current user and contributor documentation, the canonical glossary, and the changelog. Historical plans, decisions, release notes, and migrations remain historical records.
- Add no dependencies and make no unrelated refactors.

## Alternatives

Hiding the UI leaves the group API, runtime, and maintenance cost in place. Preserving inaccessible data avoids irreversible deletion but leaves obsolete storage behind. Full removal with data deletion matches the owner's requested scope.

The main cost is a breaking API change and irreversible deletion on upgrade. Neither is hidden behind a feature flag.

## Acceptance criteria

- No active server, web, or contract code supports group chats; remaining references are migration cleanup or historical records.
- An upgrade with existing groups removes their records, history, runtime state, and exclusively owned files.
- A fresh database initializes without group support.
- Repeating cleanup after interruption completes safely.
- Member bots, direct-chat history, bot libraries, and content-hash files still referenced by bots survive unchanged.
- Existing direct-chat checks pass. Generated OpenAPI files match the reduced contract.
- Run `bun run check` at the repository root and `bun run check` in `apps/docs`. Report failures and skipped verification.

## Review

Approve this scope before implementation planning. The implementation plan will identify the exact migration and disk-cleanup sequence.
