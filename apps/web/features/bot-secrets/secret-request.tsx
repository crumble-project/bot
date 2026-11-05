import { type ReactNode, useState } from "react";
import type { UseQueryOptions } from "@tanstack/react-query";
import type { TablerIcon } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { SettledCard, useFreshRequest } from "@/components/request-card";
import {
  type Named,
  type SecretRequest,
  useSecretActions,
} from "./bot-secrets";

/** A bot's request in the chat: the card `children` makes of it while it waits, then its outcome. */
export function SecretRequestCard<
  D,
  R extends SecretRequest & { requestedAt?: string | undefined },
>({
  icon,
  asked,
  query,
  requestsOf,
  savedOf,
  children,
}: {
  icon: TablerIcon;
  asked: { name: string; requestedAt?: string | undefined };
  query: UseQueryOptions<D, Error, D, string[]>;
  requestsOf: (data: D) => R[];
  /** The bot's saved items of this type. */
  savedOf: (data: D) => Named[];
  children: (request: R) => ReactNode;
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

  if (waiting) return children(waiting);

  const saved = data && savedOf(data).some((item) => item.name === asked.name);

  return (
    <SettledCard
      icon={icon}
      title={asked.name}
      outcome={reading ?? (saved ? "Saved" : "Declined")}
    />
  );
}

/** A request the owner hasn't answered: decline it here, or open `children`'s sheet to add what it asks for. */
export function SecretRequestPending({
  icon: Icon,
  request,
  botId,
  pathOf,
  refresh,
  addLabel,
  children,
}: {
  icon: TablerIcon;
  request: Named;
  botId: string;
  pathOf: Parameters<typeof useSecretActions>[0];
  refresh: (botId: string) => Promise<void>;
  addLabel: string;
  children: (onClose: () => void) => ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { decline } = useSecretActions(pathOf, refresh);
  const more = request.hosts.length - 1;

  return (
    <div className="flex w-full max-w-sm flex-col gap-3 rounded-xl border p-4">
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
