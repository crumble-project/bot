import { QueryClient, queryOptions } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import type {
  activityEvent,
  activityFeedResponse,
  agentPreviewResponse,
  capabilitiesResponse,
  chatSnapshotResponse,
  codingJobsResponse,
  credentialUseResponse,
  credentialsResponse,
  describedMcpServerResponse,
  desktopControlResponse,
  desktopJobsResponse,
  desktopViewerResponse,
  botRequestResponse,
  groupChatResponse,
  groupChatSnapshotResponse,
  historyResponse,
  learnedChangeResponse,
  listedSkillResponse,
  loginSessionResponse,
  memoryResponse,
  modelResponse,
  providerResponse,
  scheduleResponse,
  scriptRunResponse,
} from "@crumble/server/contract/api-responses";
import type { agentInput } from "@crumble/server/shared/domain";
import type { ChartLayout } from "@crumble/server/display/charts";

export type Bot = z.infer<typeof agentPreviewResponse>;

export type BotInput = z.input<typeof agentInput>;

export type Model = z.infer<typeof modelResponse>;

export type LoginSession = z.infer<typeof loginSessionResponse>;

export type Capabilities = z.infer<typeof capabilitiesResponse>;

export type ChatSnapshot = z.infer<typeof chatSnapshotResponse>;

export type HistoryPage = z.infer<typeof historyResponse>;

export type Message = HistoryPage["messages"][number];

export type Provider = z.infer<typeof providerResponse>;

export type Memory = z.infer<typeof memoryResponse>;

export type Credentials = z.infer<typeof credentialsResponse>;

export type Credential = Credentials["credentials"][number];

export type CredentialRequest = Credentials["requests"][number];

export type CredentialUse = z.infer<typeof credentialUseResponse>;

export type BotRequest = z.infer<typeof botRequestResponse>;

export type Change = z.infer<typeof learnedChangeResponse>;

export type ListedSkill = z.infer<typeof listedSkillResponse>;

export type Schedule = z.infer<typeof scheduleResponse>;

export type ScriptRun = z.infer<typeof scriptRunResponse>;

export type McpServer = z.infer<typeof describedMcpServerResponse>;

export type GroupChat = z.infer<typeof groupChatResponse>;

export type GroupChatSnapshot = z.infer<typeof groupChatSnapshotResponse>;

export type CodingJob = z.infer<typeof codingJobsResponse>["jobs"][number];

export type DesktopJob = z.infer<typeof desktopJobsResponse>["jobs"][number];

export type DesktopControl = z.infer<typeof desktopControlResponse>;

export type DesktopViewer = z.infer<typeof desktopViewerResponse>;

export type ActivityFeed = z.infer<typeof activityFeedResponse>;

export type ActivityEvent = z.infer<typeof activityEvent>;

export type { ChartLayout };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, error) => !(error instanceof HttpError) && count < 2,
    },
  },
});

/** Drop all cached user data when the authenticated account changes. */
export function clearUserData() {
  void queryClient.cancelQueries();
  queryClient.clear();
}

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
  const headers = new Headers(init.headers);

  if (init.body) headers.set("Content-Type", "application/json");

  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers,
  });

  if (response.status === 401) {
    clearUserData();

    if (!location.pathname.endsWith("/connect"))
      window.location.assign("/ui/connect");
  }

  if (!response.ok)
    throw new HttpError(response.status, await errorMessage(response));

  return response;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return (await request(path, init)).json();
}

/** Sends a JSON body with `method` and returns the parsed response. */
export async function call<T, Body = undefined>(
  path: string,
  method: string,
  body?: Body,
): Promise<T> {
  return api<T>(path, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/** Sends a mutation whose response body the UI does not need. */
export async function send<Body>(path: string, method: string, body?: Body) {
  await request(path, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/** Fetches an authenticated binary, such as an attachment image, as an object URL. */
export async function blobUrl(path: string, signal?: AbortSignal) {
  const response = await request(path, { signal: signal ?? null });

  return URL.createObjectURL(await response.blob());
}

export const agentPath = (id: string) => `/v1/agents/${encodeURIComponent(id)}`;

export const groupPath = (id: string) =>
  `/v1/group-chats/${encodeURIComponent(id)}`;

export const botsQuery = queryOptions({
  queryKey: ["bots"],
  queryFn: ({ signal }) => api<Bot[]>("/v1/agents", { signal }),
});

export const chatQuery = (id: string) =>
  queryOptions({
    queryKey: ["chat", id],
    queryFn: ({ signal }) =>
      api<ChatSnapshot>(`${agentPath(id)}/chat`, { signal }),
  });

export const groupsQuery = queryOptions({
  queryKey: ["groups"],
  queryFn: ({ signal }) => api<GroupChat[]>("/v1/group-chats", { signal }),
});

export const groupChatQuery = (id: string) =>
  queryOptions({
    queryKey: ["group-chat", id],
    queryFn: ({ signal }) =>
      api<GroupChatSnapshot>(`${groupPath(id)}/chat`, { signal }),
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

export const loginQuery = (id: string) =>
  queryOptions({
    queryKey: ["login", id],
    queryFn: ({ signal }) =>
      api<LoginSession>(`/v1/provider-logins/${encodeURIComponent(id)}`, {
        signal,
      }),
    // Sign-ins advance on the server, so poll until they end.
    refetchInterval: (query) =>
      query.state.data?.status === "pending" ? 1000 : false,
  });

export const capabilitiesQuery = queryOptions({
  queryKey: ["capabilities"],
  queryFn: ({ signal }) => api<Capabilities>("/v1/capabilities", { signal }),
  staleTime: Infinity,
});

export const schedulesQuery = queryOptions({
  queryKey: ["schedules"],
  queryFn: ({ signal }) => api<Schedule[]>("/v1/schedules", { signal }),
});

export const scriptRunsQuery = (id: string) =>
  queryOptions({
    queryKey: ["script-runs", id],
    queryFn: ({ signal }) =>
      api<ScriptRun[]>(
        `/v1/schedules/${encodeURIComponent(id)}/runs?limit=20`,
        {
          signal,
        },
      ),
  });

export const botMemoriesQuery = (id: string) =>
  queryOptions({
    queryKey: ["memories", id],
    queryFn: ({ signal }) =>
      api<Memory[]>(`${agentPath(id)}/memories`, { signal }),
  });

export const credentialsQuery = (id: string) =>
  queryOptions({
    queryKey: ["credentials", id],
    queryFn: ({ signal }) =>
      api<Credentials>(`${agentPath(id)}/credentials`, { signal }),
  });

export const botRequestsQuery = (id: string) =>
  queryOptions({
    queryKey: ["bot-requests", id],
    queryFn: ({ signal }) =>
      api<BotRequest[]>(`${agentPath(id)}/bot-requests`, { signal }),
  });

export const botRequestPath = (id: string, requestId: string) =>
  `${agentPath(id)}/bot-requests/${encodeURIComponent(requestId)}`;

export const credentialPath = (id: string, name: string) =>
  `${agentPath(id)}/credentials/${encodeURIComponent(name)}`;

export const sharedMemoriesQuery = queryOptions({
  queryKey: ["memories", "shared"],
  queryFn: ({ signal }) => api<Memory[]>("/v1/memories", { signal }),
});

export const skillsQuery = queryOptions({
  queryKey: ["skills"],
  queryFn: ({ signal }) => api<ListedSkill[]>("/v1/skills", { signal }),
});

export const mcpServersQuery = queryOptions({
  queryKey: ["mcp-servers"],
  queryFn: ({ signal }) => api<McpServer[]>("/v1/mcp-servers", { signal }),
});

/** `version` refetches when the chat's job messages change. */
export const jobsQuery = (
  id: string,
  kind: "coding" | "desktop",
  version = 0,
) =>
  queryOptions({
    queryKey: ["jobs", id, kind, version],
    queryFn: async ({ signal }) =>
      // Coding and desktop jobs share one response shape.
      (
        await api<{ jobs: CodingJob[] }>(`${agentPath(id)}/${kind}-jobs`, {
          signal,
        })
      ).jobs,
  });

type StreamHandlers = {
  /** Each named event with its raw data; heartbeats are skipped. */
  onEvent: (event: string, data: string) => void;
  /** After every (re)connection, since streams have no replay. */
  onOpen?: () => void;
  onStatus?: (status: "connected" | "reconnecting") => void;
  /** The resource is gone (404); the stream stops. */
  onGone?: () => void;
};

function dispatchStreamFrame(frame: string, handlers: StreamHandlers) {
  const lines = frame.split("\n");

  const event =
    lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim() ?? "message";

  if (event === "heartbeat") return;

  const data = lines
    .flatMap((line) =>
      line.startsWith("data:") ? [line.slice(5).replace(/^ /, "")] : [],
    )
    .join("\n");

  handlers.onEvent(event, data);
}

async function readEventStream(response: Response, handlers: StreamHandlers) {
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

    for (const frame of frames) dispatchStreamFrame(frame, handlers);
  }
}

function endsStream(error: HttpError, handlers: StreamHandlers) {
  if (error.status === 404) handlers.onGone?.();

  return error.status === 401 || error.status === 404;
}

/** Follows a server-sent event stream with the session cookie, reconnecting with backoff until `signal` aborts. */
export async function follow(
  path: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
) {
  let delay = 500;

  while (!signal.aborted) {
    try {
      const response = await request(path, { signal });
      handlers.onStatus?.("connected");
      handlers.onOpen?.();
      delay = 500;

      await readEventStream(response, handlers);
    } catch (error) {
      if (signal.aborted) return;

      if (error instanceof HttpError && endsStream(error, handlers)) return;
    }

    handlers.onStatus?.("reconnecting");
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 8000);
  }
}

/** Keeps a bot's chat query current from its event stream until `signal` aborts. */
export function followChat(id: string, signal: AbortSignal) {
  return follow(
    `${agentPath(id)}/events`,
    {
      onOpen: () =>
        void queryClient.invalidateQueries({ queryKey: ["chat", id] }),
      onEvent: (event, data) => {
        if (event === "snapshot" || event === "message")
          queryClient.setQueryData(chatQuery(id).queryKey, JSON.parse(data));
      },
    },
    signal,
  );
}
