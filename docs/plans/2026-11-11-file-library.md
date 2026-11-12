# File library implementation plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** The owner can send any file up to 100 MB in a bot chat or group chat; each file lands in that chat's library, which the owner browses in the web client and the bot reads through a library tool.
**Architecture:** A new `apps/server/src/files/` module stores bytes and extracted text on disk under the account directory by content hash, with one store.sqlite row per library entry. Messages carry file IDs instead of base64; admission turns each ID into inline text, an image block, or a reference. A library tool gives bot chats, group turns, coding jobs, and desktop jobs list, read, search, and copy into the workspace.
**Source:** [File library spec](../designs/file-library.md) (reviewed).

## Decisions

- Any file type, at most 100 MB per file, at most 8 files per message (`MAX_ATTACHMENTS`, `apps/server/src/shared/attachment-rules.ts:3`).
- Only files the owner sends go into a library. One library per bot and one per group chat.
- Files are uploaded first; messages name file IDs. The base64 `attachments` field is removed from the message routes, with no compatibility path.
- File IDs are UUIDv7 from `Bun.randomUUIDv7()` (exists in Bun 1.4.4; `z.uuid()` in zod 4.6.7 accepts it). Nothing else moves to UUIDv7 here (crumble-project/bot#137).
- Bytes live in `users/<account>/files/` under their SHA-256, stored once per account. One library entry per hash per library.
- Uploading adds the entry at once. Only an explicit library delete removes it; the composer never deletes.
- Bytes and extracted text are written under `files/.tmp/` and renamed into place before the entry row commits. Removing bytes and creating entries share one lock per account.
- Text of at most 32 KB (UTF-8 bytes) goes into the message inline. Longer text, and every other format, becomes a reference with name, type, size, and ID.
- Images of PNG, JPEG, GIF, or WebP up to 5 MB (`MAX_IMAGE_BYTES`) reach the model as image blocks, as today; larger images are references.
- PDF text is extracted at upload with `unpdf` (MIT, no dependencies, wraps PDF.js; 2.1.0 on npm) in a Bun `Worker` with a time limit and `resourceLimits`, and is stored beside the bytes. A failure or a PDF without text leaves a reference with a note. Extraction runs inside the server, not in a separate service.
- Downloads send `Content-Disposition: attachment` with RFC 6266 `filename*`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, the stored `Content-Type` for the four image types and `application/octet-stream` otherwise, `Cache-Control: private, no-cache`, and `ETag` set to the content hash. The web UI shares the API's origin (`apps/server/src/app/server.ts` imports `webUIRoutes`).
- The library tool reaches the bot's own library in a bot chat; the group library and the bot's own in a group turn, each result labeled with its library; and the bot's own library in coding jobs and desktop jobs. Copy exists only for bots with a workspace and writes only inside `/workspace`.
- Tool output is bounded like Pi's read tool: at most 50 KB or 2,000 lines per response, with a continuation (`DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, used in pi-durable `dist/tools/read.js:50`).
- Deleting a file never fails accepted work. A queued message is delivered with the file marked deleted and a model note. A retry with the same request ID returns the existing execution. A new send naming a deleted file is refused with `<name> was deleted from the library`.
- Transcript entries record files under a new metadata key `files`. The old key `attachments` (`apps/server/src/bots/runtime.ts:184`) only ever means legacy files, which display as "File deleted". Nothing is migrated.
- A pending execution with old-shape attachments is resubmitted under its request ID with text only; Pi returns the original if it had committed it, even with different content (checked in review). After the submission settles, its input entry tells which version ran: legacy `attachments` metadata means the original ran, otherwise the text-only version ran and the owner gets a send-again notice. A crash between resubmission and settling can lose that notice; accepted, since it only affects messages in flight during the upgrade.
- The bot's earlier working context keeps what it read from a deleted file.

## Constraints

- Read `AGENTS.md`, `bot/AGENTS.md`, `GLOSSARY.md`, and `CONTRIBUTING.md` first.
- Read `apps/server/node_modules/effect/AGENTS.md` completely before writing Effect code.
- One new dependency: `unpdf`, in `apps/server/package.json`. `THIRD_PARTY_NOTICES.md` covers copied and bundled code (shadcn, noVNC, pako), not installed packages, so it stays unchanged.
- No `any`, no inline imports, no compatibility shims. Comments only for why, at most 3 lines.
- Tests never allocate 100 MB: `Library` takes its size limit as a parameter.
- The CI unit test job must finish in two minutes; check its duration after adding tests.
- Schema: edit `apps/server/src/files/schema.ts`, then `bun run --cwd apps/server db:generate --name file_library`.
- Contract: after route changes, `bun run openapi:generate`.
- Root check: `bun run check` (lint, format, typecheck, OpenAPI drift, `bun test --parallel`). VM and Railway tests stay skipped unless `CRUMBLE_VM_TESTS=1` or `CRUMBLE_RAILWAY_TESTS=1`.
- Docs check: `bun run check` from `apps/docs`.
- No staging, commits, pushes, or branch changes without the owner's permission.

## Out of scope

iOS, macOS, and Android clients; files bots produce; shared library files; extraction beyond plain text and PDF; a read-only workspace mount; S3 storage; library search, filters, folders, tags, pinning, or renaming; Discord file transfer; storage quotas; other UUIDv7 migrations; uploading from the library view; jobs started from a group chat.

## Review focus

1. A duplicate upload, then deleting another library's entry with the same hash: the remaining entry still downloads.
2. A crash between writing bytes and committing the row leaves no row; a leftover file in `.tmp/` is never served and is replaced by the next upload.
3. A file named `../../x` or a copy target of `/etc/x` lands inside `/workspace` or is refused.
4. An upload sent as `text/html` and named `a.png` downloads as `application/octet-stream`.
5. A library read on a 100 MB text file returns at most 50 KB and a continuation offset.

## Files

- Create `apps/server/src/files/ids.ts`: `newFileId()`.
- Create `apps/server/src/files/schema.ts`: the `libraryFiles` table.
- Create `apps/server/src/files/file-store.ts`: storage on disk by content hash, publication through a temp file and rename, the lock per account, removal of unreferenced bytes.
- Create `apps/server/src/files/library-repository.ts`: entries per library, newest first, lookup, delete.
- Create `apps/server/src/files/pdf-text.ts`, `apps/server/src/files/pdf-worker.ts`: bounded extraction.
- Create `apps/server/src/files/library.ts`: the `Library` service.
- Create `apps/server/src/files/files-api.ts`: HTTP routes for bots and group chats.
- Create `apps/server/src/files/message-files.ts`: what the model receives per file.
- Create `apps/server/src/files/library-tool.ts`: the bot tool.
- Modify `apps/server/src/shared/attachment-rules.ts`, `apps/server/src/shared/attachments.ts`: file-ID inputs; `attachmentHeaders` kept for screenshots.
- Modify `apps/server/src/contract/api-contract.ts`, `apps/server/src/contract/group-chats.ts`, `apps/server/src/contract/api-responses.ts`; regenerate `openapi/`.
- Modify `apps/server/src/app/api-requests.ts`: upload paths in `limitBodies`.
- Modify `apps/server/src/app/product-layer.ts`, `apps/server/src/app/api.ts`: wire `Library` and the routes.
- Modify `apps/server/src/bots/bots-submissions.ts`, `bots-admission.ts`, `bots-outcomes.ts`, `runtime.ts`, `apps/server/src/bot-store/execution-repository.ts`: file IDs through submission and admission; the library tool; upgrade recovery.
- Modify `apps/server/src/shared/request-ids.ts`: notice kind `files`.
- Modify `apps/server/src/group-chats/group-chat-post.ts`, `group-turn-input.ts`, `group-transcripts.ts`, `group-chats-api.ts`, `group-turns.ts`, `group-chat-service.ts`: the same for groups; the tool in group turns; library removal on delete.
- Modify `apps/server/src/transcript/transcript.ts`: file metadata or the deleted marker; `readAttachment` keeps screenshots only.
- Modify `apps/server/src/bots/bots-lifecycle.ts`: library removal on bot delete.
- Modify `apps/web/features/chat/composer.tsx`, `conversation.tsx`, `transcript.tsx`, `message-card.tsx`: upload, send IDs, downloads, deleted marker.
- Create `apps/web/features/library/api.ts`, `apps/web/features/library/library.tsx`: queries and the view.
- Modify `apps/web/app/router.tsx`, `apps/web/features/bot-chat/details.tsx`, `apps/web/features/group-chats/groups.tsx`: library routes and links.
- Modify `GLOSSARY.md`, `CHANGELOG.md`, `apps/docs/content/concepts/chats.mdx`, `apps/docs/content/reference/api.md`, `apps/docs/content/concepts/discord.md`, `apps/docs/content/self-hosting/backups.md`.
- Modify `docs/designs/file-library.md`: status to implemented, after review.

### Task 1: File store and library repository

**Files:** create `apps/server/src/files/ids.ts`, `schema.ts`, `file-store.ts`, `library-repository.ts`; test `apps/server/src/files/file-store.test.ts`, `library-repository.test.ts`; generate the migration.
**Interfaces:**
- Consumes: `accountDir` (`apps/server/src/app/data-dir.ts:7`); `ProductDatabase` and the `Context.Service` layer pattern of `MemoryRepository` (`apps/server/src/memory/memory-repository.ts:10,32`); `agents` (`apps/server/src/bot-store/schema.ts`); `groupChats` (`apps/server/src/group-chats/schema.ts:10`).
- Produces:
  ```ts
  export const newFileId: () => string;
  export type LibraryRef =
    | { kind: "bot"; agentId: string }
    | { kind: "group"; groupId: string };
  export type LibraryEntry = {
    id: string; library: LibraryRef; name: string; mimeType: string;
    size: number; hash: string; text: "none" | "extracted" | "failed"; createdAt: string;
  };
  export class FileTooLarge extends Data.TaggedError("FileTooLarge")<{ limit: number }> {}
  export class FileStore extends Context.Service<FileStore, {
    put(source: ReadableStream<Uint8Array>, limit: number): Effect.Effect<{ hash: string; size: number }, FileTooLarge>;
    putText(hash: string, text: string): Effect.Effect<void>;
    bytes(hash: string): Effect.Effect<ReadableStream<Uint8Array>, NotFound>;
    text(hash: string): Effect.Effect<string | null>;
    withLock<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
    removeUnreferenced(hash: string): Effect.Effect<void>;
  }>() {}
  export class LibraryRepository extends Context.Service<LibraryRepository, {
    add(input: Omit<LibraryEntry, "id" | "createdAt">): Effect.Effect<{ entry: LibraryEntry; existed: boolean }>;
    get(library: LibraryRef, id: string): Effect.Effect<LibraryEntry | undefined>;
    getMany(library: LibraryRef, ids: readonly string[]): Effect.Effect<LibraryEntry[]>;
    list(library: LibraryRef, page: { before?: string; limit: number }): Effect.Effect<LibraryEntry[]>;
    hashes(library: LibraryRef): Effect.Effect<string[]>;
    remove(library: LibraryRef, id: string): Effect.Effect<LibraryEntry | undefined>;
    referenced(hash: string): Effect.Effect<boolean>;
  }>() {}
  ```

- [x] Write the failing tests: `put streams into files/<sha256> and returns the size`; `put over the limit fails with FileTooLarge and leaves nothing in files/ or files/.tmp/`; `bytes ignores a leftover temp file and the next put replaces it`; `add with the same hash in one library twice returns existed: true and keeps one row`; `list returns newest first and pages by before`; `removeUnreferenced keeps bytes while another library's entry has the hash`.
- [x] Run `bun test apps/server/src/files/`. Expected: fails, the modules don't exist.
- [x] Implement: `newFileId` returns `Bun.randomUUIDv7()`. The table has a unique index on library and hash, a nullable `agent_id` and `group_id` with cascade on delete, and a check that exactly one is set. The store hashes while streaming to `files/.tmp/<random>`, stops at the limit, and renames to `files/<hash>`. The lock is a per-account `Semaphore` of one permit.
- [x] Run `bun run --cwd apps/server db:generate --name file_library`.
- [x] Run `bun test apps/server/src/files/`. Expected: passes.
- [x] Checkpoint: stage `apps/server/src/files/`, `apps/server/drizzle/`; commit `feat(files): store library files by content hash`.

### Task 2: PDF text extraction

**Files:** create `apps/server/src/files/pdf-text.ts`, `pdf-worker.ts`; test `apps/server/src/files/pdf-text.test.ts`; fixtures `apps/server/test/fixtures/text.pdf`, `scan.pdf`, `pathological.pdf`; modify `apps/server/package.json`.
**Interfaces:**
- Produces: `export function extractPdfText(bytes: Uint8Array, limits: { ms: number; memoryMib: number }): Promise<{ kind: "text"; text: string } | { kind: "none" } | { kind: "failed"; reason: string }>`.

- [x] Add `unpdf` to `apps/server/package.json` with `bun add --cwd apps/server unpdf`.
- [x] Write the failing tests: `returns text containing "Crumble library fixture" for text.pdf`; `returns none for scan.pdf`; `returns failed within 2 s for pathological.pdf with a 1 s limit`; `returns failed when the worker exceeds a 32 MiB memory limit`.
- [ ] Run `bun test apps/server/src/files/pdf-text.test.ts`. Expected: fails.
- [x] Implement with `new Worker(new URL("./pdf-worker.ts", import.meta.url), { resourceLimits: { maxOldGenerationSizeMb } })` and `worker.terminate()` on timeout. Bun accepts `resourceLimits` without error (checked); the memory test proves it is enforced. If it isn't, record a Deviation with the limit used instead.
- [x] Run the test. Expected: passes.
- [x] Checkpoint: commit `feat(files): extract pdf text in a bounded worker`.

### Task 3: Library service and HTTP routes

**Files:** create `apps/server/src/files/library.ts`, `files-api.ts`; modify `apps/server/src/contract/api-contract.ts`, `group-chats.ts`, `api-responses.ts`, `apps/server/src/app/api-requests.ts`, `apps/server/src/app/api.ts`, `apps/server/src/app/product-layer.ts`; test `apps/server/src/app/api.test.ts`, `apps/server/src/group-chats/group-chats-api.test.ts`; regenerate `openapi/`.
**Interfaces:**
- Consumes: Task 1 `FileStore`, `LibraryRepository`, `newFileId`, `FileTooLarge`; Task 2 `extractPdfText`; `define`, `json`, `empty` (`apps/server/src/contract/route.ts`), with `parsesBody` for the upload since the handler reads the raw body (`route.ts:10`).
- Produces:
  ```ts
  export type LibraryFile = { id: string; name: string; mimeType: string; size: number; createdAt: string };
  export class Library extends Context.Service<Library, {
    upload(library: LibraryRef, input: { name: string; mimeType: string; body: ReadableStream<Uint8Array> }): Effect.Effect<{ file: LibraryFile; existed: boolean }, FileTooLarge | NotFound>;
    list(library: LibraryRef, page: { before?: string; limit: number }): Effect.Effect<LibraryFile[], NotFound>;
    download(library: LibraryRef, id: string): Effect.Effect<{ file: LibraryFile; hash: string; body: ReadableStream<Uint8Array> }, NotFound>;
    remove(library: LibraryRef, id: string): Effect.Effect<void, NotFound>;
    entries(library: LibraryRef, ids: readonly string[]): Effect.Effect<Map<string, LibraryEntry>>;
    text(entry: LibraryEntry): Effect.Effect<string | null>;
    removeLibrary(library: LibraryRef): Effect.Effect<void>;
  }>() { static layer(options: { maxFileBytes: number }): Layer.Layer<Library, never, FileStore | LibraryRepository> }
  export const MAX_FILE_BYTES = 100 * 1024 * 1024;
  export const downloadHeaders: (file: LibraryFile, hash: string) => Record<string, string>;
  ```
- Routes, following the `/v1/agents/{id}/attachments/...` naming (`api-contract.ts:832`): `uploadFile` `POST /v1/agents/{id}/files`, `listFiles` `GET /v1/agents/{id}/files?before&limit`, `getFile` `GET /v1/agents/{id}/files/{fileId}`, `deleteFile` `DELETE /v1/agents/{id}/files/{fileId}`, and `uploadGroupFile`, `listGroupFiles`, `getGroupFile`, `deleteGroupFile` under `/v1/group-chats/{id}/files`. The upload body is the raw bytes with `Content-Type`, the name in header `X-File-Name` (percent-encoded UTF-8), and the response `201 { file: LibraryFile, existed: boolean }`.

- [x] Write the failing tests in `api.test.ts`, with `Library.layer({ maxFileBytes: 1024 })` in the setup: `uploads a zip and a pdf and lists them newest first`; `refuses an upload over the limit with 413 and "big.bin is larger than 1 KB"`; `uploading the same bytes again returns existed: true and the same id`; `getFile sends attachment, nosniff, sandbox CSP, no-cache and ETag; octet-stream for text/html named a.png; image/png for a png`; `a deleted file returns 404, also with If-None-Match`; `another account can't list, download, or delete`.
- [x] Write the same for groups in `group-chats-api.test.ts`.
- [ ] Run both files. Expected: fail with 404 on the new routes.
- [x] Implement `Library`. Upload runs `put` and `add` under `withLock`. After `put`, run `extractPdfText` for `application/pdf`, and for text files store the text when it decodes as UTF-8 (`decodeText`, `apps/server/src/shared/attachments.ts`). A missing bot or group fails with `NotFound`.
- [x] Add the upload paths to `limitBodies` (`apps/server/src/app/api-requests.ts:60`) with `bodyLimit({ maxSize: MAX_FILE_BYTES })`. It checks `Content-Length` without buffering; `Library.upload` enforces the injected limit while streaming.
- [x] Run `bun run openapi:generate`, then both test files. Expected: pass.
- [x] Checkpoint: commit `feat(files): add library routes for bots and group chats`.

### Task 4: Bot chat messages carry file IDs

**Files:** create `apps/server/src/files/message-files.ts`; modify `apps/server/src/shared/attachment-rules.ts`, `attachments.ts`, `apps/server/src/contract/api-contract.ts`, `apps/server/src/bots/bots-submissions.ts`, `bots-admission.ts`, `runtime.ts`, `apps/server/src/bot-store/execution-repository.ts`, `apps/server/src/transcript/transcript.ts`; test `apps/server/src/app/api.test.ts`, `apps/server/src/bots/chat.test.ts`.
**Interfaces:**
- Consumes: Task 3 `Library.entries`, `Library.text`, `FileStore.bytes`.
- Produces:
  ```ts
  export const MAX_INLINE_TEXT_BYTES = 32 * 1024;
  export type MessageFile =
    | { id: string; name: string; mimeType: string; size: number }
    | { id: string; deleted: true };
  export type ResolvedFile =
    | { file: MessageFile & { deleted?: never }; content: { kind: "text"; text: string } | { kind: "image"; data: string } | { kind: "reference"; note?: string } }
    | { file: { id: string; deleted: true } };
  export function modelBlocks(files: readonly ResolvedFile[]): (TextContent | ImageContent)[];
  ```
- Message schema: `files: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([])` replaces `attachments` (`api-contract.ts:130`). The content-or-files refinement stays (`api-contract.ts:136`).

- [x] Write the failing tests in `chat.test.ts` with the faux provider: `small text arrives inline in an attachment block`; `text over 32 KB arrives as a reference naming the id and the library tool`; `pdf text follows the same rule`; `a pdf without text arrives as a reference with "no text could be read"`; `a 4 MB png arrives as an image block`; `a 6 MB png arrives as a reference`; `a zip arrives as a reference`; `a file deleted before admission arrives as deleted with the note and the message is delivered`.
- [x] Write the failing tests in `api.test.ts`: `messages accept file ids and refuse an unknown one`; `a new send naming a deleted file is refused with "<name> was deleted from the library"`; `a retry with the same request id returns the existing execution after the file was deleted`; `the transcript shows file metadata, then "deleted" after the delete`. Replace `accepts attachments on messages only, within their limits` (`api.test.ts:661`).
- [ ] Run `bun test apps/server/src/bots/chat.test.ts apps/server/src/app/api.test.ts`. Expected: fail.
- [x] Store the IDs as JSON in `executions.attachments`; `attachmentDigest` hashes the IDs.
- [x] At admission, resolve with `Library.entries`, build blocks with `modelBlocks`, and write `MessageFile[]` to entry metadata key `files` (`entryMetadata`, `runtime.ts:187`). `assertImageSupport` (`runtime.ts:299`) applies to image blocks only.
- [x] Transcript: read `files` metadata and resolve deletion per ID; legacy `attachments` metadata reads as deleted files. `readAttachment` keeps `screenshotImage` only (`transcript.ts:880`).
- [x] Run both. Expected: pass.
- [x] Checkpoint: commit `feat(chat)!: send files by library id`.

### Task 5: Upgrade recovery for old-shape executions

**Files:** modify `apps/server/src/bots/bots-admission.ts`, `bots-outcomes.ts`, `apps/server/src/shared/request-ids.ts`; test `apps/server/src/bots/chat.test.ts`.
**Interfaces:**
- Consumes: Task 4 admission; `runtime.submit` (`runtime.ts:787`); `runtime.settledTurn` (`runtime.ts:698`) for the settled input entry; `BotNotices.notice(agentId, text, requestId)` (`apps/server/src/bot-ports/bot-notices.ts:15`); `noticeRequest` (`request-ids.ts:18`).
- Produces: `NoticeKind` gains `"files"`.

- [x] Write the failing tests, inserting execution rows with base64 `attachments` directly: `an old-shape execution whose request Pi committed continues that submission and starts no second turn`; `an old-shape execution Pi never saw is delivered text-only, its files show as deleted, and the notice "Files sent just before the update didn't arrive. Send them again." appears`; `an execution without attachments is delivered normally`.
- [x] Run. Expected: fail.
- [x] In `submit`, when the column doesn't parse as file IDs, submit text only with the model note under the original request ID, and pass a `legacy: true` flag to the monitor.
- [x] In the monitor, after `runtime.wait` settles and only with `legacy`, read the input entry through `settledTurn`. Without legacy `attachments` metadata, post the notice via `BotNotices.notice` with `noticeRequest("files", "upgrade", execution.id)`.
- [x] Run. Expected: pass.
- [x] Checkpoint: commit `fix(chat): recover messages sent before the file library`.

### Task 6: Group chats carry file IDs

**Files:** modify `apps/server/src/group-chats/group-chat-post.ts`, `group-turn-input.ts`, `group-transcripts.ts`, `group-chats-api.ts`, `group-chat-service.ts`, `apps/server/src/contract/group-chats.ts`, `apps/server/src/contract/api-contract.ts`; test `group-chats-api.test.ts`, `group-turns.test.ts`, `group-transcripts.test.ts`.
**Interfaces:**
- Consumes: Task 3 `Library` with `{ kind: "group", groupId }`; Task 4 `modelBlocks`, `MessageFile`, `MAX_INLINE_TEXT_BYTES`.

- [x] Write the failing tests: `a group message with a file id shows the file in the group transcript`; `a member turn receives the file by the Task 4 rules`; `a file deleted before a member's turn arrives as deleted`; `a legacy group message with base64 attachments shows them as deleted and gives member turns nothing`; `GET /v1/group-chats/{id}/attachments/... returns 404`.
- [ ] Run. Expected: fail.
- [x] Implement. Group messages store `files: MessageFile[]` instead of `attachments` with bytes (`group-chat-post.ts:59`). `turnAttachments` (`group-turn-input.ts:83`) resolves IDs against the group library. Remove `groupAttachment` (`api-contract.ts:968`, `group-chats-api.ts:71`, `group-chat-service.ts:137`).
- [x] Run `bun run openapi:generate`, then the tests. Expected: pass.
- [x] Checkpoint: commit `feat(group-chats)!: send files by library id`.

### Task 7: Library tool

**Files:** create `apps/server/src/files/library-tool.ts`; modify `apps/server/src/bots/runtime.ts`, `apps/server/src/group-chats/group-turns.ts`; test `apps/server/src/files/library-tool.test.ts`, `apps/server/src/bots/chat.test.ts`, `apps/server/src/group-chats/group-turns.test.ts`.
**Interfaces:**
- Consumes: Task 3 `Library`; `defineTool` and `defineExtension` as `memoryExtension` uses them (`apps/server/src/memory/memory-tool.ts:118`); `RuntimeCallbacks.env(agent, target, context)` (`runtime.ts:104`); `ExecutionEnv.writeFile` and `appendFile`, which accept `Uint8Array` (pi-durable `dist/env/index.d.ts:187-188`); `WORKSPACE_PATH` (`apps/server/workspace-image/guest.ts:6`); `toolOutput` (`apps/server/src/shared/tool-output.ts`).
- Produces:
  ```ts
  export const LIBRARY_TOOL_NAME = "library";
  export const MAX_LIBRARY_OUTPUT_BYTES = 50 * 1024;
  export const MAX_LIBRARY_OUTPUT_LINES = 2000;
  export function libraryExtension(options: {
    agent: Agent;
    libraries: (context: { groupId: string | null }) => LibraryRef[];
    workspace: boolean;
  }): Extension;
  ```
  Actions: `list { before? }`, `read { id, offset?, length? }`, `search { id, query }`, `copy { id, path? }`, with the default path `/workspace/library/<sanitized name>`.

- [x] Write the failing tests: `list returns at most 50 KB with a before cursor`; `read returns at most 50 KB or 2000 lines and the next offset`; `search returns bounded matches with offsets`; `in a bot chat only the bot's library is reachable`; `in a group turn the group library and the bot's own are reachable and labeled, and another member's is not`; `copy writes the bytes under /workspace and reports the path`; `copy refuses ../../etc/x and /etc/x`; `a bot without a workspace has no copy action`; `a coding job reaches its bot's library`.
- [ ] Run. Expected: fail.
- [x] Install the extension in `toolExtensions` (`runtime.ts:416`) for bot chats and group turns: group turns keep extensions that pass `inGroupTurns` (`apps/server/src/shared/chat-only.ts:25`), so don't wrap it in `chatOnly`. For coding and desktop jobs, add the tool to `jobKnowledgeExtensionOf` (`runtime.ts:445`), which every job's conversation receives (`apps/server/src/jobs/jobs.ts:1368`), scoped to the bot's own library.
- [x] Copy streams `FileStore.bytes` in chunks through `appendFile` after an empty `writeFile`. It resolves the path with `node:path` `posix.resolve(WORKSPACE_PATH, path)` and refuses anything outside `WORKSPACE_PATH`.
- [x] Run. Expected: pass.
- [x] Checkpoint: commit `feat(files): let bots read and copy library files`.

### Task 8: Deleting bots and group chats removes their libraries

**Files:** modify `apps/server/src/bots/bots-lifecycle.ts`, `apps/server/src/group-chats/group-chat-service.ts`; test `apps/server/src/app/api.test.ts`, `apps/server/src/group-chats/group-chats-api.test.ts`.
**Interfaces:**
- Consumes: Task 3 `Library.removeLibrary`; `deleteAgent` (`bots-lifecycle.ts:63`); `remove` (`group-chat-service.ts:55`).

- [x] Write the failing tests: `deleting a bot removes its entries and bytes no other library uses`; `bytes shared with a group library survive deleting the bot`; the group equivalents.
- [x] Run. Expected: fail.
- [x] Implement `removeLibrary`: under the lock, collect `hashes`, delete the rows, then `removeUnreferenced` each hash. Call it before `agents.delete` and before the group row delete.
- [x] Run. Expected: pass.
- [x] Checkpoint: commit `feat(files): remove a library with its bot or group chat`.

### Task 9: Web client

**Files:** modify `apps/web/features/chat/composer.tsx`, `conversation.tsx`, `transcript.tsx`, `message-card.tsx`, `apps/web/app/router.tsx`, `apps/web/features/bot-chat/details.tsx`, `apps/web/features/group-chats/groups.tsx`; create `apps/web/features/library/api.ts`, `library.tsx`; test `apps/web/features/chat/composer.dom.test.tsx`, `apps/web/features/library/library.dom.test.tsx`.
**Interfaces:**
- Consumes: the Task 3 routes; the query pattern of `apps/web/features/bots/api.ts` (`agentPath`, `queryOptions`); `api` and `HttpError` (`apps/web/lib/api.ts:98,58`); uploads and downloads need raw bodies, so add a raw helper beside `api` there; the route pattern of `desktopRoute` (`router.tsx:129`).
- Produces: routes `/bots/$botId/library` and `/groups/$groupId/library`; `safeBlob(bytes: Blob, mimeType: string): Blob`, which keeps the type for the four image types and uses `application/octet-stream` otherwise.

- [x] Write the failing tests: `the composer accepts a pdf and a zip`; `attaching uploads the file and shows it pending until the upload finishes`; `removing drops the file without a DELETE request`; `sending posts the file ids`; `an existing file says "Already in the library"`; `the library lists newest first, downloads, deletes after confirming, and shows "Files you send in this chat appear here."`; `downloading an html file creates an application/octet-stream blob`; `a deleted file shows "File deleted"`.
- [ ] Run `bun test apps/web/features/chat/composer.dom.test.tsx apps/web/features/library/`. Expected: fail.
- [x] Implement. Remove the type check and per-type size limits from the composer (`composer.tsx:79,132`) and check 100 MB on the client. Downloads fetch with the bearer token as `conversation.tsx:159` does, then save through `safeBlob` and an `<a download>`. Previews only for PNG, JPEG, GIF, WebP.
- [x] Run. Expected: pass.
- [x] Checkpoint: commit `feat(web): attach any file and browse the library`.

### Task 10: Docs, glossary, changelog

**Files:** modify `GLOSSARY.md`, `CHANGELOG.md`, `apps/docs/content/concepts/chats.mdx`, `apps/docs/content/reference/api.md`, `apps/docs/content/concepts/discord.md`, `apps/docs/content/self-hosting/backups.md`, `docs/designs/file-library.md`.

- [x] Add to `GLOSSARY.md` after **Transcript**: `**Library**:` / `The files the owner sent in a bot chat or group chat, kept for the owner to browse and for the bot to read. Each bot and each group chat has its own.` / `_Avoid_: Drive, storage, attachments folder`.
- [x] In `chats.mdx`, turn "## Images" (line 49) into "## Files": any type up to 100 MB, what the bot receives, the library, and deleting versus the working context. Keep the vision model text.
- [x] In `discord.md`, state that files sent on Discord don't reach the bot. In `backups.md` "What to Back Up", add `users/<account>/files/`. In `reference/api.md`, document the file routes and the `files` field.
- [x] Add to `CHANGELOG.md` under `## Unreleased`: the file library, and the breaking removal of base64 `attachments`, which stops file sending from the iOS, macOS, and Android clients until they update.
- [x] Run `bun run check` in `apps/docs`, then the root `bun run check`. Expected: both pass.
- [x] Checkpoint: commit `docs: describe the file library`.

## Completion

All ten deliverables are implemented. Task commits: 1 `51d8e0d` (fixture correction `27afe16`), 2 `6b18ae7`, 3 `dc07ab1`, 4 `bf7bb58`, 5 `3d78909`, 6 `03c9778`, 7 `972d462`, 8 `aa60009`, 9 `812f67e`. Integration expectation updates are in `43e866a`; this document and the user-facing documentation form Task 10.

Root checks and strict docs validation pass locally. The final suite has 1,261 passing tests and 118 intentionally skipped tests, with zero failures in 14.06 seconds; the combined root and docs checks took 21 seconds. VM/Railway execution, manual browser verification, Linux PDF execution, and actual CI job duration remain unverified. No push was requested.

Unchecked preimplementation-red-only steps are skipped historical checkpoints, not unfinished implementation. Their failing runs were not captured for Tasks 2, 3, 4, 6, 7, and 9. New behavior is covered by passing tests; specifically observed red-to-green regressions include upload/deletion interruption, extracted-text deduplication, deletion cleanup, dangling-symlink containment, unseen legacy recovery, and failed-download UI feedback.

## Deviations

- Task 5 · additional file: `transcript/origins.ts` · why: a file-upgrade notice needs its own origin, rather than being mislabeled as a credential notice. The original-submission and text-only recovery paths pass faux-provider tests.
- Task 6 · scope lookup: admission decodes the canonical member-turn request ID with `groupTurnScope` · why: the group-turn row is created after submission, so it cannot provide the library scope at admission. Temporary base64 paths retained during Task 4 were removed here.
- Task 7 · interface extension: `libraryExtension` receives the `Library` service; runtime callbacks and `ConversationParts` expose the tool and extension · why: Pi tool execution has no ambient Effect services, and group conversations explicitly select their tools and extensions. Actual bot, group, and coding-job tests verify availability and scope.
- Task 7 · workspace containment also checks non-following metadata and canonical paths · why: review reproduced a dangling symlink escaping `/workspace`. The regression failed before the fix and passes afterward. Dangling symbolic links are refused rather than treated as missing paths; resolved targets must remain inside the workspace.
- Task 8 · `Library.removeLibrary` accepts an optional owner-deletion Effect, run inside its account lock · why: deleting the owner row outside the lock can race with an upload and leave orphaned bytes. Actual bot/group deletion, cross-library retention, and a blocked concurrent upload are covered in `files/library-cleanup.test.ts`.
- Task 9 · additional files: chat delivery and delivery tests, bot-chat entry point, shared and contract limits, transcript response schemas/tests, generated OpenAPI · why: the existing sender serializes uploads in `delivery.ts`, both UI and API use the shared file-size constant, and obsolete wire attachment metadata was removed with its UI consumers.
- Task 9 · failed downloads use a shared mutation with visible errors and refresh cached library/chat queries after 404 · why: review found unhandled rejections. The failed-download DOM regression failed before the fix and passes afterward.
- Task 10 · additional file: `apps/docs/content/concepts/group-chats.md` · why: its image section linked to the replaced `#images` anchor and needed the group-library scope and privacy explanation.
- Verification limitation · one full-suite run intermittently failed the PDF extracted-text test; repeated focused and subsequent full-suite runs passed. The transient cause was not established; no unsupported fix is claimed.

- Task 1 · planned: the next upload replaces leftover temporary files · did: remove crash leftovers when the account's file store initializes, before exposing upload operations · why: random temporary names otherwise leave abandoned bytes indefinitely.
- Task 1 · added: an interruption regression and real bot/group shared-byte integration coverage · why: review found that interrupted deletion could outlive the account lock. The regression fails without uninterruptible deletion and passes with it.
- Task 1 · additional file: `apps/server/src/shared/store.test.ts` · why: two existing upgrade tests roll back a fixed number of migrations. The new migration requires dropping `library_files` and rolling back one additional migration. Both tests failed before this fixture update and pass afterward. Commits: storage `51d8e0d`, fixture correction `27afe16`. Verification: `bun run check` passes (1,216 tests passed, 118 skipped; local unit suite 11.96 seconds). Actual CI job duration remains unverified; no push was requested.
- Task 2 · verification deviation: the preimplementation red test run was not captured. The implemented extraction boundary passes all five tests; no claim is made that those tests failed before implementation. Commit: `6b18ae7`.
- Task 2 · planned: extraction in a Bun worker with enforced `resourceLimits` · did: extraction in a separate Bun process, with a timeout, bounded output, and an RSS watchdog; memory sampling reads `/proc` on Linux and uses `ps` on macOS · why: Bun 1.4.4 ignores worker memory limits. The owner approved proceeding after the process-isolation alternative was explained. RSS monitoring is best effort, not an OS hard memory cap; it cannot guarantee protection against system-wide memory exhaustion. Linux execution is unverified locally because Docker is unavailable.
- Task 4 · additional storage regression: an interrupted upload could release the account lock before its asynchronous cleanup finished. Upload interruption now waits for cancellation and cleanup; text publication is uninterruptible. The regression fails before this fix and passes afterward.
- Task 4 · interface extension: `Library.validate` and `LibraryRepository.deletedName`, plus `deleted_library_files` and a generated migration · why: deleting an entry otherwise discards its name, making the required named deletion error impossible after a restart. Tombstones keep only the scoped ID and name, do not reference bytes, and cascade with their bot or group. `shared/store.test.ts` rollback fixtures were updated for the additional migration. The tombstone test failed before migration generation and passes afterward.
- Task 3 · additional files: `apps/server/src/files/library.test.ts`, `apps/server/src/files/files-api.test.ts`, and `apps/server/test/support/api.ts` · did: keep upload route coverage in a focused suite, expose library injection in the API test helper, and add extracted-text regression tests · why: review found identical bytes uploaded with different MIME types could overwrite a PDF's extracted text. Both regression cases failed before the fix and pass afterward.
- Task 3 · interface extension: `FileStore.putText` and `text` accept an optional `"plain" | "pdf"` extraction format; raw bytes remain deduplicated by hash · why: PDF extraction and UTF-8 source text for identical bytes need separate sidecars. Removing the final reference removes both.
- Task 3 · planned: `Library.layer` depends only on `FileStore` and `LibraryRepository` · did: also depend on `AgentRepository` and `GroupChatRepository` · why: the promised `NotFound` behavior for nonexistent libraries requires checking the owner, including empty libraries.
- Task 3 · additional file: `file-store.ts` · did: initialize the account directory and clear stale temporary files synchronously · why: the existing core store and test helpers build account services with `Effect.runSync`.
- Task 3 · planned: apply Hono `bodyLimit` to every upload · did: use its header fast path only when a Content-Length is present, and enforce streamed length in `Library.upload` · why: the installed middleware buffers requests without Content-Length before invoking a handler.
