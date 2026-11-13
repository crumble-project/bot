# Library file search and file descriptions for bots

**Status:** implemented.

Builds on the [file library](file-library.md). Scope: the server only. No web, mobile, or public API change.

## Problem

A bot can't find a library file from what the owner says about it. The owner sends a scan, later asks "what's on my birth certificate?", and the bot has nothing to match that against:

- The library tool's `search` looks inside one file whose ID the bot already knows (`apps/server/src/files/library-tool.ts`). Nothing searches across files.
- `list` returns names newest first, 100 at a time. Names like `IMG_0231.jpg` or `scan_04.pdf` say nothing.
- Photos and scanned PDFs have no extracted text, and a document's text rarely contains the words the owner uses for it ("Geburtsurkunde", or no title at all).
- When a message carries an image or inline text, the model gets the content without the file ID (`apps/server/src/files/message-files.ts`, `modelBlocks`), and a group turn's `[attached: …]` line has names only (`apps/server/src/group-chats/group-turn-input.ts`, `turnInput`). The bot can't refer back to those files.

Files added from the library page without a message (upload or drop in `apps/web/features/library/library.tsx`) make this worse: the bot is never told they exist.

Separately, `list` over two libraries (every group chat turn: group library plus the bot's own) can skip files today. It takes 100 entries from each library, merges them, and continues before the oldest returned ID, so entries of one library that fall between the two pages' ends are never returned.

## Solution

Two server-side additions, with no owner-facing surface:

1. **Search across a library.** The library tool's `list` takes an optional `query` and returns only files whose name, description, or extracted text contains every query word, with a short excerpt where the text matched.
2. **A file description written by bots.** A short, optional description of what a file is, in the words the owner would use ("Lena's birth certificate, issued 1994 in Munich"). Bots write it with a new `describe` action and see it wherever they see the file. The owner's UI never shows it.

Every file a bot receives now states its file ID and, if set, its description, so the bot can describe it and find it again. Listing across several libraries gets a correct continuation cursor.

## Behavior

1. **Receiving a file in a bot chat.** The bot gets each file as today (image, inline text, or reference), and each now also states the file's name and ID. A file with a description shows it. A file without one carries the hint: `No description yet. If the name doesn't say what this file is, describe it with the library tool.` A deleted file states its ID and that it was deleted.
2. **Receiving files in a group turn.** The `[attached: …]` line lists each file as its name and ID, with its description when set. Files left out of the turn's attachments, such as images for a model without image input, are listed the same way. The hint appears once per turn when any listed file has no description.
3. **Describing a file.** The bot calls the library tool with `describe`, a file ID, and a description of up to 300 characters. The description replaces any earlier one; an empty one clears it. The result echoes the file ID, library, and description.
4. **Describing a file it can't reach.** A file ID outside the libraries the bot can reach, or one deleted in the meantime, is refused with the same "File not found in the available libraries" error as `read`.
5. **Group chats.** In a group chat the bot can describe files in the group library and in its own library, the reach it has for reading. A description on a group file is seen by every member bot. When two bots describe the same file, the later write wins.
6. **Jobs.** Coding and desktop jobs can describe files in their bot's own library, as they can read them.
7. **Listing.** `list` results carry each file's description when set. Listing over two libraries returns every file exactly once across continued calls.
8. **Searching.** `list` with `query` scans the reachable libraries newest first and returns the files whose name, description, or extracted text contains every query word, ignoring case. A file matched in its text carries an excerpt: 200 bytes starting at the earliest occurrence of any query word in the text. Results continue with `before` like unfiltered listing. A call can return fewer matches than it scanned, including none, while `before` is still set; the bot keeps calling while `before` is set.
9. **End of search.** When the scan has reached the end of every reachable library, `before` is absent.
10. **Bounded calls.** Each `list` call scans at most one page per library and stops early when reading extracted text passes a byte budget; `before` then points at the last scanned file. The response stays within the tool's output bound; when it would not, it ends at the last file that fits and `before` points there.
11. **Duplicate upload.** Uploading content already in the library returns the existing entry, and its description stays.
12. **Deleting.** Deleting a file deletes its description. Deleting a bot or group chat deletes its files' descriptions with them.
13. **Owner view.** The web library, the files API, and transcript file metadata never include descriptions, and no UI shows them. Descriptions do appear where all bot activity already appears: the `describe` call and `list` results in the bot's tool activity, and the file lines in the raw content blocks of the transcript API, which the web chat doesn't render.
14. **Existing files.** Files uploaded before this change have no description until a bot writes one. Model content already in a conversation keeps the description it had when it was sent.

## Decisions

- **Bots write descriptions, the owner's UI never shows them.** The owner decided this: describing files is the bot's job, and an extra field in the UI is noise. Rejected: an optional field the owner fills in, because owners rarely fill optional fields; showing descriptions on hover, because the owner wants no surface. Consequence: a wrong description is fixed only by telling a bot.
- **No filtering of tool activity or transcript blocks.** Fully removing descriptions from the owner's view would mean stripping `library` tool calls and file lines from the transcript and activity APIs, which also hides real bot activity and is already not done for inline file text or memory writes. Descriptions are not secret from the owner; they're only not a feature the owner sees.
- **Search and descriptions together.** Search over extracted text needs no bot effort but finds nothing for photos, scans, and formats without extraction, and misses when the owner's words aren't in the text. Descriptions cover those cases but depend on bots writing them. Rejected: search only, for those gaps; descriptions only, because text documents would be unfindable until described.
- **Search is a `query` on `list`, not a new action.** The result is a list of files with the same paging, so the model learns one shape. `search` keeps its meaning of searching inside one file.
- **Search scans pages, it doesn't index.** Each call reads one page per reachable library, as `list` does, and checks name, description, and stored text. It needs no new storage. Rejected for now: SQLite FTS5, which needs a virtual table, sync on upload and delete, and copies every extracted text into the store database. It's worth it when libraries are large enough that paging through them is slow.
- **Text is read only when needed, sequentially, under a byte budget.** A file whose name and description already contain every word is a match without reading its text. Text is read one file at a time, and the call stops after 8 MB of text, so a page of large PDFs can't load hundreds of megabytes at once.
- **Every query word must match, across fields, ignoring case.** "birth certificate" finds a description "Birth certificate (Lena)" and a file named `certificate-birth.pdf`. Words are the query split on whitespace after trimming; both sides are compared after Unicode NFC normalization and lowercasing, since macOS uploads can carry NFD names. Rejected: exact phrase matching, which misses reordered words.
- **The cursor is the last scanned file, and multi-library pages are cut at the newest page end.** When a library returned a full page, files older than that page's last ID may exist in it but weren't fetched, so the merged scan stops at the newest such last ID. `before` is the last file scanned, matched or not. This fixes the skipped files of today's unfiltered listing too.
- **Named "description", action `describe`.** "Note" already names three things in this code: the `note` on unreadable references in `message-files.ts`, the `note` key the library tool returns for unreadable files, and workspace notes in the glossary.
- **300 characters, as the tool schema counts them.** Enough for a sentence with a name, date, and type of document. A list page of 200 entries with long descriptions exceeds the 50 KB output bound; that's expected and handled by the byte cut in Behavior 10.
- **Descriptions live on the library entry, not in the bot's memory.** They belong to the file, go away with it, and in a group library are shared by every member. Rejected: memory entries pointing at file IDs, which outlive deleted files and can't be listed per file.
- **Descriptions stay out of transcript file metadata.** Transcript entries record each file's ID, name, type, and size (`apps/server/src/bots/runtime.ts`, `entryMetadata`), which the web renders. The description goes only into the model content, so the UI never shows it and a later change doesn't rewrite stored metadata.
- **The server adds the hint to every file without a description,** including inline text files whose content is searchable anyway. The server can't judge whether a name is descriptive; the bot can, and the hint says so. It costs one sentence per undescribed file per message, once per group turn.
- **A description write is one scoped update.** It updates the entry by ID within the reachable libraries; no row means not found, which also covers a delete racing the write. It doesn't take the file store lock that upload and delete use, since it touches no bytes.
- **Nothing is described automatically at upload.** A model call per upload costs money and time for files that may never be asked about. Can follow if bots don't describe files reliably.

## Interfaces and data

**Schema** (`apps/server/src/files/schema.ts`, `library_files`): a nullable `description` text column. Migration via `db:generate --name`. Existing rows get `NULL`.

**Bot tool** (`library`):
- New action `describe` with `id` and `description` (0 to 300 characters).
- `list` takes an optional `query`. The shared `query` parameter keeps its 2,000-character schema limit for `search`; `list` refuses a query over 200 characters or with no words at runtime.
- `list` results add `description` per file when set and `excerpt` for text matches. `before` follows Behaviors 8 to 10.
- The tool description explains search, continuing while `before` is set, and when to describe a file.

**Model content:** `modelBlocks` states name, ID, and description or hint for every file kind, as a text block next to image blocks. The group turn's attachment line does the same.

**Public API:** unchanged. `publicFile` in `apps/server/src/files/library.ts` keeps returning only ID, name, type, size, and date. `openapi/` doesn't change.

## Affected code

- `apps/server/src/files/schema.ts`: the `description` column, with the generated migration.
- `apps/server/src/files/library-repository.ts`: `LibraryEntry` gains `description`; a method to set or clear it for one entry in one library, scoped like `get` and `remove`.
- `apps/server/src/files/library.ts`: the `Library` service gains setting a description and a bot listing that returns `LibraryEntry` values (with description, hash, and text state) after the same existence check as `list`. `publicFile` and the public `list` are unchanged.
- `apps/server/src/files/library-tool.ts`: the `describe` action; `query` on `list`; the corrected multi-library cursor for filtered and unfiltered listing; descriptions and excerpts in results within `MAX_LIBRARY_OUTPUT_BYTES`.
- `apps/server/src/files/message-files.ts`: `ResolvedFile` content carries the description; `modelBlocks` states ID, name, and description or hint. `MessageFile`, which reaches transcript metadata, stays without it.
- `apps/server/src/group-chats/group-turn-input.ts`: `turnInput` and `turnAttachments` list IDs and descriptions, including omitted images.
- `GLOSSARY.md`: add **File description**, a bot's description of a library file to find it again, not shown to the owner; distinct from workspace notes.
- `apps/docs/content/concepts/chats.mdx`: bots can search a library by name, description, and text, and keep descriptions of files to find them later. Fix the lines saying only references carry a file ID and that the tool searches only within a file.
- `docs/designs/file-library.md`: in Out of scope, mark "Uploading to the library from the library view" as since shipped. The library-view search item stays out of scope; bot search is this design.

## Testing

- **Library tool**, `apps/server/src/files/library-tool.test.ts`:
  - `describe` sets, replaces, and clears a description, and refuses an unreachable file and an over-long description.
  - `list` returns descriptions; over two interleaved libraries it returns every file once across continued calls.
  - `list` with `query` matches name, description, and extracted text, requires every word, ignores case and normalization form, gives the excerpt for text matches, keeps `before` set on a page with no matches, and ends without `before`.
  - A group scope finds and describes group files.
- **Model content**, `apps/server/src/files/message-files.test.ts`: image, inline text, and reference blocks state ID and name; a deleted file states its ID; a described file shows its description; an undescribed one shows the hint.
- **Group turns**, `apps/server/src/group-chats/group-turns.test.ts`: the attachment line carries IDs and descriptions, including an omitted image.
- **Repository**, `apps/server/src/files/library-repository.test.ts`: a description persists, is scoped to its library, and survives a duplicate upload.
- **Public API**, `apps/server/src/files/files-api.test.ts`: listing a library whose file has a description returns no description field.

## Out of scope

- Any owner-facing UI or API for descriptions, and filtering them out of tool activity or transcript blocks.
- Automatic descriptions at upload, OCR, or text extraction for more formats.
- A full-text index (FTS5) or semantic search.
- Search in the owner's library view.
- Searching libraries the bot can't already reach.
- Mobile clients.

## Open questions

None.
