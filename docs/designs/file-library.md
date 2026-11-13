# File library: every file in chat, kept per bot chat and group chat

**Status:** implemented. See the [implementation plan](../plans/2026-11-11-file-library.md) for verification and deviations.

PDF extraction uses a separate Bun process with time and output bounds and a best-effort RSS watchdog, not the worker described in the original decisions. A [completion handshake](pdf-extraction-completion-handshake.md) keeps the process alive until the parent validates its result and settles in-flight RSS sampling. Bun 1.4.4 ignores worker memory limits. The watchdog is not an OS hard memory cap and cannot guarantee protection against system-wide memory exhaustion.

Scope of this change: the server and the web client. The iOS, macOS, and Android clients follow in separate changes.

## Problem

The owner can attach only images (PNG, JPEG, GIF, WebP, up to 5 MB) and UTF-8 text files (up to 512 KB) to a message, at most eight per message (`apps/server/src/shared/attachment-rules.ts`). A PDF, a spreadsheet, or an archive is rejected.

Files the owner did send are not kept as files. An image's bytes live inside the transcript entry in the bot's harness database (`users/<account>/agents/<bot>.sqlite`), and a text file is pasted into the message as text (`apps/server/src/shared/attachments.ts`, `prepareAttachments`). Only images can be downloaded again (`apps/server/src/transcript/transcript.ts`, `readAttachment`). Nothing lists what the owner has sent, and a bot can't return to a document from an earlier day except through its working context.

## Solution

The owner can attach any file up to 100 MB in a bot chat or group chat. Every file the owner sends lands in that chat's library: a bot's library for its bot chat, a group library for a group chat. The owner browses, downloads, and deletes library files in the web client.

The bot sees each file in the form it can use. Small text and readable PDF text go into the message, images go to the model as before, and anything else or anything larger appears as a reference with name, type, and size. A library tool lets the bot read any file in the library in parts, search it, and, for a bot with coding, copy it into its workspace.

## Behavior

1. **Sending any file.** The owner attaches a file of any type up to 100 MB in the web composer. The web client uploads it, gets a file ID, and sends the message with that ID. The file appears in the transcript with its name, type, and size, and as a download.
2. **Too large.** A file over 100 MB is refused at upload with a message that names the file and the limit. Nothing is stored.
3. **Removing before sending.** The owner removes an uploaded file from the composer before sending. The file leaves the draft and stays in the library; the composer never deletes library files.
4. **Same file twice.** The owner sends a file whose content is already in the same library. The library keeps one entry and the message refers to it. The bytes are stored once per account, whichever libraries refer to them.
5. **Small text file.** The bot receives the file's text in the message, as text attachments do today.
6. **Large text file.** The bot receives a reference with the name, type, size, and file ID, and a note that it can read the file with the library tool.
7. **PDF.** The server extracts the PDF's text when it is uploaded. Text under the inline limit goes into the message, longer text is a reference, as for text files. If extraction fails or the PDF has no text, such as a scan, the bot gets the reference and a note that no text could be read.
8. **Image.** An image within the model image limit (5 MB) reaches the model as today, including the vision model for bots whose model can't read images. A larger image is a reference only.
9. **Any other format.** The bot gets a reference. A bot with coding can copy the file into its workspace and open it with its own tools.
10. **Reading a library file.** The bot calls the library tool to list files, read a range of a file's text, or search a file's text. In its bot chat it reaches its own library. In a group chat it reaches the group library and its own library, and each file in the tool's results says which library it belongs to.
11. **Copying into the workspace.** A bot with coding calls the library tool to copy a file into its workspace. The file lands at a path the tool reports, and an existing file at that path is replaced. A bot without coding doesn't have this action.
12. **Jobs.** A coding job or desktop job has the library tool for its bot's own library, including the copy action, since both work in the bot's workspace.
13. **Browsing the library.** The owner opens a bot's or group chat's library in the web client and sees the files newest first, with name, type, size, and date. Each file can be downloaded or deleted. An empty library says that files sent in the chat appear there.
14. **Deleting a file.** The owner deletes a library file. It disappears from the library, downloads of it fail, and the transcript shows "File deleted" where the file was. The library tool no longer finds it. What the bot already read stays in its working context until compaction summarizes it, like any earlier message.
15. **Deleting a bot or group chat.** Its library goes with it. Bytes no other library refers to are deleted.
16. **Access.** Only the account that owns a library can upload to it, list it, download from it, or delete from it. A bot can't read another bot's library or a group library it isn't in.
17. **Files sent before this change.** Images in older messages are no longer downloadable, and every older attachment shows as "File deleted". Nothing is migrated. This holds for bot chats and group chats: a group transcript message that still carries base64 attachments shows each as "File deleted", and later group turns don't pass those bytes to member bots.
18. **Messages pending during the upgrade.** An execution accepted before the upgrade without a recorded submission ID can still hold base64 attachments, and it may or may not have reached Pi already. Admission submits it again under its original request ID with the text only and a note to the model that the files didn't survive the update. If Pi had already committed the original, Pi returns that submission, with its files, and the execution continues as normal. If not, the text-only message is delivered, its files show as "File deleted", and the bot chat shows a notice that files sent just before the update must be sent again. Either way no turn runs twice. An execution without attachments is delivered normally.
19. **Deleting a file that a queued message refers to.** A message was accepted but not yet admitted, or a group turn for a member is still queued, when the owner deletes one of its files. The message is delivered anyway: the file shows as "File deleted" and the model gets a note that the owner deleted the file before it arrived. Nothing fails, so nothing needs retrying.
20. **Sending again after a failed send.** A retry with the same request ID and the same file IDs returns the execution that already exists, whatever has happened to the files since. A new send that names a deleted file is refused with "<name> was deleted from the library", like any unknown file ID.
21. **Downloading.** Every file downloads as a file and never opens as a page on Crumble's address, whatever its type or name. Images of the four model image types (PNG, JPEG, GIF, WebP) also show as previews in the transcript and the library. SVG is not previewed.
22. **Older iOS, macOS, and Android clients.** The message route no longer accepts base64 attachments, so sending a file from those clients fails until they move to file IDs. Text messages are unaffected.

## Decisions

- **Every file type, up to 100 MB.** Covers PDFs, office files, archives, and short recordings, and keeps uploads quick on self-hosted servers. 25 MB lost because it is too small for documents with images. 1 GB lost because it needs resumable uploads and much more storage. An admin setting lost for now because one limit is simpler.
- **Only files the owner sends go into the library.** Files bots produce, such as job outputs and desktop downloads, are a later change. Collecting them now would make the first change much larger.
- **A separate group library for each group chat, with its own file IDs.** A group chat's files belong to the group's shared transcript, not to any one member bot.
- **Files are uploaded first and messages refer to file IDs.** Uploads stream instead of travelling as base64 JSON, and the same ID serves the transcript, the library, the download, and the bot's tool.
- **Uploading adds the file to the library at once, and only the owner's explicit delete in the library removes it.** Because duplicates share one entry, an upload can return an entry that earlier messages already refer to; a composer that deleted on remove would break those messages. Rejected: deleting on remove only when the upload created the entry, which still races with a second draft holding the same file; and a pending state with cleanup for unsent uploads, which is more machinery than a stray library file is worth.
- **Downloads are always attachments, served so they can't run as active content.** The server answers every file download with `Content-Disposition: attachment` (the name encoded per RFC 6266), `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: sandbox; default-src 'none'`. The `Content-Type` is the stored type only for PNG, JPEG, GIF, and WebP and `application/octet-stream` for everything else, since the stored type comes from the client. The web client fetches with the bearer token and builds its blob with the same rule, so a blob URL on the app's origin never holds HTML, SVG, or script. The web UI is served from the same origin as the API (`apps/server/src/app/web-ui.ts`), so a file rendered as a page could act as the owner.
- **Downloads revalidate instead of being cached for a year.** `Cache-Control: private, no-cache` with the content hash as `ETag`. A deleted file then stops being served from the browser's cache. The current attachment headers (`apps/server/src/shared/attachments.ts`, `attachmentHeaders`: `max-age=31536000, immutable`) stay only for desktop screenshots.
- **Base64 attachments left over at upgrade are dropped, not migrated, and recovery goes through Pi's request ID.** Pi returns the existing submission for a repeated `requestId` (pi-durable README, submit), which is how admission already recovers a crash between Pi's commit and the host recording the ID (`apps/server/src/bots/bots-admission.ts`). A legacy execution is resubmitted under its request ID with text only: a committed original wins, an uncommitted one becomes a text-only turn. Rejected: failing the execution with "send again", because an execution Pi had already committed would then run twice when the owner resends; delivering the legacy bytes, because that keeps the old attachment path alive; and looking the request up in the transcript first, because Pi has no lookup by request ID and repeating the submission answers the same question. Legacy group transcript attachments display as deleted.
- **Deleting a file never fails accepted work.** A queued message whose file was deleted is delivered with the file marked deleted, and the model is told. Rejected: failing the message, which turns a delete into a lost message and a retry the owner must notice; and blocking the delete while messages are queued, which makes a delete depend on invisible state.
- **Content-hash bytes are removed only under the same per-account lock that creates entries.** Otherwise a delete removing the last entry for a hash can race with an upload of the same content and delete bytes the new entry needs.
- **File IDs are UUIDv7.** They sort by creation time, which matches the newest-first library. This feature is the first to use them; moving every other entity ID is tracked in crumble-project/bot#137. Values that must be unguessable stay UUIDv4 or random bytes.
- **Bytes live on disk in the account's directory, stored by content hash.** `users/<account>/files/` follows the existing layout per account (`apps/server/src/app/data-dir.ts`), so deleting the account removes them (`apps/server/src/app/server.ts`, `removeAccount`). Storing them in SQLite rows lost because large files bloat the database and slow backups. S3-compatible storage is a later option.
- **The bot gets small text inline and a reference for everything else.** Pasting a whole large file in would fill or exceed the working context. The library tool covers what isn't inline, including files from earlier days.
- **The inline text limit is 32 KB of text, about 8,000 tokens.** Enough for most notes and short documents, small enough that a few files don't crowd out the working context.
- **In a group chat, a bot reads the group library and its own library.** The owner chose this so a bot can bring its own documents into group work. Consequence: what the bot quotes from its own library in a group chat becomes visible in the group's shared transcript, to the owner and every member bot.
- **Coding jobs and desktop jobs get the library tool for their bot's own library.** A job asked to work with a file the owner sent, such as converting a PDF, needs to reach it without the owner sending it again.
- **PDF text is extracted on the server, inside the server process, in a worker with a time and memory limit.** pi-ai has only text and image content blocks (`@earendil-works/pi-ai`, `types.d.ts`), so no provider can receive the original PDF. A separate Go service lost because it adds a build, a process, a container, and a protocol for what is a library call. The worker keeps a large or malicious PDF from blocking or crashing the server. The extraction library is a new dependency, picked in the plan.
- **Extraction happens at upload, and its result is stored next to the bytes.** The server must know at send time whether the text goes inline, and the library tool reads the stored text instead of parsing again.
- **Workspace access is a copy, not a mount.** Writing through the workspace's `ExecutionEnv` (`writeFile` and `appendFile` accept bytes) works the same on Microsandbox and Railway. A read-only mount lost for now: Railway has no volumes (`docs/adr/0005-railway-workspaces.md`), content-hash storage gives no folder per bot to mount, and it isn't verified whether files added while a machine runs appear in a bind mount. A read-only mount on Microsandbox can follow.
- **Deleting doesn't reach into the bot's working context.** The harness keeps the model's view of a message, including image bytes and inline text. Removing it there lost as complexity this feature doesn't need.
- **No backward compatibility.** The base64 `attachments` field of the message routes is removed, older attachments aren't migrated, and the old download of message images goes away. Keeping both paths lost because the project doesn't keep code alive for superseded features. The mobile clients break for files until they're updated.

## Interfaces and data

**API contract** (`apps/server/src/contract/api-contract.ts`, `apps/server/src/contract/group-chats.ts`), all breaking, regenerated into `openapi/`:

- New: upload a file to a bot's library and to a group library. The request body is the raw file bytes, streamed, with the file's type in `Content-Type` and its name passed with the request. The response is the file's metadata. The route has its own 100 MB body limit beside the existing ones in `apps/server/src/app/api-requests.ts`.
- New: list a library, newest first and paginated by file ID; download a file; delete a file. For bots and for group chats. Downloads carry the headers in Decisions: attachment disposition, `nosniff`, a sandbox CSP, `Content-Type` limited to the four image types or `application/octet-stream`, and `Cache-Control: private, no-cache` with an `ETag`.
- The upload response says whether the content was already in the library, so the client can tell the owner it's already there.
- Changed: the bot chat and group chat message routes take `files`, a list of file IDs, at most eight per message (`MAX_ATTACHMENTS`), and no longer take `attachments`. A message needs content or at least one file. An unknown file ID, or one from another library, is refused.
- Changed: transcript messages carry each file's ID, name, type, and size, or a deleted marker.
- Removed: the group chat attachment download (`getGroupAttachment`). The bot attachment download (`getAttachment`) stays for desktop screenshots only.

File metadata, as returned by the routes:

```ts
type LibraryFile = {
  id: string; // UUIDv7
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
};
```

**Schema** (store.sqlite, a new table in a new `schema.ts`, migration via `db:generate`): one row per library entry, with the file ID, the owning bot or group chat (cascade on delete), name, type, size, content hash, extraction state, and creation time. One entry per content hash per library.

**Persisted shapes that change:** `executions.attachments` (`apps/server/src/bot-store/schema.executions.ts`) holds a JSON list of file IDs instead of base64 inputs. No migration rewrites old rows. Admission parses the column against the new shape; an old-shape value leads to the text-only resubmission under the original request ID (Behavior 18). Group transcript messages that still have `attachments` with bytes (`apps/server/src/group-chats/group-transcripts.ts`) are read as deleted files and never passed on to member bots (Behavior 17).

**Disk:** `users/<account>/files/` holds the bytes and the extracted text under the content hash. Self-hosters must include it in backups. It lives in the data directory, so `CRUMBLE_DATA_DIR` covers it.

**Bot tool:** a new library tool, with list, read a range, and search actions, plus copy into the workspace for bots with coding. Installed in bot chats, group chat turns, coding jobs, and desktop jobs.

**Limits** (`apps/server/src/shared/limits.ts` or `attachment-rules.ts`): 100 MB per file; 32 KB of inline text; the model image limit stays 5 MB.

## Affected code

- `apps/server/src/files/` (new): the file store on disk, the library repository and schema, PDF extraction in a worker, the HTTP routes, and the library tool. The routes follow `apps/server/src/bots/chat-api.ts` and `apps/server/src/group-chats/group-chats-api.ts`. The repository follows `apps/server/src/memory/memory-repository.ts`. The tool follows `apps/server/src/memory/memory-tool.ts` and the skill tool's on-demand reading (`apps/server/src/skills/skill-library.ts`).
- `apps/server/src/shared/attachment-rules.ts`, `apps/server/src/shared/attachments.ts`: replace base64 inputs with file IDs and decide per file what the model gets: inline text, image, or reference.
- `apps/server/src/bots/bots-submissions.ts`, `bots-admission.ts`, `runtime.ts`, `apps/server/src/bot-store/execution-repository.ts`, `schema.executions.ts`: carry file IDs instead of base64 through submission and admission. The `attachments` column holds IDs, and the idempotency digest covers the IDs.
- `apps/server/src/group-chats/group-chat-post.ts`, `group-turn-input.ts`, `group-transcripts.ts`: the same for group chats; group turns give member bots the group's files.
- `apps/server/src/transcript/transcript.ts`: messages show file metadata or "File deleted"; `readAttachment` keeps only desktop screenshots.
- `apps/server/src/bots/runtime.ts` (where job conversations get their extensions, beside `jobExtensions`), `apps/server/src/jobs/`, `apps/server/src/bot-desktop/`: install the library tool in coding jobs and desktop jobs, scoped to the bot's own library.
- `apps/server/src/bots/bots-lifecycle.ts` (`deleteAgent`) and group chat deletion: remove the library and unreferenced bytes.
- `apps/server/src/app/api-requests.ts`: the upload body limit.
- `apps/server/src/contract/`: the routes and schemas above; `openapi/` regenerated.
- `apps/server/src/bots/bots-admission.ts`: resubmit old-shape executions text-only under their request ID, and post the send-again notice when Pi had not committed them; resolve deleted file IDs to deleted markers with a model note. The same deleted-file rule applies to group turns in `apps/server/src/group-chats/group-turn-input.ts`.
- `apps/web/features/chat/composer.tsx`: accept any file, upload on attach, drop from the draft on remove without deleting, send file IDs.
- `apps/web/features/chat/conversation.tsx`, `transcript.tsx`: fetch downloads with the bearer token and build blobs typed by the safe-type rule; previews only for the four image types.
- `apps/web/features/chat/message-card.tsx`, `transcript.tsx`: show files with download, and "File deleted".
- `apps/web/features/library/` (new): the library view for a bot and a group chat, reached from their pages in `apps/web/features/bots/` and `apps/web/features/group-chats/`.
- `GLOSSARY.md`: add **Library**.
- `apps/docs/content/concepts/chats.mdx`, `apps/docs/content/reference/api.md`, `apps/docs/content/concepts/discord.md`: files in chat and the library; Discord still drops files. A self-hosting page: back up `files/`. `CHANGELOG.md`: the breaking change.

## Testing

- **HTTP API**, in `apps/server/src/app/api.test.ts` and `apps/server/src/group-chats/group-chats-api.test.ts`, modeled on "accepts attachments on messages only, within their limits":
  - upload of any type and refusal above the limit;
  - messages with file IDs, and refusal of unknown or foreign IDs;
  - list, download, delete, and "File deleted" in the transcript;
  - one entry for the same content, and an earlier message still downloads after a duplicate upload;
  - download headers for an HTML file, an SVG file, and a file named to look like a page: attachment disposition, `nosniff`, sandbox CSP, `application/octet-stream`;
  - a download of a deleted file fails even with a matching `If-None-Match`;
  - no access to another account's or another chat's library.
- **Upgrade**, in `apps/server/src/bots/chat.test.ts` with the faux provider: an execution row with base64 attachments whose request Pi already committed continues that submission and starts no second turn; one Pi never saw is delivered text-only with the notice; one without attachments is delivered.
- **Deleted files and accepted work**, same seam: a queued message whose file is deleted before admission is delivered with the deleted marker and the model note; a retry with the same request ID returns the existing execution; a new send naming the deleted file is refused. A group turn queued for a member behaves the same (`apps/server/src/group-chats/group-turns.test.ts`). A group transcript message with legacy attachments shows them as deleted and passes nothing to a member's turn (`apps/server/src/group-chats/group-transcripts.test.ts`).

  The size limit is injected, so no test allocates 100 MB.

- **Bot chat with the faux provider**, in `apps/server/src/bots/chat.test.ts` and `apps/server/src/group-chats/group-turns.test.ts`: what the model receives for small text, text over 32 KB, PDF, image, large image, and other formats; the library tool's list, read, and search; a bot in its bot chat reaches only its own library; a bot in a group chat reaches the group library and its own, not another member's.
- **Workspace copy and jobs**, with a fake environment in the style of `apps/server/src/jobs/coding.test.ts`: the bytes arrive at the reported path, a bot without coding lacks the action, and a coding job reaches its bot's library.
- **PDF extraction**, a unit test against a small PDF in `apps/server/test/fixtures/`: text from a text PDF, nothing from a scan, and a timeout for a pathological file.
- **Web**, DOM tests: the composer accepts any file, uploads, and on remove drops it from the draft without a delete request (`apps/web/features/chat/composer.dom.test.tsx`), and the library view lists, downloads, deletes, and shows its empty state.

## Out of scope

- The iOS, macOS, and Android clients.
- Files bots produce: job outputs, desktop downloads, files a bot writes.
- Shared library files across bots.
- Text extraction beyond plain text and PDF, such as Word, Excel, or OCR.
- A read-only mount of the library into workspaces.
- S3-compatible storage.
- Search, filters, folders, tags, or pinning in the library view; renaming files. Bot search across a library is [library file search](library-file-search.md).
- Discord file transfer.
- Storage quotas per account.
- Moving other entity IDs to UUIDv7 (crumble-project/bot#137).
- Uploading to the library from the library view instead of the chat. (Since shipped in the web library page.)
- Jobs started from a group chat and their access to the group library. Group turns can't start jobs (the job tool is chat-only, `apps/server/src/shared/chat-only.ts`), so this is decided together with group-started jobs.

## Open questions

1. **PDF extraction library.** Which package, checked for Bun support in a worker and for maintenance. Decided in the plan.
2. **Telling a returned original from a new text-only submission (Behavior 18).** Pi returns the existing submission for a repeated request ID even when the content differs (checked against installed pi-durable in review), but exposes no flag saying it did, and a queued submission has no transcript entry yet. The send-again notice must therefore wait until the input entry exists and its metadata shows which one ran: the original carries its old attachment info, the text-only one doesn't. How to wait for that is settled in the plan.

## Implementation obligations

Raised in review; they don't change the design, and the plan must cover each:

- **Bounded tool responses.** The library tool's list, read, and search return bounded output, with continuation, whatever the file or library size.
- **Crash-safe blob publication.** Bytes and extracted text are written to a temporary path and renamed into place before the library entry is committed, so a crash never leaves an entry without bytes or a partial file under a content hash.
- **Safe workspace-copy paths.** The copy action writes only inside `/workspace`. The target is resolved and checked, and file names from uploads are never used as paths unchecked.
- **Verified PDF resource limits.** The time and memory limits of the extraction worker are tested to stop a pathological PDF, not only declared.
