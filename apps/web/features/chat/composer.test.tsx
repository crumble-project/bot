import { expect, test } from "bun:test";
import { safeBlob } from "@/features/library/api";

test("safe blobs preserve only supported image types", () => {
  const bytes = new Blob(["<script>bad()</script>"], { type: "text/html" });
  expect(safeBlob(bytes, "text/html").type).toBe("application/octet-stream");
  expect(safeBlob(bytes, "image/png").type).toBe("image/png");
});
