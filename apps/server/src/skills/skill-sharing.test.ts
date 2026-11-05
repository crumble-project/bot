import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { Store } from "../../test/support/store";
import { agentInput } from "../shared/domain";
import { MAX_BOT_SKILLS } from "../shared/limits";
import { removeSharedSkill, shareWith } from "./skill-sharing";
import { SkillRepository } from "./skill-repository";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "crumble-skill-sharing-"));
  const store = new Store(dir);

  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return store;
};

const skillIds = (count: number) =>
  Array.from({ length: count }, () => crypto.randomUUID());

test("sharing an installed skill stops at a bot's limit and shares with no bot", () => {
  const store = setup();
  const full = skillIds(MAX_BOT_SKILLS);

  const roomy = store.createAgent(agentInput.parse({ name: "Roomy" }));

  const crowded = store.createAgent({
    ...agentInput.parse({ name: "Crowded" }),
    sharedSkills: full,
  });

  const exit = store.runtime.runSync(
    shareWith([roomy.id, crowded.id], skillIds(1)).pipe(Effect.exit),
  );

  expect(Exit.isFailure(exit)).toBeTrue();
  expect(String(exit)).toContain(
    `A bot can use at most ${MAX_BOT_SKILLS} shared skills`,
  );
  expect(store.getAgent(roomy.id)?.sharedSkills ?? []).toEqual([]);
  expect(store.getAgent(crowded.id)?.sharedSkills?.length).toBe(MAX_BOT_SKILLS);
});

test("deleting a shared skill drops it from every bot in one step", () => {
  const store = setup();

  const skill = store.run(
    SkillRepository.use((r) =>
      r.create({
        name: "Shared",
        description: "",
        instructions: "Do it.",
        documents: [],
      }),
    ),
  );

  const agent = store.createAgent({
    ...agentInput.parse({ name: "Ada" }),
    sharedSkills: [skill.id],
  });

  store.runtime.runSync(removeSharedSkill(skill.id));

  expect(store.getAgent(agent.id)?.sharedSkills ?? []).toEqual([]);
  expect(store.run(SkillRepository.use((r) => r.get(skill.id)))).toBeNull();
});
