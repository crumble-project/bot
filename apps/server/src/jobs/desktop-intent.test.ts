import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { heldActionsAccess } from "../bot-desktop/held-actions";
import type { JudgeAnswer } from "../bot-desktop/intent-check";
import { agentInput } from "../shared/domain";
import { Conflict } from "../shared/errors";
import { Store } from "../../test/support/store";
import { desktopIntentGate, type GateCall } from "./desktop-intent";
import type { JobRequest } from "./owner-request";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// SAFETY: conversation IDs are opaque to the gate, which only hands this one to postCard.
const chatId = 1 as ConversationId;

const jobRequest: JobRequest = {
  ownerMessages: [
    { requestId: "r1", text: "Check train times to Hamburg", from: "owner" },
  ],
  tasks: ["Look up trains to Hamburg on Friday"],
  job: { name: "trains", chatId },
};

const buy = {
  action: {
    steps: [
      { action: "click", target: { role: "button", name: "Buy ticket" } },
    ],
    host: "rail.example",
  },
  page: "https://rail.example/checkout",
};

function setup(answer: JudgeAnswer) {
  const dir = mkdtempSync(join(tmpdir(), "bot-intent-"));

  dirs.push(dir);

  const store = new Store(dir);
  const agent = store.createAgent(agentInput.parse({ name: "Desk" }));
  const held = heldActionsAccess(store.runtime);
  const cards: { chatId: ConversationId; id: string; action: string }[] = [];

  const call: GateCall = {
    models: createModels(),
    request: async () => jobRequest,
    postCard: async (to, card) => {
      cards.push({ chatId: to, id: card.id, action: card.action });
    },
  };

  const gate = desktopIntentGate(
    {
      judgeFor: async () => ({ judge: async () => answer, name: "Fake judge" }),
      held,
    },
    agent.id,
    call,
  );

  return { store, agentId: agent.id, held, cards, gate };
}

const posted = async (cards: unknown[]) => {
  while (!cards.length) await new Promise((resolve) => setTimeout(resolve, 5));
};

test("an action the owner asked for runs without a card", async () => {
  const { store, cards, gate } = setup({
    irreversible: 0.9,
    inIntent: 0.97,
    inIntentBar: 0.9,
  });

  expect(await gate(buy, BACKGROUND_CONTEXT)).toBeUndefined();
  expect(cards).toEqual([]);
  store.close();
});

test("a held action shows a card and runs once the owner approves", async () => {
  const { store, agentId, held, cards, gate } = setup({
    irreversible: 0.9,
    inIntent: 0.2,
    inIntentBar: 0.9,
  });

  const waiting = gate(buy, BACKGROUND_CONTEXT);

  await posted(cards);
  expect(cards[0]).toMatchObject({
    chatId,
    action: 'Click button "Buy ticket" on rail.example',
  });

  const [pending] = held.list(agentId);

  expect(pending).toMatchObject({
    status: "pending",
    job: "trains",
    page: "https://rail.example/checkout",
    ownerMessages: jobRequest.ownerMessages,
  });
  expect(pending!.reason).toContain("Fake judge");

  await held.decide(agentId, cards[0]!.id, { status: "approved" });
  expect(await waiting).toBeUndefined();
  expect(held.list(agentId)[0]!.status).toBe("approved");
  store.close();
});

test("a declined action is refused with the owner's reason", async () => {
  const { store, agentId, held, cards, gate } = setup({
    irreversible: 0.9,
    inIntent: 0.2,
    inIntentBar: 0.9,
  });

  const waiting = gate(buy, BACKGROUND_CONTEXT);

  await posted(cards);
  await held.decide(agentId, cards[0]!.id, {
    status: "declined",
    reason: "Only look, don't buy",
  });

  const refused = await waiting;

  expect(refused).toStartWith("REFUSED: the owner declined");
  expect(refused).toContain("Only look, don't buy");
  await expect(
    held.decide(agentId, cards[0]!.id, { status: "approved" }),
  ).rejects.toBeInstanceOf(Conflict);
  store.close();
});
