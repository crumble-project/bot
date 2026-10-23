# Document input and editing research

Status: research notes only. This is not an accepted feature specification. Findings concern the installed Pi packages; Crumble-specific findings and a proposed direction were supplied separately by the parent agent. No dependency is selected.

## Findings

Pi's model-message format supports text and image content blocks, not a general file/document block. The installed `@earendil-works/pi-ai` README documents image input as base64 `ImageContent` and says image-capable models can process it; images sent to a model without vision support are silently ignored. The coding-agent docs likewise define user message content as text or image blocks ([pi-ai README, Image Input](../node_modules/@earendil-works/pi-ai/README.md#image-input); [Pi Message Types](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts); [Pi docs, Message Types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/message-types.md)).

The durable harness's built-in `read` tool reads text files and supported images. Its documented image formats are PNG, JPEG, GIF, and WebP; an optional image processor can convert BMP and resize/orient images. PDF, DOCX, and XLSX parsing/conversion are not documented as core input support. `write` and `edit` are file tools; they act through an execution environment. They do not constitute document-format conversion or an end-user upload/download channel ([installed pi-durable README, Tools and Environment](../node_modules/@earendil-works/pi-durable/README.md#tools)).

Actual file editing is supported at the tool level: `CodingTools` exposes `read`, `write`, `edit`, and `bash`. The environment controls which files and processes those tools can access. `NodeExecutionEnv` can provide a working directory; `pi-env` supplies local/remote execution environments, not document parsing or upload transport ([pi-durable README, Tools and Environment](../node_modules/@earendil-works/pi-durable/README.md#environment); [installed pi-env README](../node_modules/@earendil-works/pi-env/README.md)).

Conversion is a separate concern from Pi's transport and model content. A document editor flow would need a conversion/parsing strategy to expose office/PDF contents to the model, and a writer/export strategy to produce a downloadable result. The inspected Pi core sources do not prescribe those strategies or a dependency.

## Crumble integration findings supplied by parent

- `src/attachments.ts` currently accepts images and UTF-8 text, with `MAX_ATTACHMENTS` 8, text limit 512 KiB, image limit 5 MiB, and request limit 32 MiB.
- `src/runtime.ts` lines 693-780 place attachment blocks in `conversation.submit`; attachments are not staged into the workspace.
- `src/coding.ts` uses durable `createCodingTools` (`read`, `write`, `edit`, `bash`) in persistent `/workspace`; the job prompt says it knows nothing else.
- `src/workspace.ts` `Workspaces.env` provides the execution environment. There is no public file-transfer operation.
- `src/api-contract.ts` has no workspace file/download/artifact routes. iOS `../apple/ios/Crumble/Core/Attachments.swift` rejects non-image/non-text files.

These findings are parent-provided and have not been independently re-inspected in this bounded research task.

## Proposed direction from parent, not implemented or accepted

A minimal route is to retain the original upload as a durable upload record, explicitly stage a copy into the bot workspace through the environment, run an existing coding job against that path, and publish the result by authorized file ID/download with a transcript card. Preserve the original and revisions; do not expose arbitrary host paths. Apply upload limits and isolate parsing. Keep document conversion tooling distinct from transport, and do not choose a library before specifying requirements.

The product question remains open: chat-driven editing with preview/download, or an embedded rich editor?

## Primary sources

- Installed `@earendil-works/pi-durable` 1.3.0 package: `node_modules/@earendil-works/pi-durable/README.md`, `dist/tools/read.d.ts`, and `CHANGELOG.md`.
- Installed `@earendil-works/pi-ai`: `node_modules/@earendil-works/pi-ai/README.md`, Image Input section.
- Installed `@earendil-works/pi-env`: `node_modules/@earendil-works/pi-env/README.md`.
- Official Pi docs read in full where referenced: [Message Types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/message-types.md), [How Pi Works](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/how-pi-works.md), [CLI Integration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli-integration.md), [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).
