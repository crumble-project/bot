import { expect, test } from "bun:test";
import { UploadChips, toUploads } from "./composer";

test("image previews reuse attachment data without an object URL", async () => {
  const { uploads } = await toUploads([
    new File(["image"], "image.png", { type: "image/png" }),
  ]);

  expect(uploads[0]?.preview).toBe(`data:image/png;base64,${uploads[0]?.data}`);
});

test("attachment keys follow each upload after an earlier removal", async () => {
  const file = () => new File(["same"], "same.txt", { type: "text/plain" });
  const { uploads } = await toUploads([file(), file(), file()]);
  const chips = UploadChips({ uploads, onRemove: () => {} });

  const remaining = UploadChips({
    uploads: uploads.slice(1),
    onRemove: () => {},
  });

  expect(chips).not.toBeNull();
  expect(remaining).not.toBeNull();

  if (!chips || !remaining) throw new Error("Expected attachment chips");

  const before = chips.props.children;
  const after = remaining.props.children;

  expect(new Set(before.map((chip: { key: string }) => chip.key)).size).toBe(3);
  expect(after.map((chip: { key: string }) => chip.key)).toEqual(
    before.slice(1).map((chip: { key: string }) => chip.key),
  );
});
