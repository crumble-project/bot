# Group chats milestone 5: group snapshot event schema

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** Clients can generate and validate group chat stream events from an exported schema, as they do for bot chats.

**Architecture:** Follows the [milestone 3 split](2026-10-21-group-chats-m3.md#milestone-split). The release tooling reads each bundle's event schema files from the bundle itself instead of assuming today's list. An added schema is a compatible change that needs a version increase; a removed one is breaking.

## Tasks

### Task 1: Releases may add event schemas

**Files:** `src/contract-release.ts`, `test/contract-release.test.ts`.

`validateContract`, `verifyBundle`, `projectEvents`, and `compareContracts` use `eventSchemaNames(directory)`. `downloadRelease` downloads the fixed assets plus every `*.schema.json` the release lists.

**Tests**, with a stand-in `oasdiff` reporting no breaking changes:
- An added schema with a minor increase passes.
- An added schema without an increase fails.
- A removed schema needs a major version.
- A bundle verifies against the schemas it carries.

### Task 2: Export the group snapshot schema

**Files:** `src/openapi.ts`, `src/api-contract.ts`, `openapi/`, `CHANGELOG.md`, `docs/architecture.md`, `docs/adr/0002-group-chats.md`.

`group-chat-snapshot.schema.json` is generated from `GroupChatSnapshot`.

## Verification

`bun run check` and `contract:validate` pass locally. CI's compatibility check against the latest published contract runs when the work is pushed; `oasdiff` is not installed locally.
