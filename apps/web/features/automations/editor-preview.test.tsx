import { expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { z } from "zod";
import { waitFor } from "@/test/wait-for";
import { PreviewStatus, useSchedulePreview } from "./editor";

test("schedule preview ignores stale responses and retries failures", async () => {
  const window = new Window({ url: "http://localhost" });
  const globals = Object.getOwnPropertyDescriptors(globalThis);

  const values = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };

  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  let failureRequests = 0;
  let resolveOld: ((value: Response) => void) | undefined;

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(z.string().parse(init?.body));

        if (body.cron === "old")
          return new Promise<Response>((resolve) => {
            resolveOld = resolve;
          });

        if (body.cron === "failure" && failureRequests++ === 0)
          return new Response("Unavailable", { status: 503 });

        return Response.json({
          description: "new",
          text: "new result",
          isProblem: false,
          nextRunAt: null,
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const draft = {
    agentId: "bot",
    name: "",
    enabled: true,
    prompt: "",
    kind: "prompt" as const,
    command: "",
    timeoutSeconds: "600",
    notify: true,
    repeat: true,
    cron: "old",
    timezone: "UTC",
    runAt: "",
    onEvent: false,
    eventSourceId: "",
  };

  function Preview({ cron }: { cron: string }) {
    const preview = useSchedulePreview({ ...draft, cron });

    return (
      <>
        <span>{preview.data?.text ?? "pending"}</span>
        <PreviewStatus preview={preview} />
      </>
    );
  }

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  const root = createRoot(container);

  const render = (cron: string) =>
    root.render(
      <QueryClientProvider client={client}>
        <Preview cron={cron} />
      </QueryClientProvider>,
    );

  try {
    await act(async () => render("old"));
    await waitFor(() => resolveOld !== undefined, "old preview request");
    expect(container.textContent).toContain("Loading schedule preview");
    await act(async () => render("new"));
    await waitFor(() => container.textContent === "new result", "new preview");
    await act(async () =>
      resolveOld!(
        Response.json({
          description: "old",
          text: "old result",
          isProblem: false,
          nextRunAt: null,
        }),
      ),
    );
    expect(container.textContent).toBe("new result");
    await act(async () => render("failure"));
    await waitFor(
      () => container.querySelector("button") !== null,
      "preview failure",
    );
    expect(container.textContent).toContain("Could not load schedule preview");
    await act(async () => container.querySelector("button")!.click());
    await waitFor(
      () => container.textContent === "new result",
      "retried preview",
    );
  } finally {
    await act(async () => root.unmount());
    client.clear();
    fetch.mockRestore();

    for (const key of Object.keys(values)) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
});
