import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { CHAT_KEY } from "@/features/chat/api";
import type { UsageDocument } from "@/features/chat/usage";
import { ChatUsage } from "./chat-usage";

async function render(usage: UsageDocument | undefined) {
  const window = new Window({ url: "http://localhost" });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: window.document },
    HTMLElement: { configurable: true, value: window.HTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  // Fresh cached data: the section reads the snapshot the chat already streams, with no request of its own.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });

  // The section reads only `usage`, so the rest of the snapshot is left out.
  client.setQueryData([CHAT_KEY, "b1"], { usage });

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ChatUsage botId="b1" />
      </QueryClientProvider>,
    );
  });

  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      client.clear();
      await window.happyDOM.abort();
      Object.defineProperties(globalThis, globals);
    },
  };
}

test("lists the chat's models and tools with tokens, cost, and a total", async () => {
  const { container, cleanup } = await render({
    models: {
      "openai/gpt-5": { totalTokens: 12_345, cost: { total: 0.25 } },
    },
    tools: { intent: { totalTokens: 900, cost: { total: 0.01 } } },
  });

  try {
    const rows = [...container.querySelectorAll("li")].map(
      (row) => row.textContent,
    );

    expect(rows).toEqual([
      "gpt-512K tokens · $0.2500",
      "intent (tool)900 tokens · $0.0100",
    ]);
    expect(container.textContent).toContain("Total $0.2600.");
  } finally {
    await cleanup();
  }
});

test("shows tokens without a cost for a subscription provider", async () => {
  const { container, cleanup } = await render({
    models: { "claude-code/opus": { totalTokens: 50, cost: { total: 0 } } },
  });

  try {
    expect(container.querySelector("li")?.textContent).toBe("opus50 tokens");
    expect(container.textContent).not.toContain("Total");
  } finally {
    await cleanup();
  }
});

test("says so before the chat's first request", async () => {
  const { container, cleanup } = await render(undefined);

  try {
    expect(container.textContent).toContain("No usage yet");
  } finally {
    await cleanup();
  }
});
