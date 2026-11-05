import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { IconHandStop } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettledCard, useFreshRequest } from "@/components/request-card";
import { messageCard } from "@/features/chat/message-card";
import { type HeldAction, heldActionPath, heldActionsQuery } from "./api";
import { queryClient, send } from "@/lib/api";

const OUTCOMES: Record<Exclude<HeldAction["status"], "pending">, string> = {
  approved: "Approved",
  declined: "Declined",
  expired: "Expired",
};

/** A desktop job action an intent check held: the owner approves or declines it here. */
function HeldActionCard({
  held,
  title,
  botId,
}: {
  held: { id: string; job: string };
  title: string;
  botId: string;
}) {
  const heldIn = (actions: HeldAction[]) =>
    actions.find((item) => item.id === held.id);

  // A settled action stays settled; a waiting one in the cache may have ended since.
  const { data, reading } = useFreshRequest(
    heldActionsQuery(botId),
    (actions) => {
      const action = heldIn(actions);

      return action !== undefined && action.status !== "pending";
    },
  );

  const action = data && heldIn(data);

  if (reading || !action)
    return (
      <SettledCard
        icon={IconHandStop}
        title={title}
        outcome={reading ?? "Unavailable"}
      />
    );

  if (action.status !== "pending")
    return (
      <SettledCard
        icon={IconHandStop}
        title={title}
        outcome={OUTCOMES[action.status]}
      />
    );

  return <HeldActionPending action={action} botId={botId} />;
}

function HeldActionPending({
  action,
  botId,
}: {
  action: HeldAction;
  botId: string;
}) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  const decide = useMutation({
    mutationFn: (decision: "approve" | "decline") =>
      decision === "decline"
        ? send<"declineAgentHeldAction">(
            `${heldActionPath(botId, action.id)}/decline`,
            "POST",
            { reason: reason.trim() || undefined },
          )
        : send<"approveAgentHeldAction">(
            `${heldActionPath(botId, action.id)}/approve`,
            "POST",
          ),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: heldActionsQuery(botId).queryKey,
      }),
  });

  return (
    <div className="flex w-full max-w-sm flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <IconHandStop className="mt-0.5 size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">
            {action.job} is waiting for your approval
          </div>
          <div className="text-sm font-medium">{action.action}</div>
          {action.page && (
            <div className="truncate text-xs text-muted-foreground">
              {action.page}
            </div>
          )}
        </div>
      </div>
      <CheckedAgainst action={action} />
      {decide.isError && (
        <p className="text-xs text-destructive">{decide.error.message}</p>
      )}
      {declining && (
        <Input
          aria-label="Reason"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          autoFocus
        />
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={decide.isPending}
          onClick={() =>
            declining ? decide.mutate("decline") : setDeclining(true)
          }
        >
          Decline
        </Button>
        {!declining && (
          <Button
            size="sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate("approve")}
          >
            Approve
          </Button>
        )}
      </div>
    </div>
  );
}

function CheckedAgainst({ action }: { action: HeldAction }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="text-xs text-muted-foreground">
      <p>{action.reason}</p>
      <button
        type="button"
        className="underline"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide your messages" : "Checked against your messages"}
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-2">
          {action.ownerMessages.length ? (
            action.ownerMessages.map((message) => (
              <li
                key={message.requestId}
                className="border-l-2 pl-2 whitespace-pre-wrap"
              >
                {message.from === "automation" && (
                  <span className="font-medium">Automation: </span>
                )}
                {message.text}
              </li>
            ))
          ) : (
            <li>None: the job had no message from you.</li>
          )}
        </ul>
      )}
    </div>
  );
}

export const heldActionEvent = messageCard(
  ({ kind, heldAction, content }) =>
    kind === "held-action" && heldAction
      ? { held: heldAction, title: content }
      : null,
  ({ result, chat }) => <HeldActionCard botId={chat.botId} {...result} />,
);
