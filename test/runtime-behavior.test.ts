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
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { AgentRuntime, providerModels } from "../src/runtime";
import { loadCommonSkills } from "../src/common-skills";
import { agentInput, type Agent } from "../src/domain";

const directories: string[] = [];
const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const makeAgent = (): Agent => ({
  ...agentInput.parse({ name: "Test" }),
  id: crypto.randomUUID(),
  provider: "faux" as never,
  model: "test",
  createdAt: "",
  updatedAt: "",
});
function setup(
  options: ConstructorParameters<typeof AgentRuntime>[1] = {},
  slow = false,
) {
  const directory = mkdtempSync(join(tmpdir(), "crumble-runtime-"));
  directories.push(directory);
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "test" }],
    ...(slow ? { tokensPerSecond: 60, tokenSize: { min: 1, max: 1 } } : {}),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new AgentRuntime(directory, { ...options, models });
  runtimes.push(runtime);
  return { runtime, faux };
}

test("saved credentials rotate without opening a new runtime", async () => {
  let key = "first-test-key";
  const models = providerModels(() => key);
  expect((await models.getAuth("openai"))?.auth.apiKey).toBe(key);
  key = "second-test-key";
  expect((await models.getAuth("openai"))?.auth.apiKey).toBe(key);
});

test("profile edits, skills and memory reach the next request without leaking between agents", async () => {
  const requests: string[] = [];
  const { runtime, faux } = setup({
    listMemory: (id) => [{ id: "memory", content: `private:${id}` }],
  });
  const a = makeAgent(),
    b = makeAgent();
  const response = (context: unknown) => {
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
  expect(requests[1]).toContain("Check primary sources");
  expect(requests[1]).toContain(`private:${a.id}`);
  expect(requests[2]).toContain(`private:${b.id}`);
  expect(requests[2]).not.toContain(`private:${a.id}`);
  await expect(runtime.snapshot(b, ca)).rejects.toThrow();
});

test("loads bounded common skills and applies them before shared and personal skills", async () => {
  const skillsRoot = mkdtempSync(join(tmpdir(), "crumble-skills-"));
  directories.push(skillsRoot);
  const taskDir = join(skillsRoot, "tasks");
  mkdirSync(taskDir);
  await Bun.write(
    join(taskDir, "SKILL.md"),
    "---\nname: Tasks\ndescription: Handle tasks\n---\nCommon task rules",
  );
  const common = loadCommonSkills(skillsRoot);
  expect(common).toHaveLength(1);
  expect(common[0]).toMatchObject({
    id: "common:tasks/SKILL.md",
    name: "Tasks",
    description: "Handle tasks",
    instructions: "Common task rules",
  });
  const requests: string[] = [];
  const { runtime, faux } = setup({
    commonSkills: () => common,
    sharedSkills: () => [{ name: "Shared", instructions: "Shared rules" }],
  });
  const agent = {
    ...makeAgent(),
    skills: [{ name: "Personal", instructions: "Personal rules" }],
  };
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
  const prompt = requests[0] ?? "";
  expect(prompt.indexOf("Common task rules")).toBeLessThan(
    prompt.indexOf("Shared rules"),
  );
  expect(prompt.indexOf("Shared rules")).toBeLessThan(
    prompt.indexOf("Personal rules"),
  );
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
      expect(JSON.stringify(context.messages)).toContain(
        '\"name\":\"example\"',
      );
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

test("committed partial responses stream and cancellation settles the submission", async () => {
  const { runtime, faux } = setup({}, true);
  const a = makeAgent();
  const conversation = await runtime.createConversation(a);
  faux.setResponses([
    fauxAssistantMessage(
      "A deliberately long response that can be cancelled before it finishes.",
    ),
  ]);
  const snapshots: string[] = [];
  const stop = await runtime.watch(a, conversation, (snapshot) => {
    snapshots.push(JSON.stringify(snapshot.live));
  });
  const submission = await runtime.submit(a, conversation, "go", "cancel-test");
  await Bun.sleep(180);
  expect((await runtime.snapshot(a, conversation)).status).toBe("running");
  await runtime.abort(a, conversation);
  const settled = await runtime.wait(submission, a);
  expect(settled.status).not.toBe("done");
  expect((await runtime.snapshot(a, conversation)).status).toBe("idle");
  expect(snapshots.length).toBeGreaterThan(1);
  await stop();
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
