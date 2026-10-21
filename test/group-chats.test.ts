import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { GROUP_TURN_BUDGET } from "../src/domain";
import { GroupChats } from "../src/group-chats";
import { GroupTranscripts } from "../src/group-transcripts";
import { reactionExtension } from "../src/reaction";
import { AgentRuntime } from "../src/runtime";
import { CrumbleService } from "../src/service";
import { Store } from "../src/store";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const textOf = (message: Message) =>
  (Array.isArray(message.content)
    ? message.content
    : [{ type: "text" as const, text: message.content }]
  )
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

/** How one bot answers a turn's input; a promise holds the turn open. */
type Bot = (
  input: string,
  signal: AbortSignal | undefined,
) => AssistantMessage | Promise<AssistantMessage>;

/** A model call that runs until its turn is aborted, as a provider request does. */
const hang: Bot = (_input, signal) =>
  new Promise((_resolve, reject) =>
    signal?.addEventListener("abort", () => reject(new Error("aborted"))),
  );

const say = (text: string) => fauxAssistantMessage([fauxText(text)]);

const call = (name: string, args: Record<string, string> = {}) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

/** One scripted model plays every bot; the identity line of the prompt tells them apart. */
function script(
  bots: Record<string, Bot>,
  inputs: Map<string, string[]>,
): FauxResponseFactory {
  return async (context, options) => {
    const system = context.messages
      .filter((message) => message.role === "system")
      .map((message) => JSON.stringify(message))
      .join("\n");

    // Summaries for joining members are requests of their own, answered by the `summary` entry.
    const name = system.includes("Summarize this group chat")
      ? "summary"
      : (/You are (.+?), a bot on Crumble/.exec(system)?.[1] ?? "");

    const last = context.messages.findLast(
      (message) => message.role !== "system",
    )!;

    // A tool result means the bot already acted; its final text closes the turn.
    if (last.role === "toolResult") return say("Done.");
    const input = textOf(last);
    inputs.set(name, [...(inputs.get(name) ?? []), input]);

    return (bots[name] ?? (() => call("pass")))(input, options?.signal);
  };
}

const bot = (name: string, enabled = true) => ({
  name,
  avatar: "bot",
  description: "",
  instructions: "Answer",
  provider: "faux",
  model: "chat",
  enabled,
  tools: [],
  skills: [],
  mcpServers: [],
  delegates: [],
});

function open(dir: string, bots: Record<string, Bot>) {
  const inputs = new Map<string, string[]>();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  faux.setResponses(Array.from({ length: 200 }, () => script(bots, inputs)));
  const models = createModels();
  models.setProvider(faux.provider);
  const store = new Store(dir);

  const service = new CrumbleService(
    store,
    new AgentRuntime(join(dir, "agents"), {
      models,
      extensions: () => [reactionExtension()],
    }),
  );

  const groups = new GroupChats(
    store,
    new GroupTranscripts(join(dir, "groups")),
    service,
  );

  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    await groups.close();
    await service.close();
  };

  cleanups.push(close);

  return { store, service, groups, inputs, close };
}

function setup(bots: Record<string, Bot> = {}, names = ["Ada", "Grace"]) {
  const dir = mkdtempSync(join(tmpdir(), "bot-group-chats-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const opened = open(dir, bots);
  const agents = names.map((name) => opened.store.createAgent(bot(name)));

  const group = opened.groups.create({
    name: "Trip",
    memberIds: agents.map((agent) => agent.id),
  });

  return { ...opened, dir, agents, group };
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500 && !(await check()); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));

  expect(await check()).toBe(true);
}

/** Waits until no member has a running or queued turn. */
const quiet = (groups: GroupChats, groupId: string) =>
  until(() =>
    groups
      .activity(groupId)
      .members.every((member) => ["idle", "disabled"].includes(member.status)),
  );

const botMessages = async (groups: GroupChats, groupId: string) =>
  (await groups.snapshot(groupId, { limit: 200 })).messages.filter(
    (message) => message.origin?.kind === "bot",
  );

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));

  return { open, opened };
}

describe("group chat membership and transcript", () => {
  test("rejects members that are not bots", () => {
    const { groups, agents } = setup();

    expect(() =>
      groups.create({
        name: "Trip",
        memberIds: [agents[0]!.id, crypto.randomUUID()],
      }),
    ).toThrow("Choose existing bots as members");
  });

  test("posts owner messages, notifies subscribers, and serves snapshots", async () => {
    const { groups, group } = setup();
    let calls = 0;
    const unsubscribe = groups.subscribe(group.id, () => calls++);
    const receipt = await groups.post(group.id, "Plan it", "r-1");

    expect(receipt.requestId).toBe("r-1");
    expect(receipt.entryId.startsWith(`${group.id}:`)).toBe(true);
    expect(calls).toBe(1);

    const snapshot = await groups.snapshot(group.id, {});

    expect(snapshot.groupChat).toEqual(group);
    expect(snapshot.messages.map((message) => message.content)).toEqual([
      "Plan it",
    ]);
    unsubscribe();
    await quiet(groups, group.id);
  });

  test("renames and deletes a group with its transcript", async () => {
    const { groups, group, agents } = setup();
    const [a, b] = agents.map((agent) => agent.id);

    expect(
      await groups.update(group.id, { name: "Holiday", memberIds: [b!, a!] }),
    ).toMatchObject({ name: "Holiday", memberIds: [a, b] });
    await groups.post(group.id, "Hello", "r-1");
    await groups.delete(group.id);
    expect(() => groups.get(group.id)).toThrow("Group chat not found");
    await expect(groups.post(group.id, "Late", "r-2")).rejects.toThrow(
      "Group chat not found",
    );
  });
});

describe("group turns", () => {
  test("an unmentioned owner message reaches every member", async () => {
    const { groups, group, inputs } = setup({
      Ada: () => say("Ada here."),
      Grace: () => say("Grace here."),
    });

    await groups.post(group.id, "Who is around?", "r-1");
    await quiet(groups, group.id);

    expect(
      (await botMessages(groups, group.id)).map((message) => message.content),
    ).toEqual(expect.arrayContaining(["Ada here.", "Grace here."]));
    expect(inputs.get("Ada")?.[0]).toContain("Owner: Who is around?");
  });

  test("a mention or a reply reaches only that bot", async () => {
    const { groups, group, inputs } = setup({
      Ada: () => say("On it."),
      Grace: () => say("Grace answers."),
    });

    await groups.post(group.id, "@Ada pack the tent", "r-1");
    await quiet(groups, group.id);
    expect(inputs.has("Grace")).toBe(false);

    const answer = (await botMessages(groups, group.id))[0]!;
    await groups.post(group.id, "Thanks, and the stove?", "r-2", {
      replyTo: answer.entryId,
    });
    await quiet(groups, group.id);
    expect(inputs.get("Ada")).toHaveLength(2);
    expect(inputs.has("Grace")).toBe(false);
  });

  test("a bot message wakes only the bots it mentions", async () => {
    const { groups, group, inputs } = setup({
      Ada: (input) =>
        input.includes("ask Grace")
          ? say("@Grace what do you think?")
          : say("Noted."),
      Grace: () => say("Sounds good."),
    });

    await groups.post(group.id, "@Ada note this", "r-1");
    await quiet(groups, group.id);
    expect(inputs.has("Grace")).toBe(false);

    await groups.post(group.id, "@Ada ask Grace", "r-2");
    await quiet(groups, group.id);
    expect(inputs.get("Grace")?.[0]).toContain(
      "Ada: @Grace what do you think?",
    );
  });

  test("mentions during a running turn queue one follow-up turn", async () => {
    const held = gate();

    const { groups, group, inputs } = setup({
      Ada: async (input) => {
        if (input.includes("first")) await held.opened;

        return say("Reply.");
      },
    });

    await groups.post(group.id, "@Ada first", "r-1");
    await groups.post(group.id, "@Ada second", "r-2");
    await groups.post(group.id, "@Ada third", "r-3");
    expect(groups.activity(group.id).members[0]?.status).toBe("running");
    held.open();
    await quiet(groups, group.id);

    const turns = inputs.get("Ada")!;

    expect(turns).toHaveLength(2);
    expect(turns[1]).toContain("@Ada second");
    expect(turns[1]).toContain("@Ada third");
  });

  test("bots that keep mentioning each other pause at the budget", async () => {
    const { groups, group, inputs } = setup({
      Ada: () => say("@Grace your turn"),
      Grace: () => say("@Ada your turn"),
    });

    await groups.post(group.id, "@Ada start", "r-1");
    await until(() => groups.activity(group.id).paused);
    await quiet(groups, group.id);

    const turns = () =>
      (inputs.get("Ada")?.length ?? 0) + (inputs.get("Grace")?.length ?? 0);

    // The owner's message starts one turn; bots start the budget's worth.
    expect(turns()).toBe(1 + GROUP_TURN_BUDGET);
    expect(groups.activity(group.id).botTurns).toBe(GROUP_TURN_BUDGET);

    await groups.post(group.id, "@Ada once more", "r-2");
    expect(groups.activity(group.id).paused).toBe(false);
    await until(() => turns() > 1 + GROUP_TURN_BUDGET);
    await groups.stop(group.id);
  });

  test("stop ends running turns and starts no queued turn", async () => {
    const { groups, group, store } = setup({
      Ada: hang,
      Grace: hang,
    });

    await groups.post(group.id, "Think hard", "r-1");
    await groups.post(group.id, "@Ada and then this", "r-2");
    expect(groups.activity(group.id).members.map((m) => m.status)).toEqual([
      "running",
      "running",
    ]);
    expect(store.groupMember(group.id, group.memberIds[0]!)?.pending).toBe(
      true,
    );

    await groups.stop(group.id);
    await quiet(groups, group.id);
    expect(await botMessages(groups, group.id)).toEqual([]);
    expect(store.groupMember(group.id, group.memberIds[0]!)?.pending).toBe(
      false,
    );
  });

  test("a disabled member starts no turn and shows as disabled", async () => {
    const { groups, group, store, inputs, agents } = setup({
      Ada: () => say("Here."),
    });

    store.updateAgent(agents[1]!.id, { enabled: false });
    await groups.post(group.id, "Anyone?", "r-1");
    await quiet(groups, group.id);
    expect(inputs.has("Grace")).toBe(false);
    expect(groups.activity(group.id).members[1]?.status).toBe("disabled");
  });

  test("a turn sees other members' messages but not their working context", async () => {
    const { groups, group, inputs } = setup({
      Ada: () =>
        fauxAssistantMessage(
          [
            fauxText("private reasoning"),
            fauxToolCall("react", { emoji: "👍" }),
          ],
          { stopReason: "toolUse" },
        ),
      Grace: (input) =>
        input.includes("second") ? say("Seen.") : call("pass"),
    });

    await groups.post(group.id, "first", "r-1");
    await quiet(groups, group.id);
    await groups.post(group.id, "@Grace second", "r-2");
    await quiet(groups, group.id);

    const reaction = (await botMessages(groups, group.id)).find(
      (message) => message.toolName === "react",
    );

    expect(reaction).toMatchObject({ toolDetails: { emoji: "👍" } });
    expect(inputs.get("Grace")!.join("\n")).not.toContain("private reasoning");
  });

  test("a removed member's turn posts nothing", async () => {
    const held = gate();

    const { groups, group, agents } = setup(
      {
        Ada: async () => {
          await held.opened;

          return say("Too late.");
        },
      },
      ["Ada", "Grace", "Hopper"],
    );

    await groups.post(group.id, "@Ada go", "r-1");
    await groups.update(group.id, {
      name: "Trip",
      memberIds: [agents[1]!.id, agents[2]!.id],
    });
    held.open();
    await quiet(groups, group.id);
    expect(await botMessages(groups, group.id)).toEqual([]);
  });
});

describe("joining members", () => {
  async function joinHopper(bots: Record<string, Bot>) {
    const opened = setup({ Ada: () => call("pass"), ...bots });
    const { groups, group, store } = opened;
    await groups.post(group.id, "We leave on Friday", "r-1");
    await groups.post(group.id, "Bring the tent", "r-2");
    await quiet(groups, group.id);
    const hopper = store.createAgent(bot("Hopper"));

    await groups.update(group.id, {
      name: "Trip",
      memberIds: [...group.memberIds, hopper.id],
    });

    return opened;
  }

  test("a member added later gets one summary on its first turn", async () => {
    const { groups, group, inputs } = await joinHopper({
      summary: () => say("The group leaves Friday and needs a tent."),
      Hopper: () => say("Got it."),
    });

    expect(inputs.has("summary")).toBe(false);
    await groups.post(group.id, "@Hopper can you drive?", "r-3");
    await quiet(groups, group.id);
    await groups.post(group.id, "@Hopper and the snacks?", "r-4");
    await quiet(groups, group.id);

    expect(inputs.get("summary")).toHaveLength(1);
    expect(inputs.get("summary")![0]).toContain("Owner: We leave on Friday");
    const [first, second] = inputs.get("Hopper")!;

    expect(first).toStartWith(
      "Summary of the conversation before you joined:\n\nThe group leaves Friday and needs a tent.",
    );
    expect(first).toContain("Owner: @Hopper can you drive?");
    expect(first).not.toContain("Bring the tent");
    expect(second).not.toContain("Summary of the conversation");
  });

  test("a founding member gets no summary", async () => {
    const { groups, group, inputs } = setup({ Ada: () => say("Hi.") });

    await groups.post(group.id, "@Ada hello", "r-1");
    await quiet(groups, group.id);
    await groups.post(group.id, "@Ada again", "r-2");
    await quiet(groups, group.id);
    expect(inputs.has("summary")).toBe(false);
  });

  test("a failed summary still starts the turn", async () => {
    const { groups, group, inputs } = await joinHopper({
      summary: () =>
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "down" }),
      Hopper: () => say("Got it."),
    });

    await groups.post(group.id, "@Hopper can you drive?", "r-3");
    await quiet(groups, group.id);
    expect(inputs.get("Hopper")![0]).toContain(
      "The earlier conversation could not be summarized.",
    );
  });
});

describe("group turns across restarts", () => {
  test("a turn running at shutdown posts its answer once after reopening", async () => {
    const { dir, groups, group, close } = setup({
      Ada: hang,
    });

    await groups.post(group.id, "@Ada plan", "r-1");
    await close();

    const reopened = open(dir, { Ada: () => say("Planned.") });
    await reopened.service.recover();
    await reopened.groups.recover();
    await quiet(reopened.groups, group.id);
    await until(
      async () => (await botMessages(reopened.groups, group.id)).length > 0,
    );
    expect(
      (await botMessages(reopened.groups, group.id)).map((m) => m.content),
    ).toEqual(["Planned."]);
  });

  test("an unfinished post is completed once", async () => {
    const { dir, groups, group, store, close } = setup({
      Ada: () => say("Planned."),
    });

    await groups.post(group.id, "@Ada plan", "r-1");
    await quiet(groups, group.id);
    expect(await botMessages(groups, group.id)).toHaveLength(1);

    // As if the server stopped after posting but before recording it.
    const [turn] = store.listGroupTurns({ groupId: group.id });
    store.updateGroupTurn(turn!.executionId, { status: "posting" });
    await close();

    const reopened = open(dir, {});
    await reopened.service.recover();
    await reopened.groups.recover();
    expect(reopened.store.getGroupTurn(turn!.executionId)?.status).toBe(
      "settled",
    );
    expect(await botMessages(reopened.groups, group.id)).toHaveLength(1);
  });
});
