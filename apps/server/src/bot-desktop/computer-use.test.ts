import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createComputerUse } from "./computer-use";
import type { ControlState } from "./desktop-control";
import { scriptedGuest } from "../../test/fixtures/scripted-guest";

const windows = {
  windows: [
    { pid: 7, window_id: 101, app_name: "Chromium", title: "Form - Chromium" },
    { pid: 8, window_id: 202, app_name: "Tint2", title: "tint2" },
  ],
};

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.flatMap((c) => (c.type === "text" ? [c.text!] : [])).join("\n");

test("capture returns the focused window's tree, then a diff", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      {
        snapshot_id: "s1",
        tree_markdown:
          '- [0] frame "Form"\n  - [1] panel "￼￼" [actions=[doDefault,showContextMenu]]\n  - [2] entry "Name" [actions=[activate]]',
      },
      {
        snapshot_id: "s2",
        tree_diff:
          'since s1: 0 added, 1 changed\n~ [2] entry "Name" value "Ada"',
        since_status: "diff",
      },
    ],
  });

  const cu = createComputerUse(shell);

  const first = await cu.run({ action: "capture" }, BACKGROUND_CONTEXT);
  expect(text(first)).toContain('window 101 Chromium "Form - Chromium"');
  expect(text(first)).toContain('[2] entry "Name"');
  expect(text(first)).not.toContain("￼");
  expect(text(first)).not.toContain("showContextMenu");
  expect(text(first)).not.toContain("Tint2");

  const second = await cu.run({ action: "capture" }, BACKGROUND_CONTEXT);
  expect(text(second)).toContain('~ [2] entry "Name" value "Ada"');
  expect(
    calls.filter((c) => c.tool === "get_window_state")[1]!.args,
  ).toMatchObject({ since: "s1" });
});

test("input tries background first, then foreground when cua-driver asks for it", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      { snapshot_id: "s1", tree_markdown: '- [2] entry "Name"' },
    ],
    type_text: [
      {
        code: "background_unavailable",
        escalation: { recommended: "foreground" },
      },
      { effect: "unverifiable", summary: "Typed 3 characters" },
    ],
  });

  const cu = createComputerUse(shell);

  await cu.run({ action: "capture" }, BACKGROUND_CONTEXT);

  const result = await cu.run(
    { action: "type", element: 2, text: "Ada" },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(false);
  expect(text(result)).toContain("delivery: foreground");
  const typed = calls.filter((c) => c.tool === "type_text");
  expect(typed[0]!.args["delivery_mode"]).toBeUndefined();
  expect(typed[1]!.args).toMatchObject({
    delivery_mode: "foreground",
    element_token: "s1:2",
    session: expect.any(String),
  });
});

test("placeholder arguments count as unset", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [{ snapshot_id: "s1", tree_markdown: "- [0] frame" }],
  });

  const cu = createComputerUse(shell);

  const result = await cu.run(
    {
      action: "capture",
      window_id: 0,
      element: 0,
      coordinate: [0, 0],
      text: "",
      keys: "",
      value: "",
      seconds: 0,
      name: "",
    },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(false);
  expect(calls.find((c) => c.tool === "get_window_state")!.args).toMatchObject({
    window_id: 101,
  });
});

test("a refused action is an error with cua-driver's reason, and hints name only our actions", async () => {
  const { shell } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      { snapshot_id: "s1", tree_markdown: '- [3] combo box "City"' },
    ],
    set_value: [
      {
        status: "refused",
        refusal: {
          code: "no_activation",
          message: 'option "Berlin" advertises no activation action',
        },
      },
    ],
    click: [
      {
        effect: "unverifiable",
        summary: "Clicked element [3]",
        hint: "Read what changed with get_window_state. Three single actions in a row: send them as one run_steps call.",
      },
    ],
  });

  const cu = createComputerUse(shell);
  await cu.run({ action: "capture" }, BACKGROUND_CONTEXT);

  const refused = await cu.run(
    { action: "set_value", element: 3, value: "Berlin" },
    BACKGROUND_CONTEXT,
  );

  expect(refused.isError).toBe(true);
  expect(text(refused)).toContain("advertises no activation action");

  const clicked = await cu.run(
    { action: "click", element: 3 },
    BACKGROUND_CONTEXT,
  );

  expect(text(clicked)).toContain("Read what changed with capture.");
  expect(text(clicked)).not.toContain("run_steps");
});

test("vision captures attach a JPEG screenshot", async () => {
  const { shell } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      {
        snapshot_id: "s1",
        tree_markdown: "- [0] frame",
        screenshot_width: 1280,
        screenshot_height: 770,
      },
    ],
  });

  const cu = createComputerUse(shell);

  const result = await cu.run(
    { action: "capture", mode: "vision" },
    BACKGROUND_CONTEXT,
  );

  expect(
    result.content.some(
      (c) => c.type === "image" && c.mimeType === "image/jpeg",
    ),
  ).toBe(true);
  expect(text(result)).toContain("screenshot 1280x770");
});

test("acting before any capture asks for one", async () => {
  const { shell } = scriptedGuest({ list_windows: [windows] });
  const cu = createComputerUse(shell);

  const result = await cu.run(
    { action: "click", element: 4 },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(true);
  expect(text(result)).toContain("capture first");
});

test("a screenshot that fails to convert attaches no image, and no files are left behind", async () => {
  const guest = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      {
        snapshot_id: "s1",
        tree_markdown: "- [0] frame",
        screenshot_width: 1280,
        screenshot_height: 770,
      },
    ],
  });

  const tool = createComputerUse(guest.shell);

  const first = await tool.run(
    { action: "capture", mode: "vision" },
    BACKGROUND_CONTEXT,
  );

  expect(first.content.some((c) => c.type === "image")).toBe(true);

  guest.state.failConvert = true;

  const second = await tool.run(
    { action: "capture", mode: "vision" },
    BACKGROUND_CONTEXT,
  );

  expect(second.content.some((c) => c.type === "image")).toBe(false);
  expect([...guest.files.keys()]).toEqual([]);
});

test("set_value with an empty value clears the field", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      { snapshot_id: "s1", tree_markdown: '- [2] entry "Name"' },
    ],
    set_value: [{ effect: "confirmed", summary: "Cleared [2]" }],
  });

  const tool = createComputerUse(shell);

  await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  const result = await tool.run(
    { action: "set_value", element: 2, value: "" },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(false);
  expect(calls.find((c) => c.tool === "set_value")?.args).toMatchObject({
    value: "",
  });
});

test("an ended cua-driver session is replaced and the call retried", async () => {
  const ended = {
    error:
      "session has ended; tool call 'list_windows' was rejected. Call start_session with session 'x' to start it again, or use a new session label.",
  };

  const { shell, calls } = scriptedGuest({
    list_windows: [ended, windows],
    get_window_state: [{ snapshot_id: "s1", tree_markdown: "- [0] frame" }],
  });

  const tool = createComputerUse(shell);
  const result = await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  expect(result.isError).toBe(false);
  expect(text(result)).toContain("window 101");

  const sessions = calls
    .filter((c) => c.tool === "list_windows")
    .map((c) => c.args["session"]);

  expect(sessions[0]).not.toBe(sessions[1]);
});

test("a failed window listing reports cua-driver's error, not an empty desktop", async () => {
  const { shell } = scriptedGuest({
    list_windows: [{ error: "cua-driver daemon is not running" }],
  });

  const result = await createComputerUse(shell).run(
    { action: "list_windows" },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(true);
  expect(text(result)).toContain("cua-driver daemon is not running");
});

/** A control lease the test hands between bot and owner. */
class FakeGate {
  state: ControlState = { holder: "bot", changes: 0, updatedAt: "" };
  private readonly waiting: (() => void)[] = [];

  untilBot = async () => {
    while (this.state.holder !== "bot")
      await new Promise<void>((resume) => this.waiting.push(resume));

    return this.state;
  };

  set(holder: ControlState["holder"]) {
    this.state = { ...this.state, holder, changes: this.state.changes + 1 };

    for (const resume of this.waiting.splice(0)) resume();
  }
}

test("actions wait while the owner holds control, and a plan from before is refused", async () => {
  const gate = new FakeGate();

  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      { snapshot_id: "s1", tree_markdown: '- [2] entry "Name"' },
    ],
    set_value: [{ effect: "confirmed" }],
  });

  const tool = createComputerUse(shell, gate);

  await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);
  gate.set("owner");

  let done = false;

  const pending = tool
    .run({ action: "set_value", element: 2, value: "Ada" }, BACKGROUND_CONTEXT)
    .then((result) => {
      done = true;

      return result;
    });

  await Bun.sleep(50);
  expect(done).toBe(false);

  gate.set("bot");

  const result = await pending;

  expect(result.isError).toBe(true);
  expect(text(result)).toContain("Capture before acting");
  expect(calls.some((c) => c.tool === "set_value")).toBe(false);

  // The old snapshot is gone: the next capture is a full read, not a diff.
  const fresh = await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  expect(fresh.isError).toBe(false);
  expect(
    calls.filter((c) => c.tool === "get_window_state").at(-1)?.args["since"],
  ).toBeUndefined();
});

test("without a change of control, actions run as before", async () => {
  const gate = new FakeGate();

  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      { snapshot_id: "s1", tree_markdown: '- [2] entry "Name"' },
    ],
    set_value: [{ effect: "confirmed" }],
  });

  const tool = createComputerUse(shell, gate);

  await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  const result = await tool.run(
    { action: "set_value", element: 2, value: "Ada" },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(false);
  expect(calls.some((c) => c.tool === "set_value")).toBe(true);
});
