import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCommonSkills } from "./common-skills";

test("loads frontmatter and body skills in deterministic directory order", async () => {
  const root = mkdtempSync(join(tmpdir(), "crumble-common-skills-"));

  try {
    for (const name of ["z-last", "a-first"]) mkdirSync(join(root, name));
    await Bun.write(join(root, "z-last", "SKILL.md"), "Body only");
    await Bun.write(
      join(root, "a-first", "SKILL.md"),
      "---\nname: First\ndescription: Desc\n---\nInstructions",
    );
    expect(loadCommonSkills(root).map((skill) => skill.name)).toEqual([
      "First",
      "z-last",
    ]);
    expect(loadCommonSkills(root)[0]).toMatchObject({
      id: "common:a-first/SKILL.md",
      instructions: "Instructions",
      path: "a-first/SKILL.md",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed or empty skill documents and tolerates an empty catalog", async () => {
  const root = mkdtempSync(join(tmpdir(), "crumble-common-skills-"));

  try {
    expect(loadCommonSkills(join(root, "missing"))).toEqual([]);
    mkdirSync(join(root, "empty"));
    await Bun.write(join(root, "empty", "SKILL.md"), "---\nname: Empty\n---\n");
    expect(() => loadCommonSkills(root)).toThrow("no instructions");
    await Bun.write(join(root, "empty", "SKILL.md"), "---\nname: Empty\n");
    expect(() => loadCommonSkills(root)).toThrow(
      "Invalid common skill frontmatter",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
