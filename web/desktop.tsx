import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  type DesktopControl,
  type DesktopViewer,
  agentPath,
  botsQuery,
  call,
  follow,
} from "./api";

/** Watch a bot's desktop, and take control from its desktop job or hand it back. */
export function BotDesktop({ botId }: { botId: string }) {
  const bot = useQuery(botsQuery).data?.find((each) => each.id === botId);
  const path = agentPath(botId);
  const [control, setControl] = useState<DesktopControl | null>(null);
  const holder = useRef<DesktopControl["holder"]>("bot");

  // Responses and events can arrive out of order; keep the latest change.
  const apply = (next: DesktopControl) =>
    setControl((current) =>
      current && current.changes > next.changes ? current : next,
    );

  useEffect(() => {
    holder.current = control?.holder ?? "bot";
  }, [control]);

  // The viewer link works once, so every connection needs a fresh one.
  const viewer = useMutation({
    mutationFn: () => call<DesktopViewer>(`${path}/desktop/viewer`, "POST"),
  });

  const { mutate: connect } = viewer;

  useEffect(() => connect(), [connect]);

  useEffect(() => {
    const controller = new AbortController();

    void follow(
      `${path}/desktop/events`,
      {
        onEvent: (event, data) => {
          if (event === "control") apply(JSON.parse(data));
        },
      },
      controller.signal,
    );

    return () => {
      controller.abort();

      // Leaving the desktop hands control back, so the bot's job can continue.
      if (holder.current === "owner")
        void call(`${path}/desktop/control`, "PUT", { holder: "bot" });
    };
  }, [path]);

  const take = useMutation({
    mutationFn: (next: DesktopControl["holder"]) =>
      call<DesktopControl, { holder: DesktopControl["holder"] }>(
        `${path}/desktop/control`,
        "PUT",
        { holder: next },
      ),
    onSuccess: apply,
  });

  const owner = control?.holder === "owner";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Button
          variant="ghost"
          size="icon-sm"
          title="Back to chat"
          render={<Link to="/bots/$botId" params={{ botId }} />}
          nativeButton={false}
        >
          <ArrowLeftIcon />
        </Button>
        <span className="truncate font-medium">
          {bot ? `${bot.name}'s desktop` : "Bot desktop"}
        </span>
        <span className="text-sm text-muted-foreground">
          {control
            ? owner
              ? "You have control"
              : "The bot has control"
            : null}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {take.isPending && <Spinner />}
          <Button
            variant="ghost"
            size="sm"
            disabled={viewer.isPending}
            onClick={() => connect()}
          >
            <RefreshCwIcon data-icon="inline-start" />
            Reconnect
          </Button>
          <Button
            size="sm"
            variant={owner ? "outline" : "default"}
            disabled={!control || take.isPending}
            onClick={() => take.mutate(owner ? "bot" : "owner")}
          >
            {owner ? "Hand back" : "Take control"}
          </Button>
        </div>
      </header>
      {take.isError && (
        <Alert variant="destructive" className="m-4 w-auto">
          <AlertDescription>{take.error.message}</AlertDescription>
        </Alert>
      )}
      <div className="relative min-h-0 flex-1 bg-muted">
        {viewer.isPending && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Connecting
          </div>
        )}
        {viewer.isError && (
          <Alert variant="destructive" className="m-6 w-auto">
            <AlertTitle>Can't show the bot desktop</AlertTitle>
            <AlertDescription>{viewer.error.message}</AlertDescription>
          </Alert>
        )}
        {viewer.data && (
          <iframe
            key={viewer.data.path}
            title="Bot desktop"
            src={viewer.data.path}
            className="size-full border-0"
          />
        )}
      </div>
      {owner && (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          The bot's desktop job waits while you have control. Hand back when
          you're done.
        </p>
      )}
    </div>
  );
}
