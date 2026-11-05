import { z } from "zod";

export const MAX_ATTACHMENTS = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_BYTES = 512 * 1024;

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

export const ATTACHMENT_KINDS = ["image", "text"] as const;

/** What the transcript shows for an attachment; the bytes stay in the model message. */
export type AttachmentInfo = {
  name: string;
  mimeType: string;
  size: number;
  kind: (typeof ATTACHMENT_KINDS)[number];
};

export function attachmentKind(
  mimeType: string,
): AttachmentInfo["kind"] | null {
  if (IMAGE_TYPES.has(mimeType)) return "image";

  if (mimeType.startsWith("text/") || TEXT_TYPES.has(mimeType)) return "text";

  return null;
}
