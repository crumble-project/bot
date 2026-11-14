import { type ComponentType, type ReactNode, type Ref, useState } from "react";
import type { ReplyReference } from "@crumble/server/contract/push";
import { ReplyAttention } from "@/features/chat/reply-attention";
import type { UseQueryOptions } from "@tanstack/react-query";
import type { TablerIcon } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { SettledCard, useFreshRequest } from "@/components/request-card";
import type { Bot } from "@/features/bots/api";
import { messageCard } from "@/features/chat/message-card";
import { toolDetailsOf } from "@/features/chat/tool-details";
import { ownerRequestDetails } from "@crumble/server/contract/tool-details";
import {
  type Named,
  type SecretRequest,
  useSecretActions,
} from "./bot-secrets";

type AskedRequest = SecretRequest & { requestedAt?: string | undefined };

function SecretRequestCard<D, R extends AskedRequest>({
  icon,
  asked,
  query,
  requestsOf,
  savedOf,
  references,
  children,
}: {
  icon: TablerIcon;
  asked: { name: string; requestedAt?: string | undefined };
  query: UseQueryOptions<D, Error, D, string[]>;
  requestsOf: (data: D) => R[];
  savedOf: (data: D) => Named[];
  references: readonly ReplyReference[];
  children: (request: R, ref: Ref<HTMLDivElement>) => ReactNode;
}) {
  const waitingIn = (data: D) =>
    requestsOf(data).find(
      (item) =>
        item.name === asked.name &&
        (!asked.requestedAt || item.requestedAt === asked.requestedAt),
    );

  const { data, reading } = useFreshRequest(
    query,
    (list) => waitingIn(list) !== undefined,
  );

  const waiting = data && waitingIn(data);
  const [element, setElement] = useState<HTMLDivElement | null>(null);

  const attention = (
    <ReplyAttention
      element={element}
      ready={reading === null && data !== undefined}
      references={references}
    />
  );

  if (waiting)
    return (
      <>
        {attention}
        {children(waiting, setElement)}
      </>
    );

  const saved = data && savedOf(data).some((item) => item.name === asked.name);

  return (
    <>
      {attention}
      <SettledCard
        ref={setElement}
        icon={icon}
        title={asked.name}
        outcome={reading ?? (saved ? "Saved" : "Declined")}
      />
    </>
  );
}

function SecretRequestHeading({
  icon: Icon,
  request,
}: {
  icon: TablerIcon;
  request: Named;
}) {
  const [expanded, setExpanded] = useState(false);
  const more = request.hosts.length - 1;

  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{request.name}</div>
        <div className="flex flex-wrap gap-x-1 text-xs text-muted-foreground">
          {(expanded ? request.hosts : request.hosts.slice(0, 1)).map(
            (host) => (
              <span key={host}>{host}</span>
            ),
          )}
          {more > 0 && (
            <button
              type="button"
              className="underline"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show less" : `${more} more`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SecretRequestPending({
  icon: Icon,
  request,
  botId,
  pathOf,
  refresh,
  addLabel,
  cardRef,
  children,
}: {
  icon: TablerIcon;
  request: Named;
  botId: string;
  pathOf: Parameters<typeof useSecretActions>[0];
  refresh: (botId: string) => Promise<void>;
  addLabel: string;
  cardRef: Ref<HTMLDivElement>;
  children: (onClose: () => void) => ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const { decline } = useSecretActions(pathOf, refresh);

  return (
    <div
      ref={cardRef}
      className="flex w-full max-w-sm flex-col gap-3 rounded-xl border p-4"
    >
      <SecretRequestHeading icon={Icon} request={request} />
      {decline.isError && (
        <p className="text-xs text-destructive">{decline.error.message}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => decline.mutate({ botId, item: request.name })}
          disabled={decline.isPending}
        >
          Decline
        </Button>
        <Button size="sm" onClick={() => setAdding(true)}>
          {addLabel}
        </Button>
      </div>
      {adding && children(() => setAdding(false))}
    </div>
  );
}

export const secretRequestResult = <D, R extends AskedRequest>({
  tool,
  icon,
  query,
  requestsOf,
  savedOf,
  pathOf,
  refresh,
  addLabel,
  Sheet,
}: {
  tool: string;
  icon: TablerIcon;
  query: (botId: string) => UseQueryOptions<D, Error, D, string[]>;
  requestsOf: (data: D) => R[];
  savedOf: (data: D) => Named[];
  pathOf: Parameters<typeof useSecretActions>[0];
  refresh: (botId: string) => Promise<void>;
  addLabel: string;
  Sheet: ComponentType<{
    bots: Bot[];
    botId: string;
    existing: null;
    request: R;
    onClose: () => void;
  }>;
}) =>
  messageCard(
    (message) => toolDetailsOf(message, ownerRequestDetails, tool),
    ({ result, chat: { botId, replyReferences = [] } }) => (
      <SecretRequestCard
        icon={icon}
        asked={result}
        query={query(botId)}
        requestsOf={requestsOf}
        savedOf={savedOf}
        references={replyReferences}
      >
        {(request, cardRef) => (
          <SecretRequestPending
            icon={icon}
            cardRef={cardRef}
            request={request}
            botId={botId}
            pathOf={pathOf}
            refresh={refresh}
            addLabel={addLabel}
          >
            {(onClose) => (
              <Sheet
                bots={[]}
                botId={botId}
                existing={null}
                request={request}
                onClose={onClose}
              />
            )}
          </SecretRequestPending>
        )}
      </SecretRequestCard>
    ),
  );
