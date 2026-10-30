import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createComputerUse } from "./computer-use";
import { scriptedGuest } from "../../test/fixtures/scripted-guest";

const windows = {
  windows: [
    { pid: 7, window_id: 101, app_name: "Chromium", title: "Form - Chromium" },
  ],
};

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.flatMap((c) => (c.type === "text" ? [c.text!] : [])).join("\n");

const observation = {
  state: {
    snapshot_id: "s8",
    since: "s4",
    since_status: "diff",
    tree_diff: 'since s4: 0 added, 1 changed\n~ [26] check box "Agree"',
  },
};

test("steps run in one run_steps call in cua-driver's form", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    run_steps: [{ steps: [], failed_step: null, total: 7 }],
  });

  await createComputerUse(shell).run(
    {
      action: "steps",
      query: "Ada",
      steps: [
        { action: "key", keys: "ctrl+l" },
        { action: "type", text: "https://a.example/" },
        { action: "key", keys: "Return" },
        {
          action: "set_value",
          role: "entry",
          name: "Name",
          value: "Ada",
          wait_for: { name: "Name", timeout_ms: 8000 },
        },
        { action: "click", role: "button", name: "Submit", nth: 1 },
        { action: "scroll", direction: "up", amount: 2 },
        {
          action: "double_click",
          name: "Row",
          expect: [{ text: "Saved" }, { name: "Spinner", gone: true }],
        },
      ],
    },
    BACKGROUND_CONTEXT,
  );

  const { session: _, ...args } = calls.find(
    (c) => c.tool === "run_steps",
  )!.args;

  expect(args).toEqual({
    pid: 7,
    window_id: 101,
    foreground_fallback: true,
    steps: [
      { hotkey: { keys: ["ctrl", "l"] } },
      { type_text: { text: "https://a.example/" } },
      { press_key: { key: "return" } },
      {
        set_value: { role: "entry", name: "Name", value: "Ada" },
        wait_for: { name: "Name", timeout_ms: 8000 },
      },
      { click: { role: "button", name: "Submit", nth: 1 } },
      { scroll: { direction: "up", amount: 2 } },
      {
        double_click: { name: "Row" },
        expect: [{ text: "Saved" }, { name: "Spinner", gone: true }],
      },
    ],
    observe: { query: "Ada" },
  });
});

test("a failed step stops the batch and says which steps ran", async () => {
  const { shell } = scriptedGuest({
    list_windows: [windows],
    run_steps: [
      {
        steps: [
          {
            index: 0,
            tool: "click",
            ok: true,
            target: { element: '[26] check box "Agree"' },
          },
          {
            index: 1,
            tool: "click",
            ok: false,
            code: "not_found",
            phase: "find",
            message: 'no button "Send" in window 101',
          },
        ],
        failed_step: 1,
        total: 3,
        observation,
      },
    ],
  });

  const result = await createComputerUse(shell).run(
    {
      action: "steps",
      steps: [
        { action: "click", role: "check box", name: "Agree" },
        { action: "click", role: "button", name: "Send" },
        { action: "click", role: "button", name: "Submit" },
      ],
    },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(true);
  expect(text(result)).toStartWith(
    [
      '1 click [26] check box "Agree": ok',
      '2 click: failed (not_found, find) no button "Send" in window 101',
      "stopped at step 2 of 3; steps 1-1 ran",
      'window 101 Chromium "Form - Chromium" (snapshot s8, changes since s4)',
    ].join("\n"),
  );
});

test("the observed read becomes the window's latest snapshot", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    run_steps: [
      {
        steps: [{ index: 0, tool: "click", ok: true }],
        failed_step: null,
        total: 1,
        observation,
      },
    ],
    click: [{ effect: "confirmed" }],
    get_window_state: [{ snapshot_id: "s9", tree_diff: "since s8: nothing" }],
  });

  const tool = createComputerUse(shell);

  await tool.run(
    { action: "steps", steps: [{ action: "click", name: "Agree" }] },
    BACKGROUND_CONTEXT,
  );
  await tool.run({ action: "click", element: 26 }, BACKGROUND_CONTEXT);
  await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  expect(calls.find((c) => c.tool === "click")!.args).toMatchObject({
    element_token: "s8:26",
  });
  expect(calls.find((c) => c.tool === "get_window_state")!.args).toMatchObject({
    since: "s8",
  });
});

test("a step without what it needs is refused before anything runs", async () => {
  const { shell, calls } = scriptedGuest({ list_windows: [windows] });

  const result = await createComputerUse(shell).run(
    {
      action: "steps",
      steps: [
        { action: "key", keys: "tab" },
        { action: "click", text: "Submit" },
      ],
    },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(true);
  expect(text(result)).toBe("step 2: click needs role or name");
  expect(calls.some((c) => c.tool === "run_steps")).toBe(false);
});
