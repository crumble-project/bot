import { describe, expect, test } from "bun:test";
import { modelBlocks } from "./message-files";

describe("modelBlocks", () => {
  test("renders inline text, references, images and deleted files", () => {
    const file = {
      id: "file-id",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 4,
    };

    const blocks = modelBlocks([
      { file, content: { kind: "text", text: "note" } },
      { file, content: { kind: "reference" } },
      {
        file: { ...file, mimeType: "image/png" },
        content: { kind: "image", data: "YWJj" },
      },
      { file: { id: "deleted-id", deleted: true } },
    ]);

    const inline = blocks[0];

    if (inline?.type !== "text") throw new Error("Expected text");

    expect(inline.text).toContain("note");
    expect(blocks[1]?.type).toBe("text");
    const reference = blocks[1];

    if (reference?.type !== "text") throw new Error("Expected text");

    expect(reference.text).toContain("file-id");
    expect(reference.text).toContain("library");
    expect(blocks[2]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "YWJj",
    });
    const deleted = blocks[3];

    if (deleted?.type !== "text") throw new Error("Expected text");

    expect(deleted.text).toContain("deleted");
  });
});
