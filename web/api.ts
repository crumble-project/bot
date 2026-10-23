import { QueryClient, queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  agentPreviewResponse,
  chatSnapshotResponse,
  modelResponse,
  providerResponse,
} from "../src/api-responses";
import type { agentInput } from "../src/domain";

export type Bot = z.infer<typeof agentPreviewResponse>;

export type BotInput = z.input<typeof agentInput>;

export type Model = z.infer<typeof modelResponse>;

export type ChatSnapshot = z.infer<typeof chatSnapshotResponse>;

export type Provider = z.infer<typeof providerResponse>;

const TOKEN_KEY = "crumble.token";
const listeners = new Set<() => void>();

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, error) => !(error instanceof HttpError) && count < 2,
    },
  },
});

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set(value: string | null) {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);

    // A cache belongs to one credential; never show one token's data to another.
    queryClient.getQueryCache().clear();

    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);

    return () => listeners.delete(listener);
  },
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function errorMessage(response: Response) {
  const text = await response.text();

  try {
    const body: { error?: string } = JSON.parse(text);

    return body.error ?? text;
  } catch {
    return text || response.statusText;
  }
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token.get() ?? ""}`,
      ...(init.body && { "Content-Type": "application/json" }),
    },
  });

  if (response.status === 401) token.set(null);

  if (!response.ok)
    throw new HttpError(response.status, await errorMessage(response));

  return response;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return (await request(path, init)).json();
}

/** Sends a mutation whose response body the UI does not need. */
export async function send<Body>(path: string, method: string, body?: Body) {
  await request(path, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

export const botsQuery = queryOptions({
  queryKey: ["bots"],
  queryFn: ({ signal }) => api<Bot[]>("/v1/agents", { signal }),
});

export const chatQuery = (id: string) =>
  queryOptions({
    queryKey: ["chat", id],
    queryFn: ({ signal }) =>
      api<ChatSnapshot>(`/v1/agents/${encodeURIComponent(id)}/chat`, {
        signal,
      }),
  });

export const modelsQuery = (provider: string) =>
  queryOptions({
    queryKey: ["models", provider],
    queryFn: ({ signal }) =>
      api<Model[]>(`/v1/models?provider=${encodeURIComponent(provider)}`, {
        signal,
      }),
    staleTime: 5 * 60_000,
  });

export const providersQuery = queryOptions({
  queryKey: ["providers"],
  queryFn: ({ signal }) => api<Provider[]>("/v1/providers", { signal }),
});

/** Keeps a bot's chat query current from its event stream until `signal` aborts. */
export async function followChat(id: string, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const response = await request(
        `/v1/agents/${encodeURIComponent(id)}/events`,
        { signal },
      );

      // No Last-Event-ID replay, so every connection starts from a fresh snapshot.
      void queryClient.invalidateQueries({ queryKey: ["chat", id] });

      const reader = response
        .body!.pipeThrough(new TextDecoderStream())
        .getReader();

      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();

        if (done) break;
        buffer += value;
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const lines = frame.split("\n");
          const event = lines.find((line) => line.startsWith("event:"));

          if (event?.slice(6).trim() !== "snapshot") continue;

          const data = lines
            .flatMap((line) =>
              line.startsWith("data:") ? [line.slice(5).replace(/^ /, "")] : [],
            )
            .join("\n");

          queryClient.setQueryData(chatQuery(id).queryKey, JSON.parse(data));
        }
      }
    } catch (error) {
      if (signal.aborted || error instanceof HttpError) return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
