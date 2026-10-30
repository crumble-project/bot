import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createComputerUse } from "./computer-use";
import { scriptedGuest } from "../../test/fixtures/scripted-guest";

const windows = {
  windows: [
    { pid: 7, window_id: 101, app_name: "Chromium", title: "Form - Chromium" },
    { pid: 9, window_id: 303, app_name: "Zenity", title: "Ask" },
  ],
};

const tab = (tab_id: string, url: string, title: string, active = true) => ({
  tab_id,
  url,
  title,
  active,
});

const bound = (...tabs: ReturnType<typeof tab>[]) => ({
  target_id: "bt-1",
  tabs,
});

const formRead = {
  page: { title: "Den task", url: "http://127.0.0.1:8123/task.html" },
  outline: '- form\n  - textbox "Name": Ada',
  refs: [
    {
      ref: "p1:0",
      role: "textbox",
      name: "Name",
      value: "Ada",
      frame: "main",
      states: { focused: true, focusable: true, editable: "plaintext" },
    },
    { ref: "p1:1", role: "button", name: "Submit", frame: "main" },
  ],
  snapshot: { continuation: null },
};

const consent = {
  status: "refused",
  refusal: { code: "browser_consent_required", message: "not attached" },
};

const fast = { pollMs: 1, timeoutMs: 200 };

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.flatMap((c) => (c.type === "text" ? [c.text!] : [])).join("\n");

test("read binds the active tab and lists the page with its refs", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_browser_state: [
      bound(
        tab("tab-1", "https://a.example/", "A", false),
        tab("tab-2", "http://127.0.0.1:8123/task.html", "Den task"),
      ),
      formRead,
    ],
  });

  const result = await createComputerUse(shell).run(
    { action: "read", query: "Name" },
    BACKGROUND_CONTEXT,
  );

  const reads = calls.filter((c) => c.tool === "get_browser_state");

  expect(result.isError).toBe(false);
  expect(reads[0]!.args).toMatchObject({ pid: 7, window_id: 101 });
  expect(reads[1]!.args).toMatchObject({
    target_id: "bt-1",
    tab_id: "tab-2",
    snapshot_format: "semantic_v2",
    query: "Name",
  });
  expect(text(result)).toBe(
    [
      'page "Den task" http://127.0.0.1:8123/task.html',
      '- form\n  - textbox "Name": Ada',
      "elements (act with ref):",
      '[p1:0] textbox "Name" = "Ada" (focused)',
      '[p1:1] button "Submit"',
    ].join("\n"),
  );
});

test("the first page action of a session attaches Chromium once and says so", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      { snapshot_id: "s1", tree_markdown: '- [1] button "Go"' },
    ],
    get_browser_state: [
      consent,
      bound(tab("tab-1", "http://127.0.0.1:8123/task.html", "Den task")),
      formRead,
      bound(tab("tab-1", "http://127.0.0.1:8123/task.html", "Den task")),
      formRead,
    ],
    browser_prepare: [{ status: "ok", prepared: true }],
    click: [{ effect: "confirmed" }],
  });

  const tool = createComputerUse(shell);

  await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  const first = await tool.run({ action: "read" }, BACKGROUND_CONTEXT);
  const second = await tool.run({ action: "read" }, BACKGROUND_CONTEXT);

  const staleElement = await tool.run(
    { action: "click", element: 1 },
    BACKGROUND_CONTEXT,
  );

  expect(calls.filter((c) => c.tool === "browser_prepare")).toEqual([
    {
      tool: "browser_prepare",
      args: expect.objectContaining({
        pid: 7,
        window_id: 101,
        strategy: { kind: "existing_profile" },
      }),
    },
  ]);
  expect(text(first)).toStartWith(
    "Chromium was attached for page actions; accessibility element numbers are stale.",
  );
  expect(text(second)).not.toContain("attached");
  expect(text(staleElement)).toContain("capture first");
});

test("a page action after Chromium restarted attaches again", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_browser_state: [
      bound(tab("tab-1", "https://a.example/", "A")),
      formRead,
      consent,
      bound(tab("tab-9", "https://a.example/", "A")),
      formRead,
    ],
    browser_prepare: [{ status: "ok", prepared: true }],
  });

  const tool = createComputerUse(shell);

  await tool.run({ action: "read" }, BACKGROUND_CONTEXT);

  const again = await tool.run({ action: "read" }, BACKGROUND_CONTEXT);

  expect(again.isError).toBe(false);
  expect(calls.filter((c) => c.tool === "browser_prepare")).toHaveLength(1);
  expect(
    calls.filter((c) => c.tool === "get_browser_state").at(-1)!.args,
  ).toMatchObject({ tab_id: "tab-9" });
});

test("open navigates and waits for the new page before reading it", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_browser_state: [
      bound(tab("tab-1", "about:blank", "about:blank")),
      bound(tab("tab-1", "http://127.0.0.1:8123/task.html", "about:blank")),
      bound(tab("tab-1", "http://127.0.0.1:8123/task.html", "Den task")),
      formRead,
    ],
    browser_navigate: [{ status: "ok", refs_invalidated: true }],
  });

  const result = await createComputerUse(shell, { pageLoad: fast }).run(
    { action: "open", url: "http://127.0.0.1:8123/task.html" },
    BACKGROUND_CONTEXT,
  );

  expect(calls.find((c) => c.tool === "browser_navigate")!.args).toMatchObject({
    target_id: "bt-1",
    tab_id: "tab-1",
    url: "http://127.0.0.1:8123/task.html",
  });
  expect(calls.filter((c) => c.tool === "get_browser_state")).toHaveLength(4);
  expect(text(result)).toStartWith(
    'page "Den task" http://127.0.0.1:8123/task.html',
  );
});

test("open gives up waiting at the limit and says the page may still be loading", async () => {
  const { shell } = scriptedGuest({
    list_windows: [windows],
    get_browser_state: [bound(tab("tab-1", "about:blank", "about:blank"))],
    browser_navigate: [{ status: "ok" }],
  });

  const result = await createComputerUse(shell, { pageLoad: fast }).run(
    { action: "open", url: "https://slow.example/" },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(false);
  expect(text(result)).toStartWith("The page may still be loading.");
});

test("open takes only web URLs", async () => {
  const { shell, calls } = scriptedGuest({ list_windows: [windows] });

  const result = await createComputerUse(shell).run(
    { action: "open", url: "file:///etc/passwd" },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(true);
  expect(calls.some((c) => c.tool === "browser_navigate")).toBe(false);
});

test("a long page is cut with a hint to narrow the read", async () => {
  const { shell } = scriptedGuest({
    list_windows: [windows],
    get_browser_state: [
      bound(tab("tab-1", "https://wiki.example/", "Wiki")),
      { ...formRead, outline: "x".repeat(20_000) },
    ],
  });

  const result = await createComputerUse(shell).run(
    { action: "read" },
    BACKGROUND_CONTEXT,
  );

  expect(text(result)).toEndWith(
    "[page cut at 12000 characters; read with query or ref]",
  );
});

test("page actions refuse a window that isn't Chromium", async () => {
  const { shell, calls } = scriptedGuest({ list_windows: [windows] });

  const result = await createComputerUse(shell).run(
    { action: "read", window_id: 303 },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(true);
  expect(text(result)).toContain("Chromium only");
  expect(calls.some((c) => c.tool === "get_browser_state")).toBe(false);
});

const pageGuest = (extra: Record<string, object[]> = {}) =>
  scriptedGuest({
    list_windows: [windows],
    get_browser_state: [
      bound(tab("tab-1", "http://127.0.0.1:8123/task.html", "Den task")),
      {
        ...formRead,
        refs: [
          ...formRead.refs,
          { ref: "p1:2", role: "combobox", name: "City", frame: "main" },
        ],
      },
      bound(tab("tab-1", "http://127.0.0.1:8123/task.html", "Den task")),
    ],
    ...extra,
  });

const ids = { session: "crumble-desktop", target_id: "bt-1", tab_id: "tab-1" };

test("ref actions map to cua-driver's page tools", async () => {
  const { shell, calls } = pageGuest({
    browser_click: [{ effect: "unverifiable", summary: "clicked" }],
    browser_pointer: [{ effect: "unverifiable" }],
    browser_type: [{ effect: "unverifiable" }],
    browser_select: [{ changed: true }],
  });

  const tool = createComputerUse(shell);

  const run = (args: Parameters<typeof tool.run>[0]) =>
    tool.run(args, BACKGROUND_CONTEXT);

  await run({ action: "read" });
  await run({ action: "click", ref: "p1:1" });
  await run({ action: "double_click", ref: "p1:1" });
  await run({ action: "right_click", ref: "p1:1" });
  await run({ action: "scroll", ref: "p1:1", direction: "up", amount: 2 });
  await run({ action: "type", ref: "p1:0", text: " Lovelace" });
  await run({ action: "set_value", ref: "p1:0", value: "Grace" });
  await run({ action: "set_value", ref: "p1:2", value: "Berlin" });

  const page = calls
    .filter((c) => c.tool.startsWith("browser_"))
    .map(({ tool, args }) => ({ tool, args }));

  expect(page).toEqual([
    {
      tool: "browser_click",
      args: { ...ids, ref: "p1:1", delivery_mode: "foreground" },
    },
    {
      tool: "browser_pointer",
      args: {
        ...ids,
        ref: "p1:1",
        delivery_mode: "foreground",
        action: "double_click",
      },
    },
    {
      tool: "browser_pointer",
      args: {
        ...ids,
        ref: "p1:1",
        delivery_mode: "foreground",
        action: "right_click",
      },
    },
    {
      tool: "browser_pointer",
      args: {
        ...ids,
        ref: "p1:1",
        delivery_mode: "foreground",
        action: "scroll",
        delta_y: -200,
      },
    },
    { tool: "browser_type", args: { ...ids, ref: "p1:0", text: " Lovelace" } },
    {
      tool: "browser_type",
      args: { ...ids, ref: "p1:0", text: "Grace", replace: true },
    },
    { tool: "browser_select", args: { ...ids, ref: "p1:2", label: "Berlin" } },
  ]);
});

test("a stale ref returns cua-driver's refusal", async () => {
  const { shell } = pageGuest({
    browser_click: [
      {
        status: "refused",
        refusal: {
          code: "stale_ref",
          message: "ref p1:1 is stale; call get_browser_state again",
        },
      },
    ],
  });

  const tool = createComputerUse(shell);

  await tool.run({ action: "read" }, BACKGROUND_CONTEXT);

  const result = await tool.run(
    { action: "click", ref: "p1:1" },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(true);
  expect(text(result)).toContain("REFUSED (stale_ref)");
  expect(text(result)).toContain("call read again");
});

test("capture_after on a ref action returns a read of the page", async () => {
  const page = bound(
    tab("tab-1", "http://127.0.0.1:8123/task.html", "Den task"),
  );

  const { shell } = scriptedGuest({
    list_windows: [windows],
    get_browser_state: [page, formRead, page, formRead],
    browser_click: [{ effect: "unverifiable", summary: "clicked" }],
  });

  const tool = createComputerUse(shell);

  await tool.run({ action: "read" }, BACKGROUND_CONTEXT);

  const result = await tool.run(
    { action: "click", ref: "p1:1", capture_after: true },
    BACKGROUND_CONTEXT,
  );

  expect(text(result)).toContain('page "Den task"');
  expect(text(result)).toContain("delivery: page");
});

test("an action takes an element or a ref, not both", async () => {
  const { shell, calls } = pageGuest();

  const result = await createComputerUse(shell).run(
    { action: "click", ref: "p1:1", element: 4 },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(true);
  expect(calls.some((c) => c.tool === "browser_click")).toBe(false);
});

test("a ref action before any read asks for one, and acts without binding again", async () => {
  const { shell, calls } = pageGuest({
    browser_click: [{ effect: "unverifiable", summary: "clicked" }],
  });

  const tool = createComputerUse(shell);

  const early = await tool.run(
    { action: "click", ref: "p1:1" },
    BACKGROUND_CONTEXT,
  );

  await tool.run({ action: "read" }, BACKGROUND_CONTEXT);
  await tool.run({ action: "click", ref: "p1:1" }, BACKGROUND_CONTEXT);

  expect(early.isError).toBe(true);
  expect(text(early)).toContain("read the page first");
  // Binding again would supersede the read's refs.
  expect(calls.filter((c) => c.tool === "get_browser_state")).toHaveLength(2);
});
