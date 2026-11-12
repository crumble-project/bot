import { queryOptions } from "@tanstack/react-query";
import type { CallRequest } from "@crumble/server/contract/voice-gateway";
import { agentPath } from "@/features/bots/api";
import { historyPage } from "@/features/chat/api";
import { api } from "@/lib/api";

export type { CallRequest };

const CALL_POLL_MS = 5000;

export const callRequestsQuery = (id: string) =>
  queryOptions({
    queryKey: ["call-requests", id],
    queryFn: ({ signal }) =>
      api<"listCallRequests">(`${agentPath(id)}/call-requests`, { signal }),
    // Another client can decide a request, and a call ends without the owner.
    refetchInterval: (query) =>
      query.state.data?.some(
        (request) =>
          request.status === "pending" || request.status === "calling",
      )
        ? CALL_POLL_MS
        : false,
  });

export const callRequestPath = (id: string, requestId: string) =>
  `${agentPath(id)}/call-requests/${encodeURIComponent(requestId)}` as const;

const LIVE_CALL_POLL_MS = 2000;

/** `live`: the call is going on, so the transcript grows. */
export const callTranscriptQuery = (
  id: string,
  requestId: string,
  live = false,
) =>
  queryOptions({
    queryKey: ["call-request-transcript", id, requestId],
    queryFn: ({ signal }) =>
      api<"callRequestTranscript">(
        historyPage(`${callRequestPath(id, requestId)}/transcript`, 200),
        { signal },
      ),
    refetchInterval: live ? LIVE_CALL_POLL_MS : false,
  });

export const CALL_OUTCOMES: Record<
  NonNullable<CallRequest["outcome"]>,
  string
> = {
  answered: "Answered",
  unanswered: "Not answered",
  busy: "Busy",
  failed: "Failed",
};

export const callStateOf = (request: CallRequest) => {
  if (request.status === "declined") return "Declined";

  if (request.status === "calling") return "Calling";

  return request.outcome ? CALL_OUTCOMES[request.outcome] : "Ended";
};
