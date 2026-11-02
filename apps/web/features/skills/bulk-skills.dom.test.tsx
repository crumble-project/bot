import { expect, spyOn, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { queryClient } from "@/lib/api";
import { BotPainter } from "@/features/bots/bot-avatar";

type Package = {
  id: string;
  name: string;
  instructions: string;
  source?: string;
  origin?: { repository: string; branch: string };
  update?: { commit: string; removed: boolean } | null;
};

async function fixture(
  run: (ui: {
    window: Window;
    container: HTMLDivElement;
    click: (label: string) => Promise<void>;
    select: (label: string) => Promise<void>;
    search: (value: string) => Promise<void>;
    requests: string[];
    fail: Set<string>;
  }) => Promise<void>,
) {
  const window = new Window({ url: "http://localhost" });
  const globals = Object.getOwnPropertyDescriptors(globalThis);

  const values = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    devicePixelRatio: 1,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    Path2D: class {
      moveTo() {}
      ellipse() {}
      roundRect() {}
      lineTo() {}
      closePath() {}
      bezierCurveTo() {}
    },
  };

  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  const paint = spyOn(BotPainter.prototype, "paint").mockImplementation(
    () => {},
  );

  // SAFETY: Painting is stubbed; only these canvas methods are used by the avatar setup.
  const context = spyOn(
    window.HTMLCanvasElement.prototype,
    "getContext",
  ).mockReturnValue({ setTransform() {}, clearRect() {} } as never);

  const requests: string[] = [];
  const fail = new Set<string>();

  const bots: {
    id: string;
    name: string;
    avatar: string;
    sharedSkills: string[];
  }[] = [
    { id: "a", name: "Alpha", avatar: "", sharedSkills: [] },
    { id: "b", name: "Beta", avatar: "", sharedSkills: [] },
  ];

  let shared: Package[] = [
    {
      id: "shared",
      name: "Shared",
      instructions: "Shared instructions",
      source: "shared",
    },
    {
      id: "github",
      name: "GitHub",
      instructions: "Installed instructions",
      source: "shared",
      origin: { repository: "acme/skills", branch: "main" },
      update: { commit: "abc", removed: false },
    },
    {
      id: "default",
      name: "Default",
      instructions: "Default instructions",
      source: "bundled",
    },
  ];

  let own: Package[] = [
    { id: "own", name: "Own", instructions: "Own instructions" },
  ];

  const assignmentResponse = (
    path: string,
    body: { botId: string; assigned: boolean },
  ) => {
    const bot = bots.find((each) => each.id === body.botId)!;

    if (path === "/v1/skills/shared/assignment")
      bot.sharedSkills = body.assigned ? ["shared"] : [];

    return Response.json({ skipped: false });
  };

  const deletionResponse = (path: string) => {
    shared = shared.filter((skill) => path !== `/v1/skills/${skill.id}`);
    own = own.filter((skill) => path !== `/v1/agents/a/skills/${skill.id}`);

    return new Response(null, { status: 204 });
  };

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = input instanceof Request ? input.url : input.toString();
        const method = init?.method ?? "GET";

        if (method !== "GET") requests.push(`${method} ${path}`);

        if (fail.has(path) && method !== "GET")
          return Response.json({ error: "Denied by test" }, { status: 500 });

        if (method === "DELETE") return deletionResponse(path);

        if (path === "/v1/skills/updates/check")
          return Response.json({ failed: [] });

        if (path === "/v1/skills/github/update") {
          shared = shared.map((skill) =>
            skill.id === "github" ? { ...skill, update: null } : skill,
          );

          return Response.json({});
        }

        if (path.endsWith("/assignment")) {
          const body: { botId: string; assigned: boolean } = JSON.parse(
            await new Response(init?.body).text(),
          );

          return assignmentResponse(path, body);
        }

        const listings = new Map<string, unknown>([
          ["/v1/agents", bots],
          ["/v1/skills", shared],
          ["/v1/agents/a/skills", own],
          ["/v1/agents/b/skills", []],
        ]);

        if (listings.has(path)) return Response.json(listings.get(path));

        return Response.json({ error: `Unexpected ${path}` }, { status: 500 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const defaults = queryClient.getDefaultOptions();
  queryClient.clear();
  queryClient.setDefaultOptions({
    queries: { retry: false },
    mutations: { retry: false },
  });
  const { createRoot } = await import("react-dom/client");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { SkillsPage } = await import("./skills");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  };

  const click = async (label: string) => {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((node) => node.textContent?.trim() === label && !node.disabled);

    if (!button) throw new Error(`Missing button: ${label}`);
    await act(async () => {
      button.click();
      await flush();
    });
  };

  const select = async (label: string) => {
    const checkbox = document.querySelector<HTMLInputElement>(
      `input[aria-label="${label}"]`,
    );

    if (!checkbox) throw new Error(`Missing checkbox: ${label}`);
    await act(async () => {
      checkbox.click();
      await flush();
    });
  };

  const search = async (value: string) => {
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search skills"]',
    )!;

    await act(async () => {
      // React tracks direct assignments; use the native setter to simulate typing.
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
  };

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <SkillsPage />
          </SidebarProvider>
        </QueryClientProvider>,
      );
      await flush();
    });
    await act(flush);
    await run({ window, container, click, select, search, requests, fail });
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    queryClient.setDefaultOptions(defaults);
    fetch.mockRestore();
    context.mockRestore();
    paint.mockRestore();
    await window.happyDOM.abort();

    for (const key of Object.keys(values)) {
      const descriptor = globals[key];

      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("bulk selection spans sections and filters; delete confirms names and keeps only failures selected", async () => {
  await fixture(
    async ({ container, select, search, click, requests, fail }) => {
      expect(
        container.querySelector('[aria-label="Select Default (Shared)"]'),
      ).toBeNull();
      expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(
        6,
      );
      await select("Select Shared (Shared)");
      await search("Own");
      expect(
        container.querySelector('[aria-label="Select Shared (Shared)"]'),
      ).toBeNull();
      await select("Select all results");
      expect(container.textContent).toContain("2 selected");
      await search("");
      fail.add("/v1/agents/a/skills/own");
      await click("Delete");
      expect(document.body.textContent).toContain(
        "Delete: Shared (Shared), Own (Alpha)",
      );

      const confirmation = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="alertdialog"] button',
        ),
      ].find((button) => button.textContent === "Delete")!;

      await act(async () => {
        confirmation.click();
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
      expect(requests).toEqual([
        "DELETE /v1/skills/shared",
        "DELETE /v1/agents/a/skills/own",
      ]);
      expect(container.textContent).toContain("1 selected");
      expect(container.textContent).toContain(
        "Failed Own (Alpha): Denied by test",
      );
      expect(
        container.querySelector<HTMLInputElement>(
          '[aria-label="Select Own (Alpha)"]',
        )?.checked,
      ).toBe(true);
      fail.clear();
      await click("Delete");

      const retry = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="alertdialog"] button',
        ),
      ].find((button) => button.textContent === "Delete")!;

      await act(async () => {
        retry.click();
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
      expect(container.textContent).not.toContain("1 selected");
    },
  );
});

test("bulk update applies selected GitHub skills, reports skipped skills, and clears selection", async () => {
  await fixture(async ({ container, select, click, requests }) => {
    await select("Select all results");
    expect(container.textContent).toContain("3 selected");
    expect(container.textContent).toContain(
      "Update skips skills not installed from GitHub: Shared (Shared), Own (Alpha)",
    );
    await click("Update");
    expect(requests).toEqual([
      "POST /v1/skills/updates/check",
      "POST /v1/skills/github/update",
    ]);
    expect(container.textContent).toContain(
      "Skipped Shared (Shared): not installed from GitHub",
    );
    expect(container.textContent).toContain(
      "Skipped Own (Alpha): not installed from GitHub",
    );
    expect(container.textContent).not.toContain("3 selected");
  });
});

test("bulk assign and remove pick several bots, refresh usage, and name per-bot failures", async () => {
  await fixture(async ({ container, select, click, requests, fail }) => {
    await select("Select Shared (Shared)");
    await select("Select Own (Alpha)");
    await click("Assign to bots");
    await click("Alpha");
    await click("Beta");
    fail.add("/v1/skills/own/assignment");
    await click("Assign");
    expect(container.textContent).toContain("used by 2");
    expect(container.textContent).toContain(
      "Failed Own (Alpha) → Alpha: Denied by test",
    );
    expect(container.textContent).toContain(
      "Failed Own (Alpha) → Beta: Denied by test",
    );
    expect(container.textContent).toContain("1 selected");
    fail.clear();
    await select("Select Shared (Shared)");
    await click("Remove from bots");
    await click("Alpha");
    await click("Beta");
    await click("Remove");
    expect(container.textContent).not.toContain("used by 2");
    expect(container.textContent).not.toContain("2 selected");
    expect(
      requests.filter((request) => request.endsWith("/assignment")),
    ).toHaveLength(8);
  });
});

test("section select-all is mixed when partly selected; failed updates can be retried without touching unselected skills", async () => {
  await fixture(async ({ container, select, click, requests, fail }) => {
    await select("Select all shared skills");
    await select("Select Shared (Shared)");
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Select all shared skills"]',
      )?.indeterminate,
    ).toBe(true);
    expect(container.textContent).toContain("1 selected");
    fail.add("/v1/skills/github/update");
    await click("Update");
    expect(container.textContent).toContain(
      "Failed GitHub (Shared): Denied by test",
    );
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Select GitHub (Shared)"]',
      )?.checked,
    ).toBe(true);
    fail.clear();
    await click("Update");
    expect(container.textContent).not.toContain("1 selected");
    await select("Select GitHub (Shared)");
    await click("Update");
    expect(container.textContent).toContain(
      "Skipped GitHub (Shared): already up to date",
    );
    expect(requests.filter((request) => request.endsWith("/update"))).toEqual([
      "POST /v1/skills/github/update",
      "POST /v1/skills/github/update",
    ]);
    await select("Select Shared (Shared)");

    const update = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Update");

    expect(update?.disabled).toBe(true);
  });
});
