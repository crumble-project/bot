import { createHash } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { z } from "zod";
import { AppError } from "./domain";

export const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;

/** Base64 of the largest allowed attachment set, plus room for the rest of the JSON body. */
export const MAX_MESSAGE_BODY = 32 * 1024 * 1024;

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/sql",
]);

export const attachmentInput = z.object({
  name: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().toLowerCase().min(1).max(100),
  data: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, "Attachment data must be base64"),
});

export type AttachmentInput = z.infer<typeof attachmentInput>;

/** What the transcript shows for an attachment; the bytes stay in the model message. */
export type AttachmentInfo = {
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "text";
};

export function attachmentKind(
  mimeType: string,
): AttachmentInfo["kind"] | null {
  if (IMAGE_TYPES.has(mimeType)) return "image";

  if (mimeType.startsWith("text/") || TEXT_TYPES.has(mimeType)) return "text";

  return null;
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
      throw new AppError(
        400,
        `${item.name}: only images (PNG, JPEG, GIF, WebP) and text files can be attached`,
      );
    const bytes = Buffer.from(item.data, "base64");
    const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;

    if (bytes.length > limit)
      throw new AppError(
        400,
        `${item.name} is larger than ${limit / 1024 / 1024 >= 1 ? `${limit / 1024 / 1024} MB` : `${limit / 1024} KB`}`,
      );

    if (kind === "image") {
      blocks.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else {
      let text: string;

      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new AppError(400, `${item.name} is not UTF-8 text`);
      }

      blocks.push({
        type: "text",
        text: `<attachment name=${JSON.stringify(item.name)}>\n${text}\n</attachment>`,
      });
    }

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
export function attachmentDigest(items: AttachmentInput[]): string | null {
  if (!items.length) return null;
  const hash = createHash("sha256");

  for (const item of items)
    hash.update(`${item.name}\0${item.mimeType}\0${item.data}\0`);

  return hash.digest("hex");
}
