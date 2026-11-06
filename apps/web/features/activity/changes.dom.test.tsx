import { afterEach, spyOn, test } from "bun:test";
import { QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { queryClient } from "@/lib/api";
import { botSkillsQuery } from "@/features/skills/api";
import { waitFor, waitForIdle } from "@/test/wait-for";
import type { Change } from "./api";

const change: Change = {
  id: "change-1",
  agentId: "bot-1",
  actor: "review",
  target: "skill",
  targetId: "skill-1",
  action: "update",
  before: null,
  after: null,
  source: null,
  revertsId: null,
  createdAt: "2026-11-05T00:00:00.000Z",
};

afterEach(() => queryClient.clear());

test("reverting a change to a bot's own skill refreshes that bot's skills", async () => {
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
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };

  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => Response.json({}), {
      preconnect: globalThis.fetch.preconnect,
    }),
  );

  const skills = botSkillsQuery("bot-1");

  queryClient.setQueryData(skills.queryKey, []);

  const stopObserving = new QueryObserver(queryClient, skills).subscribe(
    () => {},
  );

  const { createRoot } = await import("react-dom/client");
  const { RevertChange } = await import("./changes");
  const container = document.createElement("div");

  document.body.append(container);

  const root = createRoot(container);

  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <RevertChange change={change} />
        </QueryClientProvider>,
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>("button")!.click(),
    );
    await act(async () => {
      const buttons = document.querySelectorAll<HTMLButtonElement>(
        '[role="alertdialog"] button',
      );

      [...buttons].find((button) => button.textContent === "Revert")!.click();
    });
    await waitFor(
      () =>
        fetch.mock.calls.some(([path]) => path === "/v1/agents/bot-1/skills"),
      "the bot's skills to refetch",
    );
    await waitForIdle(queryClient);
  } finally {
    stopObserving();
    await act(async () => root.unmount());
    fetch.mockRestore();

    for (const key of Object.keys(values)) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
});
