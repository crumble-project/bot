import type { ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IconPhone } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SettledCard, useFreshRequest } from "@/components/request-card";
import type { Message } from "@/features/chat/api";
import { type CardChat, messageCard } from "@/features/chat/message-card";
import { toolDetailsOf } from "@/features/chat/tool-details";
import { call, queryClient } from "@/lib/api";
import { callRequestResponse } from "@crumble/server/contract/voice-gateway";
import { REQUEST_CALL_TOOL_NAME } from "@crumble/server/contract/tools";
import {
  type CallRequest,
  callRequestPath,
  callRequestsQuery,
  callStateOf,
} from "./api";

const callRequestOf = (message: Message): CallRequest | null =>
  toolDetailsOf(message, callRequestResponse, REQUEST_CALL_TOOL_NAME);

function CallRequestCard({
  request,
  botId,
  onOpen,
}: {
  request: CallRequest;
  botId: string;
  onOpen: (requestId: string) => void;
}) {
  const requestIn = (requests: CallRequest[]) =>
    requests.find((item) => item.id === request.id);

  // Declined and ended requests stay so; a pending or calling one in the cache may have moved on.
  const { data, reading } = useFreshRequest(
    callRequestsQuery(botId),
    (requests) => {
      const status = requestIn(requests)?.status;

      return status === "declined" || status === "ended";
    },
  );

  const live = data && requestIn(data);

  if (reading || !live)
    return (
      <SettledCard
        icon={IconPhone}
        title={request.callee}
        outcome={reading ?? "Unavailable"}
      />
    );

  if (live.status === "pending")
    return <CallRequestPending request={live} botId={botId} />;

  if (live.status === "declined")
    return (
      <SettledCard icon={IconPhone} title={live.callee} outcome="Declined" />
    );

  return <CallRequestPlaced request={live} onOpen={() => onOpen(live.id)} />;
}

function useDecideCallRequest(botId: string, requestId: string) {
  const { queryKey } = callRequestsQuery(botId);

  return useMutation({
    mutationFn: (decision: "approve" | "decline") =>
      decision === "approve"
        ? call<"approveCallRequest">(
            `${callRequestPath(botId, requestId)}/approve`,
            "POST",
          )
        : call<"declineCallRequest">(
            `${callRequestPath(botId, requestId)}/decline`,
            "POST",
          ),
    onSuccess: (decided: CallRequest) =>
      queryClient.setQueryData<CallRequest[]>(queryKey, (requests) =>
        requests?.map((item) => (item.id === decided.id ? decided : item)),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

function CallRequestSummary({ request }: { request: CallRequest }) {
  return (
    <div className="flex items-start gap-3">
      <IconPhone className="mt-0.5 size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">
          Wants to call for you
        </div>
        <div className="text-sm font-medium">{request.callee}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {request.number}
        </div>
      </div>
    </div>
  );
}

function CallRequestPending({
  request,
  botId,
}: {
  request: CallRequest;
  botId: string;
}) {
  const decide = useDecideCallRequest(botId, request.id);

  return (
    <div className="flex w-full max-w-sm flex-col gap-3 rounded-xl border p-4">
      <CallRequestSummary request={request} />
      <p className="text-sm whitespace-pre-wrap">{request.goal}</p>
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">
          Check that the opening says it's an AI assistant, whom it calls for,
          that the call is transcribed, and why it calls.
        </p>
        <blockquote className="border-l-2 pl-2 text-sm whitespace-pre-wrap text-muted-foreground">
          {request.opening}
        </blockquote>
      </div>
      {decide.isError && (
        <p className="text-xs text-destructive">{decide.error.message}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={decide.isPending}
          onClick={() => decide.mutate("decline")}
        >
          Decline
        </Button>
        <Button
          size="sm"
          disabled={decide.isPending}
          onClick={() => decide.mutate("approve")}
        >
          Approve
        </Button>
      </div>
    </div>
  );
}

function CallRequestPlaced({
  request,
  detail,
  onOpen,
}: {
  request: CallRequest;
  detail?: string | undefined;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full max-w-sm flex-col gap-2 rounded-xl border p-3 text-left hover:bg-muted/50"
      onClick={onOpen}
    >
      <span className="flex w-full items-center gap-3">
        {request.status === "calling" ? (
          <Spinner
            aria-label="Calling"
            className="size-4 text-muted-foreground"
          />
        ) : (
          <IconPhone className="size-4 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {request.callee}
        </span>
        <span className="text-xs text-muted-foreground">
          {callStateOf(request)}
        </span>
      </span>
      {detail ? (
        <span className="pl-7 text-xs text-muted-foreground first-letter:uppercase">
          {detail}
        </span>
      ) : (
        request.outcome === "failed" &&
        request.error && (
          <span className="pl-7 text-xs text-muted-foreground">
            {request.error}
          </span>
        )
      )}
    </button>
  );
}

const ENDED_CALL = /^voice-call:([^:]+):ended$/u;
const SWEPT_REQUEST = /^call-request:([^:]+)$/u;

/** The call request an end notice belongs to; owner calls have none. */
function noticeRequest(message: Message, requests: CallRequest[]) {
  const callId = ENDED_CALL.exec(message.requestId ?? "")?.[1];
  const requestId = SWEPT_REQUEST.exec(message.requestId ?? "")?.[1];

  return requests.find(
    (request) =>
      (callId !== undefined && request.callId === callId) ||
      request.id === requestId,
  );
}

/** What the notice says after the callee's name: "ended after 2 minutes: the bot hung up." */
function noticeDetail(message: Message, request: CallRequest) {
  const lead = `Call to ${request.callee} `;

  return message.content.startsWith(lead)
    ? message.content.slice(lead.length)
    : message.content;
}

function OutsideCallNotice({
  message,
  chat,
  fallback,
}: {
  message: Message;
  chat: CardChat;
  fallback: ReactNode;
}) {
  const requests = useQuery(callRequestsQuery(chat.botId));
  const request = noticeRequest(message, requests.data ?? []);

  if (!request || request.status === "declined") return fallback;

  return (
    <CallRequestPlaced
      request={request}
      detail={noticeDetail(message, request)}
      onOpen={() => chat.onOpenCall(request.id)}
    />
  );
}

/** An outside call's end notice as one card that opens the call; any other notice keeps its row. */
export function CallNotice({
  message,
  chat,
  fallback,
}: {
  message: Message;
  chat: CardChat;
  fallback: ReactNode;
}) {
  const origin = message.origin?.kind;

  return origin === "call" || origin === "call_request" ? (
    <OutsideCallNotice message={message} chat={chat} fallback={fallback} />
  ) : (
    fallback
  );
}

export const callRequestResult = messageCard(
  callRequestOf,
  ({ result, chat }) => (
    <CallRequestCard
      request={result}
      botId={chat.botId}
      onOpen={chat.onOpenCall}
    />
  ),
);
