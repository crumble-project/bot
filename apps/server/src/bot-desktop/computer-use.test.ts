import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createComputerUse } from "./computer-use";
import { ACTIONS, ACTION_NAMES, effectOf } from "./computer-use-actions";
import { normalize } from "./computer-use-args";
import { STEP_ACTION_NAMES } from "./computer-use-steps";
import type { ControlState } from "./desktop-control";
import { scriptedGuest } from "../../test/fixtures/scripted-guest";

const windows = {
  windows: [
    { pid: 7, window_id: 101, app_name: "Chromium", title: "Form - Chromium" },
    { pid: 8, window_id: 202, app_name: "Xfce4-panel", title: "xfce4-panel" },
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
  expect(text(first)).toBe(
    [
      'window 101 Chromium "Form - Chromium" (snapshot s1)',
      '- [0] frame "Form"',
      '  - [1] panel "" [actions=[doDefault]]',
      '  - [2] entry "Name" [actions=[activate]]',
    ].join("\n"),
  );

  const second = await cu.run({ action: "capture" }, BACKGROUND_CONTEXT);
  expect(text(second)).toBe(
    [
      'window 101 Chromium "Form - Chromium" (snapshot s2, changes since s1)',
      "since s1: 0 added, 1 changed",
      '~ [2] entry "Name" value "Ada"',
    ].join("\n"),
  );
  expect(calls.filter((c) => c.tool === "get_window_state")[1]!.args).toEqual({
    session: "crumble-desktop",
    pid: 7,
    window_id: 101,
    include_screenshot: false,
    since: "s1",
  });
});

test("a long tree is cut, and a refused capture reports cua-driver's reason", async () => {
  const { shell } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      {
        snapshot_id: "s1",
        tree_markdown: `- [0] frame "Form" ${"x".repeat(13_000)}`,
        truncated: true,
      },
      {
        status: "refused",
        refusal: { code: "window_gone", message: "window 101 closed" },
      },
    ],
  });

  const tool = createComputerUse(shell);

  const first = await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  expect(text(first)).toContain("[tree cut at 12000 characters");
  expect(text(first)).toContain("tree truncated: capture with full=true");

  const second = await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  expect(second.isError).toBe(false);
  expect(text(second)).toBe("capture failed: window 101 closed");
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
  expect(text(result)).toBe(
    "effect: unverifiable | delivery: foreground | Typed 3 characters",
  );

  const typed = {
    session: "crumble-desktop",
    pid: 7,
    window_id: 101,
    element_token: "s1:2",
    text: "Ada",
  };

  expect(
    calls.filter((c) => c.tool === "type_text").map((c) => c.args),
  ).toEqual([typed, { ...typed, delivery_mode: "foreground" }]);
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
    },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(false);
  expect(calls.find((c) => c.tool === "get_window_state")!.args).toEqual({
    session: "crumble-desktop",
    pid: 7,
    window_id: 101,
    include_screenshot: false,
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
  expect(text(refused)).toBe(
    'REFUSED (no_activation) | delivery: background | option "Berlin" advertises no activation action',
  );

  const clicked = await cu.run(
    { action: "click", element: 3 },
    BACKGROUND_CONTEXT,
  );

  expect(text(clicked)).toBe(
    "effect: unverifiable | delivery: background | Clicked element [3] | hint: Read what changed with capture.",
  );
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
    result.content.map((c) =>
      c.type === "image" ? { type: c.type, mimeType: c.mimeType } : c,
    ),
  ).toEqual([
    {
      type: "text",
      text: 'window 101 Chromium "Form - Chromium" (snapshot s1)\n- [0] frame',
    },
    {
      type: "text",
      text: "screenshot 1280x770, coordinates are pixels of this image",
    },
    { type: "image", mimeType: "image/jpeg" },
  ]);
});

test("acting before any capture asks for one", async () => {
  const { shell } = scriptedGuest({ list_windows: [windows] });
  const cu = createComputerUse(shell);

  const result = await cu.run(
    { action: "click", element: 4 },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(true);
  expect(text(result)).toBe(
    "error: no capture of this window yet; capture first",
  );
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

  expect(first.content.map((c) => c.type)).toEqual(["text", "text", "image"]);

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
  expect(calls.find((c) => c.tool === "set_value")?.args).toEqual({
    session: "crumble-desktop",
    pid: 7,
    window_id: 101,
    element_token: "s1:2",
    value: "",
  });
});

test("an ended cua-driver session is started again and the call retried", async () => {
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
  expect(text(result)).toBe(
    'window 101 Chromium "Form - Chromium" (snapshot s1)\n- [0] frame',
  );

  expect(calls.slice(0, 3).map((c) => [c.tool, c.args["session"]])).toEqual([
    ["list_windows", "crumble-desktop"],
    ["start_session", "crumble-desktop"],
    ["list_windows", "crumble-desktop"],
  ]);
});

test("the window listing leaves out the XFCE panel", async () => {
  const { shell } = scriptedGuest({ list_windows: [windows] });

  const result = await createComputerUse(shell).run(
    { action: "list_windows" },
    BACKGROUND_CONTEXT,
  );

  expect(text(result)).toContain("Chromium");
  expect(text(result)).not.toContain("xfce4-panel");
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
  expect(text(result)).toBe("error: cua-driver daemon is not running");
});

test("each input action reaches cua-driver with its own arguments", async () => {
  const { shell, calls } = scriptedGuest({ list_windows: [windows] });
  const tool = createComputerUse(shell);

  await tool.run({ action: "click", coordinate: [10, 20] }, BACKGROUND_CONTEXT);

  await tool.run(
    {
      action: "drag",
      from_coordinate: [1, 2],
      to_coordinate: [3, 4],
    },
    BACKGROUND_CONTEXT,
  );

  await tool.run(
    { action: "scroll", coordinate: [5, 6], direction: "up", amount: 2 },
    BACKGROUND_CONTEXT,
  );

  await tool.run({ action: "key", keys: "ctrl+l" }, BACKGROUND_CONTEXT);
  await tool.run({ action: "key", keys: "Return" }, BACKGROUND_CONTEXT);
  await tool.run({ action: "focus_window" }, BACKGROUND_CONTEXT);

  const argsOf = (name: string) => calls.find((c) => c.tool === name)!.args;

  const desk = { session: "crumble-desktop", pid: 7, window_id: 101 };

  expect(argsOf("click")).toEqual({ ...desk, x: 10, y: 20 });
  expect(argsOf("drag")).toEqual({
    ...desk,
    from_x: 1,
    from_y: 2,
    to_x: 3,
    to_y: 4,
  });
  expect(argsOf("scroll")).toEqual({
    ...desk,
    x: 5,
    y: 6,
    direction: "up",
    amount: 2,
  });
  expect(argsOf("hotkey")).toEqual({ ...desk, keys: ["ctrl", "l"] });
  expect(argsOf("press_key")).toEqual({ ...desk, key: "return" });
  expect(argsOf("bring_to_front")).toEqual(desk);
});

test("capture_after appends a capture of the target window", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [{ snapshot_id: "s1", tree_markdown: "- [0] frame" }],
    click: [{ effect: "confirmed" }],
  });

  const tool = createComputerUse(shell);

  await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  const result = await tool.run(
    { action: "click", element: 1, capture_after: true },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(false);
  expect(text(result)).toContain("window 101 Chromium");
  expect(calls.filter((c) => c.tool === "get_window_state")).toHaveLength(2);
});

test("an unknown action is refused with its name", async () => {
  const { shell, calls } = scriptedGuest({ list_windows: [windows] });

  const result = await createComputerUse(shell).run(
    { action: "hover" },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(true);
  expect(text(result)).toBe("unknown action hover");
  expect(calls.some((c) => c.tool !== "list_windows")).toBe(false);
});

test("wait pauses for the given seconds and reports them", async () => {
  const { shell } = scriptedGuest({});

  const result = await createComputerUse(shell).run(
    { action: "wait", seconds: 0.01 },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(false);
  expect(text(result)).toBe("waited 0.01s");
});

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

  const tool = createComputerUse(shell, { gate });

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
  expect(text(result)).toBe(
    "Control changed hands: the owner used the bot desktop and handed it back. The screen may have changed and element numbers are stale. Capture before acting.",
  );
  expect(calls.some((c) => c.tool === "set_value")).toBe(false);

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

  const tool = createComputerUse(shell, { gate });

  await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  const result = await tool.run(
    { action: "set_value", element: 2, value: "Ada" },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(false);
  expect(calls.find((c) => c.tool === "set_value")?.args).toEqual({
    session: "crumble-desktop",
    pid: 7,
    window_id: 101,
    element_token: "s1:2",
    value: "Ada",
  });
});

test("cua-driver arguments reach it on stdin, never in a file or a command line", async () => {
  const guest = scriptedGuest({
    list_windows: [windows],
    type_text: [{ effect: "confirmed", summary: "Typed" }],
  });

  const tool = createComputerUse(guest.shell);

  await tool.run({ action: "type", text: "hunter2" }, BACKGROUND_CONTEXT);

  expect(guest.calls.find((c) => c.tool === "type_text")?.args).toEqual({
    session: "crumble-desktop",
    pid: 7,
    window_id: 101,
    text: "hunter2",
  });
  expect(guest.writes).toEqual([]);
  expect(guest.commands.some((command) => command.includes("hunter2"))).toBe(
    false,
  );
});

test("a capture with a query reads only matching elements, and the next plain capture reads the whole tree", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      { snapshot_id: "s1", tree_markdown: '- [0] frame "Form"' },
      { snapshot_id: "s2", tree_markdown: '- [7] row header "Born"' },
      { snapshot_id: "s3", tree_markdown: '- [0] frame "Form"' },
    ],
    click: [{ effect: "confirmed", summary: "Clicked [7]" }],
  });

  const tool = createComputerUse(shell);

  await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  const queried = await tool.run(
    { action: "capture", query: "Born" },
    BACKGROUND_CONTEXT,
  );

  await tool.run({ action: "click", element: 7 }, BACKGROUND_CONTEXT);
  await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  const reads = calls.filter((c) => c.tool === "get_window_state");

  const read = {
    session: "crumble-desktop",
    pid: 7,
    window_id: 101,
    include_screenshot: false,
  };

  expect(text(queried)).toBe(
    'window 101 Chromium "Form - Chromium" (snapshot s2, elements matching "Born")\n- [7] row header "Born"',
  );
  expect(reads.map((each) => each.args)).toEqual([
    read,
    { ...read, query: "Born" },
    read,
  ]);
  expect(calls.find((c) => c.tool === "click")!.args).toEqual({
    session: "crumble-desktop",
    pid: 7,
    window_id: 101,
    element_token: "s2:7",
  });
});

const installed = {
  apps: [
    { name: "Xvnc", kind: null, launch_path: null, running: true },
    {
      name: "Mousepad",
      kind: "desktop",
      launch_path: "mousepad",
      running: false,
    },
    {
      name: "Chromium",
      kind: "desktop",
      launch_path: "/opt/crumble/browser.sh",
      running: true,
    },
  ],
};

const opened = (window: {
  window_id: number;
  app_name: string;
  title: string;
}) => ({
  windows: [...windows.windows, { pid: 9, ...window }],
});

test("launch opens Files and Terminal at a folder, and any installed app by its name", async () => {
  const { shell, commands } = scriptedGuest({
    list_windows: [
      windows,
      opened({ window_id: 303, app_name: "Thunar", title: "demo - Thunar" }),
      windows,
      opened({ window_id: 404, app_name: "Mousepad", title: "notes.txt" }),
    ],
    list_apps: [installed],
  });

  const cu = createComputerUse(shell);

  const files = await cu.run(
    { action: "launch", app: "Files", path: "/workspace/it's demo" },
    BACKGROUND_CONTEXT,
  );

  expect(files.isError).toBeFalsy();
  expect(text(files)).toBe(
    `opened Files at /workspace/it's demo: window 303 Thunar "demo - Thunar". Capture it to act in it.`,
  );

  const editor = await cu.run(
    { action: "launch", app: "mousepad", path: "/workspace/notes.txt" },
    BACKGROUND_CONTEXT,
  );

  expect(text(editor)).toContain("window 404 Mousepad");

  expect(commands.filter((command) => command.includes("setsid"))).toEqual([
    `. /run/crumble-desktop.env; setsid thunar '/workspace/it'\\''s demo' >/dev/null 2>&1 </dev/null &`,
    `. /run/crumble-desktop.env; setsid mousepad '/workspace/notes.txt' >/dev/null 2>&1 </dev/null &`,
  ]);
});

test("list_apps names the installed apps, and launch refuses an unknown app or a relative path", async () => {
  const { shell, commands } = scriptedGuest({
    list_windows: [windows],
    list_apps: [installed],
  });

  const cu = createComputerUse(shell);

  expect(text(await cu.run({ action: "list_apps" }, BACKGROUND_CONTEXT))).toBe(
    "Mousepad\nChromium (running)",
  );

  const unknown = await cu.run(
    { action: "launch", app: "GIMP" },
    BACKGROUND_CONTEXT,
  );

  expect(unknown.isError).toBe(true);
  expect(text(unknown)).toContain('no installed app named "GIMP"');

  const relative = await cu.run(
    { action: "launch", app: "Files", path: "demo" },
    BACKGROUND_CONTEXT,
  );

  expect(relative.isError).toBe(true);
  expect(commands.some((command) => command.includes("setsid"))).toBe(false);
});

test("read on a terminal window returns its text, which its tree doesn't hold", async () => {
  const terminal = {
    pid: 9,
    window_id: 103,
    app_name: "Xfce4-terminal",
    title: "Terminal",
  };

  const { shell, commands, state } = scriptedGuest({
    list_windows: [{ windows: [...windows.windows, terminal] }],
  });

  state.terminalText = "$ ls demo\nhello.js  sum.js\n$ \n";

  const read = await createComputerUse(shell).run(
    { action: "read", window_id: 103 },
    BACKGROUND_CONTEXT,
  );

  expect(text(read)).toBe(
    'terminal 103 "Terminal" text, latest last:\n$ ls demo\nhello.js  sum.js\n$',
  );
  expect(
    commands.some((command) => command.includes("windowactivate --sync 103")),
  ).toBe(true);
});

test("list_apps names each app once, running if any of its processes is", async () => {
  const { shell } = scriptedGuest({
    list_apps: [
      {
        apps: [
          {
            name: "Chromium",
            kind: "desktop",
            launch_path: "chromium",
            running: true,
          },
          {
            name: "Chromium",
            kind: "desktop",
            launch_path: "chromium",
            running: false,
          },
          {
            name: "Mousepad",
            kind: "desktop",
            launch_path: "mousepad",
            running: false,
          },
        ],
      },
    ],
  });

  expect(
    text(
      await createComputerUse(shell).run(
        { action: "list_apps" },
        BACKGROUND_CONTEXT,
      ),
    ),
  ).toBe("Chromium (running)\nMousepad");
});

test("each action's effect sets who checks it, and an action the table lacks counts as acting", () => {
  const withEffect = (effect: string) =>
    [...ACTIONS].flatMap(([name, entry]) =>
      entry.effect === effect ? [name] : [],
    );

  expect(withEffect("observe")).toEqual([
    "capture",
    "wait",
    "list_windows",
    "list_apps",
    "read",
  ]);
  expect(withEffect("act")).toEqual([
    "click",
    "double_click",
    "right_click",
    "drag",
    "type",
    "key",
    "set_value",
    "steps",
  ]);
  expect(withEffect("unchecked")).toEqual([
    "scroll",
    "focus_window",
    "launch",
    "open",
    "fill_login",
  ]);
  expect(effectOf("hover")).toBeUndefined();
});

test("the schema lists actions and steps in their published order, and every step is an action", () => {
  expect(ACTION_NAMES).toEqual([
    "capture",
    "click",
    "double_click",
    "right_click",
    "drag",
    "scroll",
    "type",
    "key",
    "set_value",
    "wait",
    "list_windows",
    "focus_window",
    "launch",
    "list_apps",
    "open",
    "read",
    "steps",
    "fill_login",
  ]);
  expect(STEP_ACTION_NAMES).toEqual([
    "click",
    "double_click",
    "right_click",
    "set_value",
    "type",
    "key",
    "scroll",
  ]);
  expect(ACTION_NAMES).toEqual(expect.arrayContaining(STEP_ACTION_NAMES));
});

test("every optional argument a model fills with a placeholder counts as unset", () => {
  expect(
    normalize({
      action: "scroll",
      direction: "",
      amount: 0,
      coordinate: [0, 0],
      query: "",
      text: "",
      value: "",
      capture_after: false,
    }),
  ).toEqual({ action: "scroll", capture_after: false });
  expect(normalize({ action: "set_value", value: "", text: "" })).toEqual({
    action: "set_value",
    value: "",
  });
  expect(normalize({ action: "type", text: "", value: "" })).toEqual({
    action: "type",
    text: "",
  });
});
