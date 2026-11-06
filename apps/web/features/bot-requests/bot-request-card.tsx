import { type ComponentProps, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { IconPencil, IconUsersGroup } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SettledCard } from "@/components/request-card";
import {
  type Bot,
  type BotInput,
  botsQuery,
  invalidateBots,
} from "@/features/bots/api";
import { BotAvatar } from "@/components/bot-avatar";
import { BotFields, useBotFields } from "@/features/bots/bot-fields";
import { CAPABILITIES } from "@/features/bots/capabilities";
import { toolDetailsOf } from "@/features/chat/tool-details";
import { messageCard } from "@/features/chat/message-card";
import type { Message } from "@/features/chat/api";
import { mcpServersQuery } from "@/features/integrations/api";
import { call, queryClient } from "@/lib/api";
import { defaultAvatarDefinition } from "@crumble/server/contract/avatar";
import { botRequestDetails } from "@crumble/server/contract/tool-details";
import { REQUEST_BOT_TOOL_NAME } from "@crumble/server/contract/tools";
import { type BotRequest, botRequestPath, botRequestsQuery } from "./api";

const botRequestOf = (message: Message): BotRequest | null =>
  toolDetailsOf(message, botRequestDetails, REQUEST_BOT_TOOL_NAME);

function BotRequestCard({
  request,
  botId,
}: {
  request: BotRequest;
  botId: string;
}) {
  const [open, setOpen] = useState(false);
  const current = useQuery(botRequestsQuery(botId));
  const live = current.data?.find((item) => item.id === request.id) ?? request;

  const { approve, decline } = useBotRequestMutations(
    botId,
    request.id,
    setOpen,
  );

  if (live.status !== "pending") return <BotRequestSettled request={live} />;

  return (
    <BotPendingCard
      live={live}
      requestId={request.id}
      open={open}
      setOpen={setOpen}
      onApprove={(proposal) => approve.mutate(proposal)}
      onDecline={() => decline.mutate()}
      approvePending={approve.isPending}
      declinePending={decline.isPending}
      approveError={approve.isError ? (approve.error?.message ?? "") : ""}
      declineError={decline.isError ? (decline.error?.message ?? "") : ""}
    />
  );
}

function BotRequestSettled({ request }: { request: BotRequest }) {
  return (
    <SettledCard
      icon={IconUsersGroup}
      title={request.proposal.name}
      outcome={request.status === "approved" ? "Approved" : "Declined"}
      action={
        request.createdAgentId ? (
          <Button
            render={
              <Link
                to="/bots/$botId"
                params={{ botId: request.createdAgentId }}
              />
            }
            size="xs"
            variant="outline"
          >
            Open chat
          </Button>
        ) : undefined
      }
    />
  );
}

function useBotRequestMutations(
  botId: string,
  requestId: string,
  setOpen: (open: boolean) => void,
) {
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: botRequestsQuery(botId).queryKey,
    });

  const approve = useMutation({
    mutationFn: (proposal?: BotInput) =>
      call<"approveBotRequest">(
        `${botRequestPath(botId, requestId)}/approve`,
        "POST",
        proposal ? { proposal } : undefined,
      ),
    onSuccess: ({ agent }) => {
      setOpen(false);
      queryClient.setQueryData<Bot[]>(botsQuery.queryKey, (bots) =>
        !bots || bots.some((bot) => bot.id === agent.id)
          ? bots
          : [...bots, agent],
      );
      void refresh();
      void invalidateBots();
    },
    onError: refresh,
  });

  const decline = useMutation({
    mutationFn: () =>
      call<"declineBotRequest">(
        `${botRequestPath(botId, requestId)}/decline`,
        "POST",
      ),
    onSuccess: refresh,
    onError: refresh,
  });

  return { approve, decline };
}

function BotRequestEditSheet({
  open,
  setOpen,
  requestId,
  proposal,
  error,
  pending,
  onSubmit,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  requestId: string;
  proposal: BotRequest["proposal"];
  error: string;
  pending: boolean;
  onSubmit: (proposal?: BotInput) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Edit bot proposal</SheetTitle>
          <SheetDescription>
            Review the proposed bot before approving it.
          </SheetDescription>
        </SheetHeader>
        <BotRequestEditor
          requestId={requestId}
          proposal={proposal}
          error={error}
          pending={pending}
          onSubmit={onSubmit}
        />
      </SheetContent>
    </Sheet>
  );
}

function BotPendingCard({
  live,
  requestId,
  open,
  setOpen,
  onApprove,
  onDecline,
  approvePending,
  declinePending,
  approveError,
  declineError,
}: {
  live: BotRequest;
  requestId: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  onApprove: (proposal?: BotInput) => void;
  onDecline: () => void;
  approvePending: boolean;
  declinePending: boolean;
  approveError: string;
  declineError: string;
}) {
  return (
    <div className="flex w-full max-w-sm flex-col gap-3 rounded-xl border p-4">
      <BotRequestHeader
        requestId={requestId}
        proposal={live.proposal}
        onEdit={() => setOpen(true)}
      />
      <p className="text-sm text-muted-foreground">
        {live.proposal.description}
      </p>
      <BotRequestBadges proposal={live.proposal} />
      {(approveError || declineError) && (
        <p className="text-xs text-destructive">
          {approveError || declineError}
        </p>
      )}
      <BotRequestActions
        onDecline={onDecline}
        onApprove={() => onApprove()}
        busy={approvePending || declinePending}
      />
      <BotRequestEditSheet
        open={open}
        setOpen={setOpen}
        requestId={requestId}
        proposal={live.proposal}
        error={approveError}
        pending={approvePending}
        onSubmit={onApprove}
      />
    </div>
  );
}

function BotRequestHeader({
  requestId,
  proposal,
  onEdit,
}: {
  requestId: string;
  proposal: BotRequest["proposal"];
  onEdit: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <BotAvatar
        bot={{
          id: requestId,
          avatar: proposal.avatar ?? defaultAvatarDefinition(requestId),
        }}
        size={32}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{proposal.name}</div>
        <div className="text-xs text-muted-foreground">
          {proposal.provider} · {proposal.model}
        </div>
      </div>
      <Button variant="ghost" size="icon-xs" title="Edit" onClick={onEdit}>
        <IconPencil />
      </Button>
    </div>
  );
}

function BotRequestBadges({ proposal }: { proposal: BotRequest["proposal"] }) {
  const servers = useQuery(mcpServersQuery);

  const serverNames = new Map(
    (servers.data ?? []).map((server) => [server.id, server.name]),
  );

  return (
    <div className="flex flex-wrap gap-1">
      {proposal.tools.map((tool) => (
        <Badge key={tool} variant="outline">
          {CAPABILITIES.find((capability) => capability.tool === tool)?.label ??
            tool}
        </Badge>
      ))}
      {proposal.mcpServers.map((server) => (
        <Badge key={server} variant="secondary">
          {serverNames.get(server) ?? server}
        </Badge>
      ))}
    </div>
  );
}

function BotRequestActions({
  onDecline,
  onApprove,
  busy,
}: {
  onDecline: () => void;
  onApprove: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onClick={onDecline} disabled={busy}>
        Decline
      </Button>
      <Button size="sm" onClick={onApprove} disabled={busy}>
        Approve
      </Button>
    </div>
  );
}

function BotRequestEditor({
  requestId,
  proposal,
  error,
  pending,
  onSubmit,
}: {
  requestId: string;
  proposal: BotRequest["proposal"];
  error?: string;
  pending: boolean;
  onSubmit: NonNullable<ComponentProps<typeof BotFields>["onSubmit"]>;
}) {
  const formId = `bot-request-${requestId}`;
  const fields = useBotFields(proposal);

  return (
    <>
      <div className="p-4">
        <BotFields formId={formId} fields={fields} onSubmit={onSubmit} />
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      </div>
      <SheetFooter>
        <Button
          type="submit"
          form={formId}
          disabled={pending || fields.invalid}
        >
          Approve
        </Button>
      </SheetFooter>
    </>
  );
}

export const botRequestResult = messageCard(
  botRequestOf,
  ({ result, chat }) => <BotRequestCard request={result} botId={chat.botId} />,
);
