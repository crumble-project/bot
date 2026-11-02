import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import type { Bot } from "@/lib/api";
import { applyBulkAction, type SelectableSkill } from "./bulk-skill-actions";

const bot = (id: string, name = id): Bot => ({
  id,
  name,
  avatar: "",
  description: "",
  instructions: "",
  provider: "openai",
  model: "test",
  enabled: true,
  tools: [],
  skills: [],
  mcpServers: [],
  delegates: [],
  createdAt: "",
  updatedAt: "",
});

const skill: SelectableSkill = {
  id: "skill",
  name: "Review",
  instructions: "Read it",
  botId: "source",
  ownerName: "Source",
  installed: false,
};

test("assignments make bounded progress across independent bots and observe every outcome", async () => {
  const bots = ["a", "b", "c", "d", "e"].map((id) => bot(id));
  const gates = bots.map(() => Promise.withResolvers<Response>());
  const fifthStarted = Promise.withResolvers<void>();
  const started: string[] = [];
  let active = 0;
  let peak = 0;

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        const body: { botId: string; assigned: boolean } = JSON.parse(
          z.string().parse(init?.body),
        );

        const index = bots.findIndex((each) => each.id === body.botId);
        expect(body.assigned).toBe(true);
        started.push(body.botId);
        active++;
        peak = Math.max(peak, active);

        if (body.botId === "e") fifthStarted.resolve();

        return gates[index]!.promise.finally(() => {
          active--;
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const pending = applyBulkAction("assign", [skill], bots);

  try {
    // All first four requests start synchronously at the fetch seam. None may
    // settle until this test releases its gate: no timing or network dependency.
    expect(started).toEqual(["a", "b", "c", "d"]);
    gates[1]!.resolve(Response.json({ error: "Denied" }, { status: 500 }));
    await fifthStarted.promise;
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
    expect(active).toBe(4);
    gates[2]!.resolve(Response.json({ skipped: true }));

    for (const gate of gates) gate.resolve(Response.json({ skipped: false }));
    const result = await pending;
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(result.failed).toEqual(new Set([skill.id]));
    expect(result.messages).toEqual([
      {
        id: "summary",
        text: "0 of 1 skills processed; 1 failed and remain selected.",
      },
      { id: "failed:skill:b", text: "Failed Review (Source) → b: Denied" },
      {
        id: "skipped:skill:c",
        text: "Skipped Review (Source) → c: already in the requested state.",
      },
    ]);
  } finally {
    for (const gate of gates) gate.resolve(Response.json({ skipped: false }));
    await pending;
    fetch.mockRestore();
  }
});

test("same-name outcomes have distinct stable identities, including after target reordering", async () => {
  const bots = [bot("a", "Duplicate"), bot("b", "Duplicate")];

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(() => Promise.resolve(Response.json({ skipped: true })), {
      preconnect: globalThis.fetch.preconnect,
    }),
  );

  try {
    const first = await applyBulkAction("remove", [skill], bots);

    const reordered = await applyBulkAction(
      "remove",
      [skill],
      bots.toReversed(),
    );

    const a = {
      id: "skipped:skill:a",
      text: "Skipped Review (Source) → Duplicate: already in the requested state.",
    };

    const b = { ...a, id: "skipped:skill:b" };
    expect(first.messages.slice(1)).toEqual([a, b]);
    expect(reordered.messages.slice(1)).toEqual([b, a]);
  } finally {
    fetch.mockRestore();
  }
});

test("skills run in order even when the first skill has a per-bot failure", async () => {
  const bots = [bot("a"), bot("b")];
  const gates = bots.map(() => Promise.withResolvers<Response>());
  const nextSkillStarted = Promise.withResolvers<void>();
  const started: string[] = [];
  let completed = 0;

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const body: { botId: string } = JSON.parse(
          z.string().parse(init?.body),
        );

        const path = input instanceof Request ? input.url : input.toString();
        started.push(`${path}:${body.botId}`);

        if (path === "/v1/skills/skill/assignment") {
          const index = bots.findIndex((each) => each.id === body.botId);

          return gates[index]!.promise.then((response) => {
            completed++;

            return response;
          });
        }

        expect(completed).toBe(2);
        nextSkillStarted.resolve();

        return Promise.resolve(Response.json({ skipped: false }));
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const pending = applyBulkAction(
    "assign",
    [skill, { ...skill, id: "second" }],
    bots,
  );

  try {
    expect(started).toEqual([
      "/v1/skills/skill/assignment:a",
      "/v1/skills/skill/assignment:b",
    ]);
    gates[0]!.resolve(Response.json({ error: "Denied" }, { status: 500 }));
    gates[1]!.resolve(Response.json({ skipped: false }));
    await nextSkillStarted.promise;
    const result = await pending;
    expect(result.failed).toEqual(new Set([skill.id]));
    expect(started).toEqual([
      "/v1/skills/skill/assignment:a",
      "/v1/skills/skill/assignment:b",
      "/v1/skills/second/assignment:a",
      "/v1/skills/second/assignment:b",
    ]);
  } finally {
    for (const gate of gates) gate.resolve(Response.json({ skipped: false }));
    await pending;
    fetch.mockRestore();
  }
});
