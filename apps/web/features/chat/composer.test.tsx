import { expect, test } from "bun:test";
import { toUploads } from "./composer";

test("image previews reuse attachment data without an object URL", async () => {
  const { uploads } = await toUploads([
    new File(["image"], "image.png", { type: "image/png" }),
  ]);

  expect(uploads[0]?.preview).toBe("data:image/png;base64,aW1hZ2U=");
});
