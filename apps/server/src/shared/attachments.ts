import { createHash } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  attachmentKind,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  type AttachmentInfo,
  type AttachmentInput,
} from "./attachment-rules";
import { Effect } from "effect";
import { appErrors } from "./app-errors";
import { InvalidInput } from "./errors";

function attachmentBytes(item: AttachmentInput, kind: AttachmentInfo["kind"]) {
  const bytes = Buffer.from(item.data, "base64");
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;

  if (bytes.length > limit)
    throw new InvalidInput({
      message: `${item.name} is larger than ${limit / 1024 / 1024 >= 1 ? `${limit / 1024 / 1024} MB` : `${limit / 1024} KB`}`,
    });

  return bytes;
}

function decodeText(item: AttachmentInput, bytes: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidInput({ message: `${item.name} is not UTF-8 text` });
  }
}

function attachmentBlock(
  item: AttachmentInput,
  bytes: Buffer,
  kind: AttachmentInfo["kind"],
): TextContent | ImageContent {
  if (kind === "image")
    return { type: "image", data: item.data, mimeType: item.mimeType };

  return {
    type: "text",
    text: `<attachment name=${JSON.stringify(item.name)}>\n${decodeText(item, bytes)}\n</attachment>`,
  };
}

/**
 * Turns uploads into model content: images as image blocks, text files as named text blocks.
 * Rejects types the models cannot read, oversized files, and text that is not UTF-8.
 */
export function prepareAttachments(items: AttachmentInput[]) {
  const blocks: (TextContent | ImageContent)[] = [];
  const info: AttachmentInfo[] = [];

  for (const item of items) {
    const kind = attachmentKind(item.mimeType);

    if (!kind)
      throw new InvalidInput({
        message: `${item.name}: only images (PNG, JPEG, GIF, WebP) and text files can be attached`,
      });

    const bytes = attachmentBytes(item, kind);

    blocks.push(attachmentBlock(item, bytes, kind));
    info.push({
      name: item.name,
      mimeType: item.mimeType,
      size: bytes.length,
      kind,
    });
  }

  return { blocks, info };
}

/** Identifies an attachment set, so a retried request ID can be checked without keeping the bytes. */
/** Validates attachments before anything is stored, so a bad file never leaves a message or an execution behind. */
export const validAttachments = (attachments: AttachmentInput[]) =>
  appErrors(
    Effect.try({
      try: () => prepareAttachments(attachments),
      catch: (error) => error,
    }),
  );

export function attachmentDigest(items: AttachmentInput[]): string | null {
  if (!items.length) return null;
  const hash = createHash("sha256");

  for (const item of items)
    hash.update(`${item.name}\0${item.mimeType}\0${item.data}\0`);

  return hash.digest("hex");
}

/** How an attachment is served: its bytes never change, so clients may keep them. */
export const attachmentHeaders = (mimeType: string) => ({
  "Content-Type": mimeType,
  "Cache-Control": "private, max-age=31536000, immutable",
});
