import { describe, expect, test } from "bun:test";
import { DESCRIPTION_HINT, modelBlocks } from "./message-files";

const textOf = (block: ReturnType<typeof modelBlocks>[number] | undefined) => {
  if (block?.type !== "text") throw new Error("Expected text");

  return block.text;
};

describe("modelBlocks", () => {
  test("renders inline text, references, images and deleted files with their IDs", () => {
    const file = {
      id: "file-id",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 4,
    };

    const blocks = modelBlocks([
      { file, description: null, content: { kind: "text", text: "note" } },
      { file, description: null, content: { kind: "reference" } },
      {
        file: { ...file, id: "image-id", mimeType: "image/png" },
        description: null,
        content: { kind: "image", data: "YWJj" },
      },
      { file: { id: "deleted-id", deleted: true } },
    ]);

    const inline = textOf(blocks[0]);

    expect(inline).toContain("note");
    expect(inline).toContain("file-id");

    const reference = textOf(blocks[1]);

    expect(reference).toContain("file-id");
    expect(reference).toContain("library");
    expect(textOf(blocks[2])).toContain("image-id");
    expect(blocks[3]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "YWJj",
    });

    const deleted = textOf(blocks[4]);

    expect(deleted).toContain("deleted");
    expect(deleted).toContain("deleted-id");
  });

  test("shows a description, or the hint when a file has none", () => {
    const file = {
      id: "file-id",
      name: "IMG_0231.jpg",
      mimeType: "application/zip",
      size: 4,
    };

    const [described, undescribed] = modelBlocks([
      {
        file,
        description: "Lena's birth certificate",
        content: { kind: "reference" },
      },
      { file, description: null, content: { kind: "reference" } },
    ]);

    expect(textOf(described)).toContain('"Lena\'s birth certificate"');
    expect(textOf(described)).not.toContain(DESCRIPTION_HINT);
    expect(textOf(undescribed)).toContain(DESCRIPTION_HINT);
  });
});
