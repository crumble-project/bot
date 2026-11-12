import { expect, spyOn, test } from "bun:test";
import { QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Window } from "happy-dom";
import { act } from "react";
import { defaultAvatarDefinition } from "@crumble/server/contract/avatar";
import { queryClient } from "@/lib/api";
import { waitFor, waitForIdle } from "@/test/wait-for";
import {
  type Schedule,
  executionsQuery,
  schedulePath,
  scriptRunsQuery,
} from "./api";

const schedule: Schedule = {
  id: "schedule/1",
  agentId: "bot",
  name: "Nightly",
  prompt: "Summarize the day",
  kind: "prompt",
  command: null,
  timeoutSeconds: 600,
  notify: true,
  cron: "0 0 * * *",
  timezone: "UTC",
  runAt: null,
  eventSourceId: null,
  enabled: true,
  nextRunAt: null,
  nextRunLabel: "—",
  description: "Every day (UTC)",
  timing: "Every day (UTC)",
  createdAt: "2026-11-01T00:00:00.000Z",
  createdByAgentId: null,
};

test("running an automation refreshes its histories and opens its bot", async () => {
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
    scrollTo: () => {},
  };

  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  const runs = scriptRunsQuery(schedule.id);
  const otherRuns = scriptRunsQuery("other");
  const refreshed = new Set<string>();

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = input instanceof Request ? input.url : input.toString();

        if (init?.method === "POST") return Response.json({ admitted: true });

        refreshed.add(path);

        if (path === "/v1/agents")
          return Response.json([
            { id: "bot", name: "Bot", avatar: defaultAvatarDefinition("bot") },
          ]);

        if (path === "/v1/schedules") return Response.json([schedule]);

        if (path === "/v1/event-sources") return Response.json({ sources: [] });

        return Response.json([]);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  // Seeded and observed, as open pages keep them: only a refresh can fetch them.
  for (const queryKey of [
    executionsQuery.queryKey,
    runs.queryKey,
    otherRuns.queryKey,
  ])
    queryClient.setQueryData(queryKey, []);

  const stopObserving = [
    new QueryObserver(queryClient, executionsQuery).subscribe(() => {}),
    new QueryObserver(queryClient, runs).subscribe(() => {}),
    new QueryObserver(queryClient, otherRuns).subscribe(() => {}),
  ];

  const { createRoot } = await import("react-dom/client");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { AutomationsPage } = await import("./automations");
  const rootRoute = createRootRoute({ component: Outlet });

  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: AutomationsPage,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/bots/$botId",
        component: () => <p>Chat</p>,
      }),
    ]),
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const more = () => container.querySelector('[title="More"]');

  const runNow = () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.includes("Run now"),
    );

  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <RouterProvider router={router} />
          </SidebarProvider>
        </QueryClientProvider>,
      ),
    );
    await waitFor(() => more() !== null, "the automation");
    await act(async () => {
      more()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    await waitFor(() => runNow() !== undefined, "Run now");
    await act(async () => runNow()!.click());
    await waitFor(
      () => router.state.location.pathname === "/bots/bot",
      "the bot's chat",
    );

    const runsPath = `${schedulePath(schedule.id)}/runs?limit=20`;

    await waitFor(() => refreshed.has(runsPath), "the run history");
    expect(refreshed).toContain("/v1/executions");
    expect(refreshed).not.toContain(`${schedulePath("other")}/runs?limit=20`);
    await waitForIdle(queryClient);
  } finally {
    for (const stop of stopObserving) stop();
    await act(async () => root.unmount());
    queryClient.clear();
    fetch.mockRestore();

    for (const key of Object.keys(values)) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
});
