import { createHash } from "node:crypto";

export function fileIdDigest(ids: readonly string[]): string | null {
  if (!ids.length) return null;

  return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

export const attachmentHeaders = (mimeType: string) => ({
  "Content-Type": mimeType,
  "Cache-Control": "private, max-age=31536000, immutable",
});
