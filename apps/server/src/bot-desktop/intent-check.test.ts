import { describe, expect, test } from "bun:test";
import {
  checkIntent,
  describeAction,
  isCommitPoint,
  judgeState,
  type IntentRequest,
  type IntentStep,
  type JudgeAnswer,
} from "./intent-check";

const click = (role: string, name: string): IntentStep => ({
  action: "click",
  target: { role, name },
});

const request = (...steps: IntentStep[]): IntentRequest => ({
  ownerMessages: [
    { requestId: "r1", text: "Find me a train to Hamburg", from: "owner" },
  ],
  tasks: ["Search trains to Hamburg on Friday"],
  action: { steps, host: "shop.example" },
});

const judging = (answer: JudgeAnswer) => async () => answer;

describe("the rule floor", () => {
  test("names commit points in several languages", () => {
    for (const step of [
      click("push button", "Place order"),
      click("link", "Zahlungspflichtig bestellen"),
      click("button", "Envoyer"),
      click("button", "Löschen"),
      { action: "double_click", target: { name: "Pay now" } },
    ])
      expect(isCommitPoint({ steps: [step] })).toBe(true);
  });

  test("leaves fields, other words, and other actions alone", () => {
    for (const step of [
      click("entry", "Order number"),
      click("button", "Paypal help"),
      click("link", "Payments overview"),
      {
        action: "type",
        text: "buy",
        target: { role: "entry", name: "Search" },
      },
      { action: "right_click", target: { role: "button", name: "Buy" } },
    ])
      expect(isCommitPoint({ steps: [step] })).toBe(false);
  });

  test("counts Enter wherever the focus is, and no other key", () => {
    expect(isCommitPoint({ steps: [{ action: "key", keys: "Return" }] })).toBe(
      true,
    );
    expect(
      isCommitPoint({ steps: [{ action: "key", keys: "ctrl+enter" }] }),
    ).toBe(true);
    expect(isCommitPoint({ steps: [{ action: "key", keys: "ctrl+l" }] })).toBe(
      false,
    );
  });

  test("leaves Enter in a terminal to a judge that sees its command, and nothing else", () => {
    const enter = { action: "key", keys: "Return" };
    const terminal = { steps: [enter], terminal: true, command: "$ ls" };

    expect(isCommitPoint(terminal, true)).toBe(false);
    // Without a judge, or without the command it runs, the Enter still counts.
    expect(isCommitPoint(terminal)).toBe(true);
    expect(isCommitPoint({ steps: [enter], terminal: true }, true)).toBe(true);
    expect(
      isCommitPoint(
        { ...terminal, steps: [enter, click("button", "Delete")] },
        true,
      ),
    ).toBe(true);
  });

  test("a steps call is a commit point when any step is", () => {
    expect(
      isCommitPoint({
        steps: [click("link", "Fares"), click("button", "Buy ticket")],
      }),
    ).toBe(true);
  });
});

describe("checkIntent", () => {
  test("a commit point is irreversible whatever the judge says", async () => {
    const verdict = await checkIntent(
      judging({ irreversible: 0.01, inIntent: 0.6, inIntentBar: 0.9 }),
      request(click("button", "Buy ticket")),
      undefined,
    );

    expect(verdict).toEqual({
      irreversible: true,
      held: true,
      commitPoint: true,
      answer: { irreversible: 0.01, inIntent: 0.6, inIntentBar: 0.9 },
    });
  });

  test("a terminal Enter is held when the judge is missing or fails, and runs when the judge sees a harmless command", async () => {
    const enter: IntentRequest = {
      ...request({ action: "key", keys: "Return" }),
      action: {
        steps: [{ action: "key", keys: "Return" }],
        terminal: true,
        command: "$ ls -la",
      },
    };

    const failing = async () => {
      throw new Error("judge down");
    };

    expect((await checkIntent(undefined, enter, undefined)).held).toBe(true);
    expect((await checkIntent(failing, enter, undefined)).held).toBe(true);
    expect(
      (
        await checkIntent(
          judging({ irreversible: 0.1, inIntent: 0.05, inIntentBar: 0.9 }),
          enter,
          undefined,
        )
      ).held,
    ).toBe(false);
  });

  test("a classifier must be confident the owner asked", async () => {
    const asked = await checkIntent(
      judging({ irreversible: 0.95, inIntent: 0.93, inIntentBar: 0.9 }),
      request(click("button", "Buy ticket")),
      undefined,
    );

    expect(asked.held).toBe(false);
  });

  test("the judge can hold an action no rule matches", async () => {
    const verdict = await checkIntent(
      judging({ irreversible: 0.8, inIntent: 0.2, inIntentBar: 0.9 }),
      request(click("button", "Yes")),
      undefined,
    );

    expect(verdict).toEqual({
      irreversible: true,
      held: true,
      commitPoint: false,
      answer: { irreversible: 0.8, inIntent: 0.2, inIntentBar: 0.9 },
    });
  });

  test("a reversible action runs", async () => {
    const verdict = await checkIntent(
      judging({ irreversible: 0.1, inIntent: 0.1, inIntentBar: 0.9 }),
      request(click("link", "Fares")),
      undefined,
    );

    expect(verdict.held).toBe(false);
  });

  test("a chat judge's commit point runs only when it answers in intent", async () => {
    const step = click("button", "Buy ticket");

    expect(
      (
        await checkIntent(
          judging({ irreversible: 0, inIntent: 1, inIntentBar: 0.5 }),
          request(step),
          undefined,
        )
      ).held,
    ).toBe(false);
    expect(
      (
        await checkIntent(
          judging({ irreversible: 1, inIntent: 0, inIntentBar: 0.5 }),
          request(step),
          undefined,
        )
      ).held,
    ).toBe(true);
  });

  test("without a working judge the rules decide alone", async () => {
    const failing = async () => {
      throw new Error("rate limited");
    };

    expect(
      await checkIntent(
        failing,
        request(click("button", "Buy ticket")),
        undefined,
      ),
    ).toEqual({
      irreversible: true,
      held: true,
      commitPoint: true,
      answer: undefined,
      judgeError: "rate limited",
    });
    expect(
      (await checkIntent(failing, request(click("link", "Fares")), undefined))
        .held,
    ).toBe(false);
    expect(
      (await checkIntent(undefined, request(click("button", "Pay")), undefined))
        .held,
    ).toBe(true);
  });
});

test("the judge reads owner messages, the task, and the action, never page text", () => {
  const state = judgeState(request(click("button", "Buy ticket")));

  expect(Object.keys(state).sort()).toEqual([
    "job_task",
    "owner_messages",
    "proposed_action",
  ]);
  expect(state["proposed_action"]).toEqual({
    summary: 'Click button "Buy ticket" on shop.example',
    host: "shop.example",
    steps: [
      { action: "click", target: { role: "button", name: "Buy ticket" } },
    ],
  });
});

test("describes an action in plain words", () => {
  expect(
    describeAction({
      steps: [
        {
          action: "type",
          text: "Ada",
          target: { role: "entry", name: "Name" },
        },
        { action: "key", keys: "Return" },
      ],
    }),
  ).toBe('Type "Ada" into entry "Name", then press Return');
});
