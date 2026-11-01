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
  executionResponse,
  desktopControlResponse,
  desktopJobsResponse,
  desktopStatusResponse,
  desktopViewerResponse,
  botRequestResponse,
  groupChatResponse,
  groupChatSnapshotResponse,
  heldActionResponse,
  judgeModelResponse,
  loginUseResponse,
  loginsResponse,
  historyResponse,
  learnedChangeResponse,
  listedSkillResponse,
  loginSessionResponse,
  memoryResponse,
  modelResponse,
  passwordManagersResponse,
  pluginSettingsResponse,
  providerResponse,
  scheduleResponse,
  scriptRunResponse,
  ChartLayout,
} from "@crumble/server/contract/api-responses";
import type { BotInput } from "@crumble/server/contract/api-contract";
import type {
  gatewayConfigInput,
  gatewayResponse,
  gatewaysResponse,
} from "@crumble/server/contract/message-gateway";
import type {
  createdEventSourceResponse,
  eventSourceResponse,
  eventSourcesResponse,
  relayStatusResponse,
} from "@crumble/server/contract/event-sources";

export type GatewayConfig = z.infer<typeof gatewayConfigInput>;

export type MessageGateway = z.infer<typeof gatewayResponse>;

export type RelayStatus = z.infer<typeof relayStatusResponse>;

export type EventSource = z.infer<typeof eventSourceResponse>;

export type CreatedEventSource = z.infer<typeof createdEventSourceResponse>;

export type Bot = z.infer<typeof agentPreviewResponse>;

export type { BotInput };

export type Model = z.infer<typeof modelResponse>;

export type LoginSession = z.infer<typeof loginSessionResponse>;

export type Capabilities = z.infer<typeof capabilitiesResponse>;

export type ChatSnapshot = z.infer<typeof chatSnapshotResponse>;

export type HistoryPage = z.infer<typeof historyResponse>;

export type Message = HistoryPage["messages"][number];

export type Provider = z.infer<typeof providerResponse>;

export type Memory = z.infer<typeof memoryResponse>;

export type PasswordManager = z.infer<
  typeof passwordManagersResponse
>["passwordManagers"][number];

export type PasswordManagerId = PasswordManager["id"];

export type Credentials = z.infer<typeof credentialsResponse>;

export type Credential = Credentials["credentials"][number];

export type CredentialRequest = Credentials["requests"][number];

export type CredentialUse = z.infer<typeof credentialUseResponse>;

export type Logins = z.infer<typeof loginsResponse>;

export type Login = Logins["logins"][number];

export type LoginRequest = Logins["requests"][number];

export type LoginUse = z.infer<typeof loginUseResponse>;

export type BotRequest = z.infer<typeof botRequestResponse>;

export type HeldAction = z.infer<typeof heldActionResponse>;

export type JudgeModel = z.infer<typeof judgeModelResponse>;

export type PluginSettings = z.infer<typeof pluginSettingsResponse>;

export type Change = z.infer<typeof learnedChangeResponse>;

export type ListedSkill = z.infer<typeof listedSkillResponse>;

export type Schedule = z.infer<typeof scheduleResponse>;

export type ScriptRun = z.infer<typeof scriptRunResponse>;

export type Execution = z.infer<typeof executionResponse>;

export type McpServer = z.infer<typeof describedMcpServerResponse>;

export type GroupChat = z.infer<typeof groupChatResponse>;

export type GroupChatSnapshot = z.infer<typeof groupChatSnapshotResponse>;

export type CodingJob = z.infer<typeof codingJobsResponse>["jobs"][number];

export type DesktopJob = z.infer<typeof desktopJobsResponse>["jobs"][number];

export type DesktopControl = z.infer<typeof desktopControlResponse>;

export type DesktopViewer = z.infer<typeof desktopViewerResponse>;

export type DesktopStatus = z.infer<typeof desktopStatusResponse>;

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

/** Fetches an authenticated binary, such as an attachment image. */
export async function apiBlob(path: string, signal?: AbortSignal) {
  const response = await request(path, { signal: signal ?? null });

  return response.blob();
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

export const passwordManagersQuery = queryOptions({
  queryKey: ["password-managers"],
  queryFn: async ({ signal }) =>
    (
      await api<z.infer<typeof passwordManagersResponse>>(
        "/v1/password-managers",
        { signal },
      )
    ).passwordManagers,
});

export const passwordManagerPath = (id: PasswordManagerId) =>
  `/v1/password-managers/${encodeURIComponent(id)}`;

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

export const executionsQuery = queryOptions({
  queryKey: ["executions"],
  queryFn: ({ signal }) => api<Execution[]>("/v1/executions", { signal }),
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

export const desktopStatusQuery = (id: string) =>
  queryOptions({
    queryKey: ["desktop-status", id],
    queryFn: ({ signal }) =>
      api<DesktopStatus>(`${agentPath(id)}/desktop/status`, { signal }),
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

export const loginsQuery = (id: string) =>
  queryOptions({
    queryKey: ["logins", id],
    queryFn: ({ signal }) => api<Logins>(`${agentPath(id)}/logins`, { signal }),
  });

export const heldActionsQuery = (id: string) =>
  queryOptions({
    queryKey: ["held-actions", id],
    queryFn: ({ signal }) =>
      api<HeldAction[]>(`${agentPath(id)}/held-actions`, { signal }),
  });

export const heldActionPath = (id: string, actionId: string) =>
  `${agentPath(id)}/held-actions/${encodeURIComponent(actionId)}`;

export const judgeModelQuery = queryOptions({
  queryKey: ["judge-model"],
  queryFn: ({ signal }) => api<JudgeModel>("/v1/judge-model", { signal }),
});

export const pluginSettingsQuery = queryOptions({
  queryKey: ["plugin-settings"],
  queryFn: ({ signal }) =>
    api<PluginSettings>("/v1/plugin-settings", { signal }),
});

export const pluginSettingPath = (pluginId: string, key: string) =>
  `/v1/plugin-settings/${encodeURIComponent(pluginId)}/${encodeURIComponent(key)}`;

export const messageGatewaysQuery = queryOptions({
  queryKey: ["message-gateways"],
  queryFn: async ({ signal }) =>
    (
      await api<z.infer<typeof gatewaysResponse>>("/v1/message-gateways", {
        signal,
      })
    ).gateways,
  refetchInterval: 5000,
});

export const eventRelayQuery = queryOptions({
  queryKey: ["event-relay"],
  queryFn: ({ signal }) => api<RelayStatus>("/v1/event-relay", { signal }),
  // The connection advances on the server, so poll while it connects.
  refetchInterval: (query) =>
    query.state.data?.status === "connecting" ? 1000 : false,
});

export const eventSourcesQuery = queryOptions({
  queryKey: ["event-sources"],
  queryFn: async ({ signal }) =>
    (
      await api<z.infer<typeof eventSourcesResponse>>("/v1/event-sources", {
        signal,
      })
    ).sources,
});

export const eventSourcePath = (id: string) =>
  `/v1/event-sources/${encodeURIComponent(id)}`;

export const messageGatewayPath = (id: string) =>
  `/v1/message-gateways/${encodeURIComponent(id)}`;

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

export const loginPath = (id: string, name: string) =>
  `${agentPath(id)}/logins/${encodeURIComponent(name)}`;

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
