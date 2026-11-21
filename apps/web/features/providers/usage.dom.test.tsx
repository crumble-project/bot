import { expect, test } from "bun:test";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { type Provider, type Usage, usageQuery } from "./api";
import { UsageView } from "./usage";

const anthropic: Provider = {
  provider: "anthropic",
  name: "Anthropic",
  configured: true,
  authMethods: [],
  credentialType: "api_key",
  apiKey: { configured: true, passwordManager: null, reference: null },
  activeLoginId: null,
  externalAuth: null,
};

function Harness({ providers }: { providers: Provider[] }) {
  return <UsageView usage={useQuery(usageQuery)} providers={providers} />;
}

async function render(usage: Usage, providers: Provider[] = [anthropic]) {
  const window = new Window({ url: "http://localhost" });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: window.document },
    HTMLElement: { configurable: true, value: window.HTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  // Fresh cached data, so the view makes no request.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });

  client.setQueryData(usageQuery.queryKey, usage);

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Harness providers={providers} />
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

// Logos carry an SVG title, but are aria-hidden: leave them out as a screen reader would.
const heading = (section: Element) => {
  const h2 = section.querySelector("h2");

  const hidden = [...(h2?.querySelectorAll("[aria-hidden]") ?? [])]
    .map((element) => element.textContent)
    .join("");

  return h2?.textContent?.replace(hidden, "");
};

const sections = (container: HTMLElement) =>
  [...container.querySelectorAll("section")].map((section) => ({
    title: heading(section),
    text: section.textContent,
  }));

test("groups models by provider, with a total for each and for the account", async () => {
  const { container, cleanup } = await render({
    models: [
      { provider: "openai", model: "gpt-6", tokens: 12_345, cost: 0.25 },
      { provider: "anthropic", model: "sonnet", tokens: 900, cost: 0.5 },
      { provider: "openai", model: "gpt-6-mini", tokens: 100, cost: 0.01 },
    ],
    tools: [{ name: "vision", tokens: 50, cost: 0.02 }],
  });

  try {
    const found = sections(container);

    expect(found.map((section) => section.title)).toEqual([
      "openai",
      "Anthropic",
      "Tools",
    ]);
    expect(found[0]?.text).toContain("12K tokens · $0.2600");
    expect(found[0]?.text).toContain("gpt-6-mini100 tokens · $0.0100");
    expect(container.textContent).toContain("$0.7800");
  } finally {
    await cleanup();
  }
});

test("shows tokens without a cost for a subscription provider", async () => {
  const { container, cleanup } = await render({
    models: [{ provider: "claude-code", model: "opus", tokens: 50, cost: 0 }],
    tools: [],
  });

  try {
    expect(container.textContent).not.toContain("$");
    expect(container.textContent).toContain("opus50 tokens");
  } finally {
    await cleanup();
  }
});

test("says so before any bot has called a model", async () => {
  const { container, cleanup } = await render({ models: [], tools: [] });

  try {
    expect(container.textContent).toContain("No usage yet");
  } finally {
    await cleanup();
  }
});
