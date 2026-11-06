import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createComputerUse, type ControlGate } from "./computer-use";
import type { IntentGate } from "./computer-use-intent";
import {
  describeAction,
  isCommitPoint,
  type ProposedAction,
} from "./intent-check";
import { scriptedGuest } from "../../test/fixtures/scripted-guest";

const shop = { pid: 7, window_id: 101, app_name: "Chromium", title: "Shop" };
const help = { pid: 8, window_id: 102, app_name: "Help", title: "Help" };

const LOGIN_PAGE = "https://github.com:8443/login";

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
  await computer.run({ action: "click", element: 3 }, BACKGROUND_CONTEXT, gate);

  expect(seen[0]!.steps[0]!.target?.name).toBe("Pay now");
  expect(calls.find((each) => each.tool === "click")?.args).toEqual({
    session: "crumble-desktop",
    pid: 7,
    window_id: 101,
    element_token: "s1:3",
  });
});

test("open reaches the check with its URL and host, and a refusal keeps the page closed", async () => {
  const { shell, calls } = scriptedGuest({ list_windows: [{ windows: [] }] });
  const { seen, gate } = recording("REFUSED");
  const computer = createComputerUse(shell);

  const result = await computer.run(
    { action: "open", url: "https://shop.example:8443/pay?amount=5" },
    BACKGROUND_CONTEXT,
    gate,
  );

  expect(seen[0]!.host).toBe("shop.example");
  expect(seen[0]!.steps).toEqual([
    { action: "open", url: "https://shop.example:8443/pay?amount=5" },
  ]);
  expect(describeAction(seen[0]!)).toBe(
    'Open "https://shop.example:8443/pay?amount=5" on shop.example',
  );
  expect(result.isError).toBe(true);
  expect(calls.map((call) => call.tool)).not.toContain("browser_navigate");
});

test("launch reaches the check without needing a window", async () => {
  const { shell } = scriptedGuest({ list_windows: [{ windows: [] }] });
  const { seen, gate } = recording("REFUSED");

  await createComputerUse(shell).run(
    { action: "launch", app: "Files", path: "/workspace/demo" },
    BACKGROUND_CONTEXT,
    gate,
  );

  expect(describeAction(seen[0]!)).toBe('Launch "Files" at "/workspace/demo"');
});

test("fill_login reaches the check with the login, the field, and the host, on the page of the latest read", async () => {
  const { shell } = scriptedGuest({
    list_windows: [{ windows: [shop] }],
    get_browser_state: [
      {
        target_id: "bt-1",
        tabs: [{ tab_id: "tab-1", url: LOGIN_PAGE, active: true }],
      },
      {
        page: { title: "Sign in", url: LOGIN_PAGE },
        outline: '- form\n  - textbox "Password"',
        refs: [
          { ref: "p1:2", role: "textbox", name: "Password", frame: "main" },
        ],
      },
    ],
  });

  const { seen, gate } = recording("REFUSED");
  const computer = createComputerUse(shell);

  await computer.run({ action: "read" }, BACKGROUND_CONTEXT);
  await computer.run(
    { action: "fill_login", login: "github", field: "password", ref: "p1:2" },
    BACKGROUND_CONTEXT,
    gate,
  );

  expect(describeAction(seen[0]!)).toBe(
    'Fill password of login "github" into textbox "Password" on github.com',
  );
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

  expect(result).toEqual({
    content: [
      {
        type: "text",
        text: "Control changed hands: the owner used the bot desktop and handed it back. The screen may have changed and element numbers are stale. Capture before acting.",
      },
    ],
    isError: true,
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

  expect(ran).toEqual({
    content: [
      {
        type: "text",
        text: "effect: confirmed | delivery: background | Clicked [3]",
      },
    ],
    isError: false,
    usage,
  });
  expect(refused).toEqual({
    content: [{ type: "text", text: "REFUSED: declined" }],
    isError: true,
    usage,
  });

  const read = await computer.run(
    { action: "capture" },
    BACKGROUND_CONTEXT,
    async () => ({ usage }),
  );

  expect(read.usage).toBeUndefined();
});

test("a terminal Enter reaches the judge with the command it runs; Enter in another app still is a commit point", async () => {
  const terminal = {
    pid: 9,
    window_id: 103,
    app_name: "Xfce4-terminal",
    title: "Terminal",
  };

  const { shell, state } = scriptedGuest({
    list_windows: [{ windows: [terminal, help] }],
    run_steps: [{ steps: [], failed_step: null, total: 2 }],
  });

  state.terminalText = "total 0\nroot@box:/workspace# rm -rf ";

  const { seen, gate } = recording("REFUSED: held");
  const tool = createComputerUse(shell);

  await tool.run(
    {
      action: "steps",
      window_id: 103,
      steps: [
        { action: "type", text: "demo" },
        { action: "key", keys: "Return" },
      ],
    },
    BACKGROUND_CONTEXT,
    gate,
  );
  await tool.run(
    { action: "key", keys: "Return", window_id: 102 },
    BACKGROUND_CONTEXT,
    gate,
  );

  expect(seen[0]).toMatchObject({
    terminal: true,
    command: "root@box:/workspace# rm -rf demo",
  });
  expect(describeAction(seen[0]!)).toContain(
    'in a terminal, running "root@box:/workspace# rm -rf demo"',
  );
  expect(isCommitPoint(seen[0]!, {})).toBe(false);
  expect(seen[1]!.terminal).toBeUndefined();
  expect(isCommitPoint(seen[1]!, {})).toBe(true);
});
