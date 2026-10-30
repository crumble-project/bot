import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { LoginField } from "../shared/domain";
import { createComputerUse } from "./computer-use";
import type {
  DesktopFill,
  DesktopFills,
  LoginFill,
  LoginRead,
} from "./computer-use-login";
import {
  scriptedGuest,
  type GuestReply,
} from "../../test/fixtures/scripted-guest";

const windows = {
  windows: [
    {
      pid: 7,
      window_id: 101,
      app_name: "Chromium",
      title: "Sign in - Chromium",
    },
  ],
};

const signIn = (url: string): GuestReply[] => [
  {
    target_id: "bt-1",
    tabs: [{ tab_id: "tab-1", url, title: "Sign in", active: true }],
  },
  {
    page: { title: "Sign in", url },
    outline: '- form\n  - textbox "Username"\n  - textbox "Password"',
    refs: [
      { ref: "p1:1", role: "textbox", name: "Username", frame: "main" },
      { ref: "p1:2", role: "textbox", name: "Password", frame: "main" },
      { ref: "p1:3", role: "button", name: "Sign in", frame: "main" },
      { ref: "p1:4", role: "textbox", name: "Card", frame: "f2" },
    ],
  },
];

type Use = Parameters<LoginFill["recordUse"]>[1] & { name: string };

/** What the bot desktop recorded as typed on it; it outlives a job. */
function fakeDesk(record: DesktopFill[] = []) {
  const fills: DesktopFills = {
    list: async () => [...record],
    add: async (fill) => {
      record.push(fill);
    },
  };

  return { fills, record };
}

/** The bot's logins: github with a username and password; `reads` answers each field. */
function fakeLogins(
  reads: Partial<Record<LoginField, LoginRead>> = {
    username: { value: "ada@example.com" },
    password: { value: "hunter2" },
  },
  desk = fakeDesk(),
) {
  const uses: Use[] = [];
  let valueReads = 0;

  const logins: LoginFill = {
    list: async () => [
      {
        name: "github",
        hosts: ["github.com"],
        fields: ["username", "password"],
      },
      {
        name: "gitlab",
        hosts: ["gitlab.com"],
        fields: ["username", "password"],
      },
      {
        name: "ada",
        hosts: ["ada.example.com"],
        fields: ["username", "password"],
      },
    ],
    read: async (_name, field) => {
      valueReads++;

      return reads[field] ?? { missing: `Login github has no ${field}` };
    },
    recordUse: async (name, use) => {
      uses.push({ name, ...use });
    },
  };

  return { logins, fills: desk.fills, uses, reads: () => valueReads };
}

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.flatMap((c) => (c.type === "text" ? [c.text!] : [])).join("\n");

async function readThenFill(
  url: string,
  args: { login?: string; field?: string; ref?: string },
  extra: Record<string, GuestReply[]> = {},
  fake = fakeLogins(),
) {
  const guest = scriptedGuest({
    list_windows: [windows],
    get_browser_state: signIn(url),
    browser_type: [{ effect: "unverifiable", summary: "typed 7 char(s)" }],
    ...extra,
  });

  const tool = createComputerUse(guest.shell, {
    logins: fake.logins,
    fills: fake.fills,
  });

  await tool.run({ action: "read" }, BACKGROUND_CONTEXT);

  const result = await tool.run(
    { action: "fill_login", ...args },
    BACKGROUND_CONTEXT,
  );

  return { result, guest, tool, ...fake };
}

const typed = (guest: ReturnType<typeof scriptedGuest>) =>
  guest.calls.filter((c) => c.tool === "browser_type");

test("fills the ref on a matching host without showing the value", async () => {
  const { result, guest, uses } = await readThenFill(
    "https://github.com/login",
    { login: "github", field: "password", ref: "p1:2" },
  );

  expect(result.isError).toBe(false);
  expect(text(result)).toBe("filled password of login github on github.com");
  expect(typed(guest)[0]!.args).toMatchObject({
    target_id: "bt-1",
    tab_id: "tab-1",
    ref: "p1:2",
    text: "hunter2",
    replace: true,
  });
  expect(uses).toEqual([
    {
      name: "github",
      at: expect.any(String),
      host: "github.com",
      field: "password",
      error: null,
    },
  ]);
});

test("the value never reaches a command line or a file in the guest", async () => {
  const { guest } = await readThenFill("https://github.com/login", {
    login: "github",
    field: "password",
    ref: "p1:2",
  });

  expect(guest.commands.some((command) => command.includes("hunter2"))).toBe(
    false,
  );
  expect(guest.writes).toEqual([]);
});

test("a page no login covers is refused with the hint to report it, and nothing is read", async () => {
  const { result, guest, reads, uses } = await readThenFill(
    "https://evil.example/login",
    { login: "github", field: "password", ref: "p1:2" },
  );

  expect(result.isError).toBe(true);
  expect(text(result)).toBe(
    "REFUSED: No login of this bot covers evil.example. Say so in your answer, naming evil.example, so the bot can ask the owner for a login.",
  );
  expect(typed(guest)).toEqual([]);
  expect(reads()).toBe(0);
  expect(uses).toEqual([]);
});

test("a login for another host names the logins that cover this one", async () => {
  const { result, guest } = await readThenFill(
    "https://gitlab.com/users/sign_in",
    {
      login: "github",
      field: "password",
      ref: "p1:2",
    },
  );

  expect(text(result)).toBe(
    "REFUSED: login github is for github.com, not gitlab.com; logins for gitlab.com: gitlab",
  );
  expect(typed(guest)).toEqual([]);
});

test("pages that aren't https are refused", async () => {
  const { result, guest } = await readThenFill("http://github.com/login", {
    login: "github",
    field: "password",
    ref: "p1:2",
  });

  expect(text(result)).toBe(
    "REFUSED: fill_login fills https pages only, and this page is http://github.com/login",
  );
  expect(typed(guest)).toEqual([]);
});

test("refs that aren't a text field of the page itself are refused", async () => {
  const fill = async (ref: string) =>
    text(
      (
        await readThenFill("https://github.com/login", {
          login: "github",
          field: "password",
          ref,
        })
      ).result,
    );

  expect(await fill("p1:3")).toBe("REFUSED: p1:3 is not a text field");
  expect(await fill("p1:4")).toBe(
    "REFUSED: fill_login fills fields of the page itself, not of embedded frames",
  );
  expect(await fill("p1:9")).toBe(
    "REFUSED: p1:9 is not in the latest read; read the page again",
  );
});

test("fill_login needs a read first", async () => {
  const guest = scriptedGuest({ list_windows: [windows] });
  const tool = createComputerUse(guest.shell, { logins: fakeLogins().logins });

  const result = await tool.run(
    { action: "fill_login", login: "github", field: "password", ref: "p1:2" },
    BACKGROUND_CONTEXT,
  );

  expect(text(result)).toBe(
    "REFUSED: read the sign-in page, then fill_login with a ref from it",
  );
});

test("an unreadable value is recorded with its error and nothing is typed", async () => {
  const { result, guest, uses } = await readThenFill(
    "https://github.com/login",
    { login: "github", field: "password", ref: "p1:2" },
    {},
    fakeLogins({ password: { unreadable: "1Password could not be reached" } }),
  );

  expect(text(result)).toBe("REFUSED: 1Password could not be reached");
  expect(typed(guest)).toEqual([]);
  expect(uses).toMatchObject([
    { field: "password", error: "1Password could not be reached" },
  ]);
});

test("a field the login doesn't have is refused without recording a use", async () => {
  const { result, uses } = await readThenFill("https://github.com/login", {
    login: "github",
    field: "one_time_code",
    ref: "p1:1",
  });

  expect(text(result)).toBe("REFUSED: Login github has no one_time_code");
  expect(uses).toEqual([]);
});

test("a typed password is replaced in every later result", async () => {
  const { tool } = await readThenFill(
    "https://github.com/login",
    { login: "github", field: "password", ref: "p1:2" },
    {
      get_window_state: [
        {
          snapshot_id: "s1",
          tree_markdown: '- [3] textbox "Password" value="hunter2"',
        },
      ],
    },
  );

  const capture = await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  expect(text(capture)).toContain('value="[login github password]"');
  expect(text(capture)).not.toContain("hunter2");
});

test("a username or one-time code is typed without being recorded or replaced", async () => {
  const desk = fakeDesk();

  const { tool } = await readThenFill(
    "https://github.com/login",
    { login: "github", field: "username", ref: "p1:1" },
    {
      get_window_state: [
        {
          snapshot_id: "s1",
          tree_markdown: '- [3] static "Signed in as ada@example.com"',
          screenshot_width: 1,
        },
      ],
    },
    fakeLogins(undefined, desk),
  );

  const capture = await tool.run(
    { action: "capture", mode: "vision" },
    BACKGROUND_CONTEXT,
  );

  expect(desk.record).toEqual([]);
  expect(text(capture)).toContain("Signed in as ada@example.com");
  expect(capture.content.some((part) => part.type === "image")).toBe(true);
});

test("a filled value is replaced even where the reply escapes it", async () => {
  const value = 'pa"ss\\word';

  const { tool } = await readThenFill(
    "https://github.com/login",
    { login: "github", field: "password", ref: "p1:2" },
    {
      get_browser_state: [
        ...signIn("https://github.com/login"),
        signIn("https://github.com/login")[0]!,
        {
          page: { title: "Sign in", url: "https://github.com/login" },
          outline: `- textbox "Password" value=${JSON.stringify(value)}`,
          refs: [
            {
              ref: "p2:1",
              role: "textbox",
              name: "Password",
              value,
              frame: "main",
            },
          ],
        },
      ],
    },
    fakeLogins({ password: { value } }),
  );

  const read = text(await tool.run({ action: "read" }, BACKGROUND_CONTEXT));

  expect(read).toContain("[login github password]");
  expect(read).not.toContain("ss\\");
});

test("captures after a password fill carry no screenshot", async () => {
  const { tool } = await readThenFill(
    "https://github.com/login",
    { login: "github", field: "password", ref: "p1:2" },
    {
      get_window_state: [
        {
          snapshot_id: "s1",
          tree_markdown: "- [0] frame",
          screenshot_width: 1,
        },
      ],
    },
  );

  const capture = await tool.run(
    { action: "capture", mode: "vision" },
    BACKGROUND_CONTEXT,
  );

  expect(capture.content.some((part) => part.type === "image")).toBe(false);
  expect(text(capture)).toContain(
    "no screenshot: a password was typed into this Chromium, and a screenshot could show it; screenshots return once Chromium restarts",
  );
});

test("a password that is part of the page's URL still lets the next field be filled", async () => {
  const fake = fakeLogins({
    username: { value: "grace" },
    password: { value: "ada" },
  });

  const { tool, guest } = await readThenFill(
    "https://ada.example.com/login",
    { login: "ada", field: "password", ref: "p1:2" },
    {
      get_browser_state: [
        ...signIn("https://ada.example.com/login"),
        ...signIn("https://ada.example.com/login"),
      ],
    },
    fake,
  );

  await tool.run({ action: "read" }, BACKGROUND_CONTEXT);

  const username = await tool.run(
    { action: "fill_login", login: "ada", field: "username", ref: "p1:1" },
    BACKGROUND_CONTEXT,
  );

  expect(username.isError).toBe(false);
  expect(text(username)).toBe(
    "filled username of login [login ada password] on [login ada password].example.com",
  );
  expect(typed(guest).map((call) => call.args["text"])).toEqual([
    "ada",
    "grace",
  ]);
});

/** A later job on the same desktop: one capture of a page that still shows `shown`. */
async function laterCapture(
  desk: ReturnType<typeof fakeDesk>,
  shown: string,
  {
    logins,
    restarted = false,
  }: { logins?: LoginFill; restarted?: boolean } = {},
) {
  const guest = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      {
        snapshot_id: "s1",
        tree_markdown: `- [3] textbox "Field" value="${shown}"`,
        screenshot_width: 1,
      },
    ],
  });

  if (restarted) guest.state.processStart = "Thu Oct 30 11:00:00 2026";

  const capture = await createComputerUse(guest.shell, {
    logins,
    fills: desk.fills,
  }).run({ action: "capture", mode: "vision" }, BACKGROUND_CONTEXT);

  return {
    text: text(capture),
    image: capture.content.some((part) => part.type === "image"),
  };
}

test("a later job has an earlier job's password replaced, and no screenshot while that Chromium runs", async () => {
  const desk = fakeDesk();

  await readThenFill(
    "https://github.com/login",
    { login: "github", field: "password", ref: "p1:2" },
    {},
    fakeLogins(undefined, desk),
  );

  expect(desk.record).toEqual([
    {
      value: "hunter2",
      label: "[login github password]",
      browser: "7 Thu Oct 30 10:00:00 2026",
    },
  ]);
  expect(await laterCapture(desk, "hunter2")).toEqual({
    text: expect.stringContaining('value="[login github password]"'),
    image: false,
  });
});

test("screenshots return once Chromium restarts, and the password stays replaced", async () => {
  const desk = fakeDesk();

  await readThenFill(
    "https://github.com/login",
    { login: "github", field: "password", ref: "p1:2" },
    {},
    fakeLogins(undefined, desk),
  );

  expect(await laterCapture(desk, "hunter2", { restarted: true })).toEqual({
    text: expect.stringContaining('value="[login github password]"'),
    image: true,
  });
});

test("the password typed stays replaced after the login's value changes or the login is gone", async () => {
  const desk = fakeDesk();

  await readThenFill(
    "https://github.com/login",
    { login: "github", field: "password", ref: "p1:2" },
    {},
    fakeLogins(undefined, desk),
  );

  const rotated = fakeLogins({ password: { value: "new-secret" } }, desk);

  expect(
    (await laterCapture(desk, "hunter2", { logins: rotated.logins })).text,
  ).toContain('"[login github password]"');
  expect(rotated.reads()).toBe(0);
  expect((await laterCapture(desk, "hunter2")).text).toContain(
    '"[login github password]"',
  );
});

test("a password is recorded before it is typed, and once per Chromium", async () => {
  const desk = fakeDesk();
  const fake = fakeLogins(undefined, desk);

  const { tool, guest } = await readThenFill(
    "https://github.com/login",
    { login: "github", field: "password", ref: "p1:2" },
    {
      get_browser_state: [
        ...signIn("https://github.com/login"),
        ...signIn("https://github.com/login"),
      ],
    },
    fake,
  );

  expect(desk.record).toHaveLength(1);
  expect(typed(guest)).toHaveLength(1);

  await tool.run({ action: "read" }, BACKGROUND_CONTEXT);
  await tool.run(
    { action: "fill_login", login: "github", field: "password", ref: "p1:2" },
    BACKGROUND_CONTEXT,
  );

  expect(typed(guest)).toHaveLength(2);
  expect(desk.record).toHaveLength(1);
});

test("a job whose desktop record can't be read shows nothing", async () => {
  const guest = scriptedGuest({ list_windows: [windows] });

  const result = await createComputerUse(guest.shell, {
    fills: {
      list: async () => {
        throw new Error("store unavailable");
      },
      add: async () => undefined,
    },
  }).run({ action: "capture" }, BACKGROUND_CONTEXT);

  expect(result.isError).toBe(true);
  expect(text(result)).toBe("error: store unavailable");
  expect(guest.calls).toEqual([]);
});

test("a stale ref is reported, and the reply never shows the value", async () => {
  const { result } = await readThenFill(
    "https://github.com/login",
    { login: "github", field: "password", ref: "p1:2" },
    {
      browser_type: [
        {
          status: "refused",
          refusal: {
            code: "browser_ref_stale",
            message: "ref p1:2 is stale; could not type hunter2",
          },
        },
      ],
    },
  );

  expect(result.isError).toBe(true);
  expect(text(result)).toBe(
    "REFUSED (browser_ref_stale): ref p1:2 is stale; could not type [login github password]",
  );
});

test("without logins, fill_login is refused", async () => {
  const guest = scriptedGuest({ list_windows: [windows] });

  const result = await createComputerUse(guest.shell).run(
    { action: "fill_login", login: "github", field: "password", ref: "p1:2" },
    BACKGROUND_CONTEXT,
  );

  expect(text(result)).toBe("REFUSED: this bot has no logins here");
});
