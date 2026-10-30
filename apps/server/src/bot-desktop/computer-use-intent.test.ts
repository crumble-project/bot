import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createComputerUse, type ControlGate } from "./computer-use";
import type { IntentGate } from "./computer-use-intent";
import { isCommitPoint, type ProposedAction } from "./intent-check";
import { scriptedGuest } from "../../test/fixtures/scripted-guest";

const shop = { pid: 7, window_id: 101, app_name: "Chromium", title: "Shop" };
const help = { pid: 8, window_id: 102, app_name: "Help", title: "Help" };

/** An intent gate that records each proposal and answers with `refusal`. */
function recording(refusal?: string) {
  const seen: ProposedAction[] = [];

  const gate: IntentGate = async ({ action }) => {
    seen.push(action);

    return refusal === undefined ? {} : { refusal };
  };

  return { seen, gate };
}

test("a role of several words keeps its name, so the commit-point rule sees it", async () => {
  const { shell } = scriptedGuest({
    list_windows: [{ windows: [shop] }],
    get_window_state: [
      {
        snapshot_id: "s1",
        tree_markdown:
          '- [0] frame "Shop"\n  - [3] push button "Pay now" [actions=[press]]',
      },
    ],
    click: [{ effect: "confirmed", summary: "Clicked [3]" }],
  });

  const { seen, gate } = recording();
  const computer = createComputerUse(shell);

  await computer.run({ action: "capture" }, BACKGROUND_CONTEXT, gate);
  await computer.run({ action: "click", element: 3 }, BACKGROUND_CONTEXT, gate);

  expect(seen[0]!.steps[0]!.target).toEqual({
    role: "push button",
    name: "Pay now",
  });
  expect(isCommitPoint(seen[0]!)).toBe(true);
});

test("the check names the element in the window the action runs in", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [{ windows: [shop, help] }],
    get_window_state: [
      { snapshot_id: "h1", tree_markdown: '- [3] link "Help"' },
      { snapshot_id: "s1", tree_markdown: '- [3] push button "Pay now"' },
    ],
    click: [{ effect: "confirmed", summary: "Clicked [3]" }],
  });

  const { seen, gate } = recording();
  const computer = createComputerUse(shell);

  await computer.run(
    { action: "capture", window_id: 102 },
    BACKGROUND_CONTEXT,
    gate,
  );
  await computer.run(
    { action: "capture", window_id: 101 },
    BACKGROUND_CONTEXT,
    gate,
  );
  // No window: the focused one, 101, for the check and the click alike.
  await computer.run({ action: "click", element: 3 }, BACKGROUND_CONTEXT, gate);

  expect(seen[0]!.steps[0]!.target?.name).toBe("Pay now");
  expect(calls.find((each) => each.tool === "click")?.args).toMatchObject({
    window_id: 101,
    element_token: "s1:3",
  });
});

test("a key step's role and name are ignored: the key goes to the focus", async () => {
  const { shell } = scriptedGuest({
    list_windows: [{ windows: [shop] }],
    run_steps: [{ steps: [], failed_step: null, total: 1 }],
  });

  const { seen, gate } = recording("REFUSED: held");

  await createComputerUse(shell).run(
    {
      action: "steps",
      steps: [{ action: "key", keys: "Return", role: "button", name: "Next" }],
    },
    BACKGROUND_CONTEXT,
    gate,
  );

  expect(seen[0]!.steps[0]!.target).toBeUndefined();
  expect(isCommitPoint(seen[0]!)).toBe(true);
});

test("an approved action doesn't run when the owner took control while it was held", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [{ windows: [shop] }],
    get_window_state: [
      { snapshot_id: "s1", tree_markdown: '- [3] push button "Pay now"' },
    ],
    click: [{ effect: "confirmed", summary: "Clicked [3]" }],
  });

  let changes = 0;

  const control: ControlGate = {
    untilBot: async () => ({
      holder: "bot",
      changes,
      updatedAt: new Date(0).toISOString(),
    }),
  };

  // The owner takes control and hands it back while the action waits for approval.
  const gate: IntentGate = async () => {
    changes += 2;

    return {};
  };

  const computer = createComputerUse(shell, { gate: control });

  await computer.run({ action: "capture" }, BACKGROUND_CONTEXT, gate);

  const result = await computer.run(
    { action: "click", element: 3 },
    BACKGROUND_CONTEXT,
    gate,
  );

  expect(result.isError).toBe(true);
  expect(result.content[0]).toMatchObject({
    text: expect.stringContaining("Control changed hands"),
  });
  expect(calls.some((each) => each.tool === "click")).toBe(false);
});

test("the judge's spend is on the call's result, whether the action ran or was refused", async () => {
  const { shell } = scriptedGuest({
    list_windows: [{ windows: [shop] }],
    get_window_state: [
      { snapshot_id: "s1", tree_markdown: '- [3] push button "Pay now"' },
    ],
    click: [{ effect: "confirmed", summary: "Clicked [3]" }],
  });

  const usage = {
    input: 600,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 600,
    cost: {
      input: 0.0000252,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.0000252,
    },
  };

  const computer = createComputerUse(shell);

  await computer.run(
    { action: "capture" },
    BACKGROUND_CONTEXT,
    async () => ({}),
  );

  const ran = await computer.run(
    { action: "click", element: 3 },
    BACKGROUND_CONTEXT,
    async () => ({ usage }),
  );

  const refused = await computer.run(
    { action: "click", element: 3 },
    BACKGROUND_CONTEXT,
    async () => ({ usage, refusal: "REFUSED: declined" }),
  );

  expect(ran).toMatchObject({ isError: false, usage });
  expect(refused).toMatchObject({ isError: true, usage });

  // An observing call isn't checked and spends nothing.
  const read = await computer.run(
    { action: "capture" },
    BACKGROUND_CONTEXT,
    async () => ({ usage }),
  );

  expect(read.usage).toBeUndefined();
});
