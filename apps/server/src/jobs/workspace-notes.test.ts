import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  WORKSPACE_NOTES_FILE,
  WORKSPACE_NOTES_MAX_BYTES,
  readWorkspaceNotes,
} from "./workspace-notes";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function workspaceWith(notes?: string) {
  const dir = mkdtempSync(join(tmpdir(), "bot-notes-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  if (notes !== undefined)
    await Bun.write(join(dir, WORKSPACE_NOTES_FILE), notes);

  return new NodeExecutionEnv({ cwd: dir });
}

test("a workspace without notes, or with an empty file, has none", async () => {
  expect(
    await readWorkspaceNotes(await workspaceWith(), BACKGROUND_CONTEXT),
  ).toBeUndefined();
  expect(
    await readWorkspaceNotes(await workspaceWith(" \n"), BACKGROUND_CONTEXT),
  ).toBeUndefined();
});

test("notes over the limit are cut at the last whole line, with a marker", async () => {
  const line = "x".repeat(99);
  const lines = Array.from({ length: 50 }, (_, index) => `${index} ${line}`);

  const notes = await readWorkspaceNotes(
    await workspaceWith(lines.join("\n")),
    BACKGROUND_CONTEXT,
  );

  const kept = notes!.split("\n");

  expect(kept.at(-1)).toBe("[Cut: the notes are over 4 KB.]");
  expect(kept.slice(0, -1)).toEqual(lines.slice(0, kept.length - 1));
  expect(Buffer.byteLength(notes!)).toBeLessThan(
    WORKSPACE_NOTES_MAX_BYTES + 64,
  );
});
