import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { JsonValue } from "@earendil-works/chord";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { AgentRuntime } from "../src/runtime";
import { providerModels } from "../src/providers";
import { ProviderCredentials } from "../src/provider-credentials";
import { Store } from "../src/store";
import { loadCommonSkills } from "../src/common-skills";
import { agentInput, type Agent } from "../src/domain";
import type { AvailableSkill, SkillLibrary } from "../src/skill-library";
import { skillLibrary } from "../src/skills";

const directories: string[] = [];
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));

  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const makeAgent = (): Agent => ({
  ...agentInput
    .omit({ desktopModel: true, reviewModel: true })
    .parse({ name: "Test" }),
  id: crypto.randomUUID(),
  // SAFETY: The faux provider is registered in the test model registry.
  provider: "faux" as never,
  model: "test",
  createdAt: "",
  updatedAt: "",
});

/** A read-only library for prompt tests; writes are exercised against the real one. */
function fakeLibrary(
  available: (agent: Agent) => AvailableSkill[],
  used: (skill: AvailableSkill) => void = () => {},
): SkillLibrary {
  const unsupported = () => {
    throw new Error("read-only library");
  };

  return {
    available,
    used: (_agent, skill) => used(skill),
    own: () => [],
    create: unsupported,
    update: unsupported,
    remove: unsupported,
    transaction: (fn) => fn(),
  };
}

function setup(
  options: ConstructorParameters<typeof AgentRuntime>[1] = {},
  slow = false,
) {
  const directory = mkdtempSync(join(tmpdir(), "crumble-runtime-"));
  directories.push(directory);

  const fauxOptions = {
    provider: "faux",
    models: [{ id: "test" }],
  };

  if (slow) {
    Object.assign(fauxOptions, {
      tokensPerSecond: 60,
      tokenSize: { min: 1, max: 1 },
    });
  }

  const faux = fauxProvider(fauxOptions);

  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new AgentRuntime(directory, { ...options, models });
  runtimes.push(runtime);

  return { runtime, faux };
}

test("saved credentials rotate without opening a new runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crumble-credentials-"));
  directories.push(directory);
  const credentials = new ProviderCredentials(new Store(directory));
  const models = providerModels(credentials);

  for (const key of ["first-test-key", "second-test-key"]) {
    await credentials.modify("openai", async () => ({ type: "api_key", key }));
    expect((await models.getAuth("openai"))?.auth.apiKey).toBe(key);
  }
});

test("each chat turn receives a fresh server clock and timezone", async () => {
  const { runtime, faux } = setup();
  const agent = makeAgent();
  const conversation = await runtime.createConversation(agent);
  const requests: string[] = [];

  const capture = (context: { messages: unknown[] }) => {
    requests.push(JSON.stringify(context.messages));

    return fauxAssistantMessage("ok");
  };

  faux.setResponses([capture, capture]);
  const boundaries: [number, number][] = [];

  for (const requestId of ["one", "two"]) {
    const earliest = Date.now();

    const result = await runtime.wait(
      await runtime.submit(agent, conversation, "What time is it?", requestId),
      agent,
    );

    expect(result.status).toBe("done");
    boundaries.push([earliest, Date.now()]);
    await Bun.sleep(5);
  }

  expect(requests).toHaveLength(2);

  for (const [index, prompt] of requests.entries()) {
    const times = [
      ...prompt.matchAll(/Current server time \(UTC\): ([\dT:.Z-]+)/g),
    ];

    expect(times.length).toBeGreaterThan(0);
    const timestamp = Date.parse(times.at(-1)![1]!);
    expect(timestamp).toBeGreaterThanOrEqual(boundaries[index]![0]);
    expect(timestamp).toBeLessThanOrEqual(boundaries[index]![1]);
    expect(prompt).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }
});

test("profile edits, skills and memory reach the next request without leaking between agents", async () => {
  const requests: string[] = [];

  const { runtime, faux } = setup({
    listMemory: (id) => [{ id: "memory", content: `private:${id}` }],
    skillLibrary: fakeLibrary((agent) =>
      agent.skills.map((skill) => ({
        id: skill.name,
        name: skill.name,
        description: "",
        instructions: skill.instructions,
        documents: [],
        scope: "own" as const,
      })),
    ),
  });

  const a = makeAgent(),
    b = makeAgent();

  const response = (context: { messages: unknown[] }) => {
    requests.push(JSON.stringify(context));

    return fauxAssistantMessage("ok");
  };

  faux.setResponses([response, response, response]);

  const ca = await runtime.createConversation(a),
    cb = await runtime.createConversation(b);

  await runtime.wait(await runtime.submit(a, ca, "first", "one"), a);
  await runtime.wait(
    await runtime.submit(
      {
        ...a,
        instructions: "New personality",
        skills: [{ name: "Research", instructions: "Check primary sources" }],
      },
      ca,
      "second",
      "two",
    ),
    a,
  );
  await runtime.wait(await runtime.submit(b, cb, "third", "three"), b);
  expect(requests[1]).toContain("New personality");
  expect(requests[1]).toContain("- Research: Check primary sources");
  expect(requests[1]).toContain(`private:${a.id}`);
  expect(requests[2]).toContain(`private:${b.id}`);
  expect(requests[2]).not.toContain(`private:${a.id}`);
  await expect(runtime.snapshot(b, ca)).rejects.toThrow();
});

test("lists skills by name in the prompt and loads their content and documents on demand", async () => {
  const skillsRoot = mkdtempSync(join(tmpdir(), "crumble-skills-"));
  directories.push(skillsRoot);
  const taskDir = join(skillsRoot, "tasks");
  mkdirSync(join(taskDir, "references"), { recursive: true });
  await Bun.write(
    join(taskDir, "SKILL.md"),
    "---\nname: Tasks\ndescription: Handle tasks\n---\nCommon task rules",
  );
  await Bun.write(join(taskDir, "references", "cron.md"), "Cron depth");
  const common = loadCommonSkills(skillsRoot);
  expect(common).toHaveLength(1);
  expect(common[0]).toMatchObject({
    id: "common:tasks/SKILL.md",
    name: "Tasks",
    description: "Handle tasks",
    instructions: "Common task rules",
    documents: [{ path: "references/cron.md", content: "Cron depth" }],
  });
  const requests: string[] = [];
  const used: string[] = [];

  const { runtime, faux } = setup({
    skillLibrary: fakeLibrary(
      () => [
        ...common.map((skill) => ({
          ...skill,
          description: skill.description ?? "",
          scope: "default" as const,
        })),
        {
          id: "shared",
          name: "Shared",
          description: "",
          instructions: "Shared rules\nMore shared rules",
          documents: [],
          scope: "shared" as const,
        },
        {
          id: "own",
          name: "Tasks",
          description: "The bot's own task rules",
          instructions: "Own task rules",
          documents: [],
          scope: "own" as const,
        },
      ],
      (skill) => {
        used.push(`${skill.scope}:${skill.name}`);
      },
    ),
  });

  const agent = makeAgent();

  faux.setResponses([
    (context) => {
      requests.push(JSON.stringify(context));

      return fauxAssistantMessage(
        [
          fauxToolCall("skill", { action: "view", name: "tasks" }),
          fauxToolCall("skill", {
            action: "view",
            name: "Tasks",
            path: "references/cron.md",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("ok"),
  ]);
  const conversation = await runtime.createConversation(agent);
  await runtime.wait(
    await runtime.submit(agent, conversation, "go", "one"),
    agent,
  );
  const prompt = requests[0] ?? "";
  expect(prompt).toContain("- Tasks: The bot's own task rules");
  expect(prompt).toContain("- Shared: Shared rules");
  expect(prompt).not.toContain("Common task rules");
  expect(prompt).not.toContain("Own task rules");
  expect(prompt).not.toContain("More shared rules");
  expect(prompt).toContain('"name":"skill"');

  const transcript = JSON.stringify(
    (await runtime.snapshot(agent, conversation)).messages,
  );

  expect(transcript).toContain("Own task rules");
  expect(transcript).not.toContain("Common task rules");
  expect(transcript).toContain(
    "Skill Tasks has no document references/cron.md",
  );
  expect(used).toEqual(["own:Tasks"]);
});

test("a bot writes its own skills atomically, after reading them, and every change is recorded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crumble-skill-store-"));
  directories.push(directory);
  const store = new Store(directory);

  const stored = store.createAgent({
    ...agentInput.parse({ name: "Learner" }),
    skills: [{ name: "Research", instructions: "Check sources" }],
  });

  const { runtime, faux } = setup({
    currentAgent: () => stored,
    skillLibrary: skillLibrary(store, []),
  });

  // SAFETY: The faux provider is registered in the test model registry.
  const agent = { ...stored, provider: "faux" as never, model: "test" };
  const results: string[] = [];

  const call = (operations: JsonValue[]) =>
    fauxAssistantMessage([fauxToolCall("skill_manage", { operations })], {
      stopReason: "toolUse",
    });

  faux.setResponses([
    () =>
      call([
        {
          action: "patch",
          name: "Research",
          oldString: "Check sources",
          newString: "Check primary sources",
        },
      ]),
    (context) => {
      results.push(JSON.stringify(context.messages.at(-1)));

      return fauxAssistantMessage(
        [fauxToolCall("skill", { action: "view", name: "research" })],
        { stopReason: "toolUse" },
      );
    },
    () =>
      call([
        {
          action: "patch",
          name: "Research",
          oldString: "Check sources",
          newString: "Check primary sources",
        },
        {
          action: "write_document",
          name: "Research",
          path: "references/sources.md",
          content: "Prefer primary sources",
        },
        {
          action: "create",
          name: "Writing",
          instructions: "Short sentences",
        },
      ]),
    (context) => {
      results.push(JSON.stringify(context.messages.at(-1)));

      return call([
        {
          action: "patch",
          name: "Writing",
          oldString: "Short",
          newString: "Shorter",
        },
        { action: "delete", name: "Missing" },
      ]);
    },
    (context) => {
      results.push(JSON.stringify(context.messages.at(-1)));

      return call([
        { action: "create", name: " research ", instructions: "Twice" },
      ]);
    },
    (context) => {
      results.push(JSON.stringify(context.messages.at(-1)));

      return fauxAssistantMessage("done");
    },
  ]);
  const conversation = await runtime.createConversation(agent);
  await runtime.wait(
    await runtime.submit(agent, conversation, "learn", "one"),
    agent,
  );
  expect(results[0]).toContain("before changing it");

  // SAFETY: the tool result's text is the JSON the skill_manage tool wrote.
  const batch = JSON.parse(JSON.parse(results[1]!).content[0].text) as {
    applied: unknown[];
    findings: Array<{ rule: string }>;
  };

  expect(batch.applied).toEqual([
    { action: "patch", name: "Research" },
    {
      action: "write_document",
      name: "Research",
      path: "references/sources.md",
    },
    { action: "create", name: "Writing" },
  ]);
  expect(batch.findings.map((finding) => finding.rule)).toEqual([
    "missing-description",
    "missing-description",
  ]);
  expect(results[2]).toContain("no skill named");
  expect(results[3]).toContain("already have a skill named");

  const skills = store.listSkills(stored.id);
  expect(skills.map((skill) => skill.name)).toEqual(["Research", "Writing"]);
  expect(skills[0]).toMatchObject({
    instructions: "Check primary sources",
    documents: [
      { path: "references/sources.md", content: "Prefer primary sources" },
    ],
    useCount: 1,
  });
  // The failed batch rolled back the patch to Writing.
  expect(skills[1]).toMatchObject({
    instructions: "Short sentences",
    createdBy: "bot",
  });

  const changes = store.listChanges(stored.id);
  expect(changes.map((change) => `${change.actor}:${change.action}`)).toEqual([
    "bot:create",
    "bot:update",
    "bot:update",
    "owner:create",
  ]);
  expect(changes[0]!.source?.executionId).toBeNull();
  expect(changes[1]!.before).toMatchObject({ documents: [] });
  store.close();
});

test("a bot without skills gets no skill tool", async () => {
  const { runtime, faux } = setup({ skillLibrary: fakeLibrary(() => []) });
  const agent = makeAgent();
  const requests: string[] = [];

  faux.setResponses([
    (context) => {
      requests.push(JSON.stringify(context));

      return fauxAssistantMessage("ok");
    },
  ]);
  const conversation = await runtime.createConversation(agent);
  await runtime.wait(
    await runtime.submit(agent, conversation, "go", "one"),
    agent,
  );
  expect(requests[0]).not.toContain('"name":"skill"');
  expect(requests[0]).not.toContain("Skills:");
});

test("registered extension tools are offered, executed, recorded and revoked", async () => {
  let enabled = true,
    calls = 0;

  const tool = defineTool({
    name: "example",
    description: "Read example",
    parameters: Type.Object({}),
    execute: async () => {
      calls++;

      return { output: [{ type: "text", text: "tool result" }] };
    },
  });

  const extension = defineExtension({ name: "example", tools: [tool] });

  const { runtime, faux } = setup({
    extensions: () => (enabled ? [extension] : []),
  });

  const a = makeAgent();
  const conversation = await runtime.createConversation(a);
  faux.setResponses([
    (context) => {
      expect(JSON.stringify(context.messages)).toContain('"name":"example"');

      return fauxAssistantMessage(fauxToolCall("example", {}), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("finished"),
    (context) => {
      expect(JSON.stringify(context.messages.at(-2))).toContain("toolsRemoved");

      return fauxAssistantMessage("revoked");
    },
  ]);

  const settled = await runtime.wait(
    await runtime.submit(a, conversation, "use tool", "first"),
    a,
  );

  expect(settled.status).toBe("done");
  expect(calls).toBe(1);
  expect(
    JSON.stringify((await runtime.snapshot(a, conversation)).messages),
  ).toContain("tool result");
  enabled = false;
  await runtime.wait(
    await runtime.submit(a, conversation, "next", "second"),
    a,
  );
});

test("hides in-flight assistant text and cancellation settles the submission", async () => {
  const { runtime, faux } = setup({}, true);
  const a = makeAgent();
  const conversation = await runtime.createConversation(a);
  faux.setResponses([
    fauxAssistantMessage(
      "A deliberately long response that can be cancelled before it finishes.",
    ),
  ]);
  const snapshots: Awaited<ReturnType<typeof runtime.snapshot>>[] = [];

  const stop = await runtime.watch(a, conversation, (snapshot) => {
    snapshots.push(snapshot);
  });

  const submission = await runtime.submit(a, conversation, "go", "cancel-test");
  await Bun.sleep(180);
  const running = await runtime.snapshot(a, conversation);
  expect(running.status).toBe("running");
  expect(running.partial).toBe("");
  expect(JSON.stringify(running.live)).not.toContain(
    "A deliberately long response",
  );
  await runtime.abort(a, conversation);
  const settled = await runtime.wait(submission, a);
  expect(settled.status).not.toBe("done");
  const cancelled = await runtime.snapshot(a, conversation);
  expect(cancelled.status).toBe("idle");
  expect(
    cancelled.messages.some((message) =>
      message.content.includes("A deliberately long response"),
    ),
  ).toBe(false);
  expect(
    (await runtime.history(a)).messages.some((message) =>
      message.content.includes("A deliberately long response"),
    ),
  ).toBe(false);
  expect(snapshots.length).toBeGreaterThan(1);
  await stop();
});

test("publishes the complete assistant entry only after the run ends", async () => {
  const { runtime, faux } = setup({}, true);
  const a = makeAgent();
  const conversation = await runtime.createConversation(a);
  const answer = "The complete answer arrives at the turn boundary.";
  faux.setResponses([fauxAssistantMessage(answer)]);
  const snapshots: Awaited<ReturnType<typeof runtime.snapshot>>[] = [];

  const stop = await runtime.watch(a, conversation, (snapshot) => {
    snapshots.push(snapshot);
  });

  const submission = await runtime.submit(a, conversation, "go", "complete");
  const settled = await runtime.wait(submission, a);
  expect(settled.status).toBe("done");
  const final = await runtime.snapshot(a, conversation);
  expect(final.status).toBe("idle");
  expect(final.partial).toBe("");
  expect(final.messages.some((message) => message.content === answer)).toBe(
    true,
  );
  expect(
    snapshots
      .filter((snapshot) => snapshot.status === "running")
      .every((snapshot) => snapshot.partial === ""),
  ).toBe(true);
  await stop();
});

test("hides text from an assistant tool round until the whole turn completes", async () => {
  let release!: () => void;
  const toolDone = new Promise<void>((resolve) => (release = resolve));

  const tool = defineTool({
    name: "blocked",
    description: "Wait for the test",
    parameters: Type.Object({}),
    execute: async () => {
      await toolDone;

      return { output: [{ type: "text", text: "tool finished" }] };
    },
  });

  const { runtime, faux } = setup({
    extensions: () => [defineExtension({ name: "blocked", tools: [tool] })],
  });

  const a = makeAgent();
  const conversation = await runtime.createConversation(a);
  const intermediate = "I need to check that tool first.";
  faux.setResponses([
    fauxAssistantMessage(
      [{ type: "text", text: intermediate }, fauxToolCall("blocked", {})],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("The complete answer after the tool."),
  ]);
  const submission = await runtime.submit(a, conversation, "go", "tool-round");
  let running = await runtime.snapshot(a, conversation);

  for (let attempt = 0; attempt < 20 && !running.live; attempt++) {
    await Bun.sleep(10);
    running = await runtime.snapshot(a, conversation);
  }

  await Bun.sleep(80);
  running = await runtime.snapshot(a, conversation);
  expect(running.status).toBe("running");
  expect(
    running.messages.some((message) => message.content.includes(intermediate)),
  ).toBe(false);
  expect(
    (await runtime.history(a)).messages.some((message) =>
      message.content.includes(intermediate),
    ),
  ).toBe(false);
  expect(
    (await runtime.history(a, { includeActiveAssistant: true })).messages.some(
      (message) => message.content.includes(intermediate),
    ),
  ).toBe(true);
  release();
  expect((await runtime.wait(submission, a)).status).toBe("done");
  const final = await runtime.snapshot(a, conversation);
  expect(
    final.messages.some((message) =>
      message.content.includes("complete answer"),
    ),
  ).toBe(true);
});

test("inference overrides reach provider options and deleting an agent removes its durable files", async () => {
  const { runtime, faux } = setup();
  const agent = makeAgent();
  agent.inference = {
    thinkingLevel: "low",
    temperature: 0.3,
    maxOutputTokens: 500,
  };
  faux.setResponses([
    (_context, options) => {
      expect(options?.temperature).toBe(0.3);
      expect(options?.maxTokens).toBe(500);

      return fauxAssistantMessage("configured");
    },
  ]);
  const conversation = await runtime.createConversation(agent);
  expect(
    (
      await runtime.wait(
        await runtime.submit(agent, conversation, "hello", "inference"),
        agent,
      )
    ).status,
  ).toBe("done");
  await runtime.deleteAgent(agent.id);
  expect(
    await Bun.file(join(directories.at(-1)!, agent.id + ".sqlite")).exists(),
  ).toBe(false);
});
