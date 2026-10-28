import { useEffect, useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  type UseMutationResult,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft02Icon,
  RefreshIcon,
  ZzzIcon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { MobileSidebarTrigger } from "@/components/workspace";
import {
  type DesktopControl,
  type DesktopViewer,
  agentPath,
  botsQuery,
  call,
  desktopStatusQuery,
  follow,
} from "@/lib/api";

function useDesktopControl(path: string) {
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

  return { control, take };
}

function DesktopControls({
  control,
  take,
  viewer,
  onReconnect,
}: {
  control: DesktopControl | null;
  take: ReturnType<typeof useDesktopControl>["take"];
  viewer: UseMutationResult<DesktopViewer, Error, void>;
  onReconnect: () => void;
}) {
  const owner = control?.holder === "owner";

  return (
    <div className="ml-auto flex items-center gap-2">
      {take.isPending && <Spinner />}
      <Button
        variant="ghost"
        size="sm"
        disabled={viewer.isPending}
        onClick={onReconnect}
      >
        <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" />
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
  );
}

/** Watch a bot's desktop, and take control from its desktop job or hand it back. */
export function BotDesktop({ botId }: { botId: string }) {
  const bot = useQuery(botsQuery).data?.find((each) => each.id === botId);
  const path = agentPath(botId);
  const { control, take } = useDesktopControl(path);

  // The viewer link works once, so every connection needs a fresh one.
  const viewer = useMutation({
    mutationFn: () => call<DesktopViewer>(`${path}/desktop/viewer`, "POST"),
  });

  const { mutate: connect } = viewer;

  useEffect(() => connect(), [connect]);

  const owner = control?.holder === "owner";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <MobileSidebarTrigger />
        <Button
          variant="ghost"
          size="icon-sm"
          title="Back to chat"
          render={<Link to="/bots/$botId" params={{ botId }} />}
          nativeButton={false}
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} />
        </Button>
        <span className="truncate font-medium">
          {bot ? `${bot.name}'s desktop` : "Bot desktop"}
        </span>
        <span className="text-sm text-muted-foreground">
          {control ? controlLabel(owner) : null}
        </span>
        <DesktopControls
          control={control}
          take={take}
          viewer={viewer}
          onReconnect={() => connect()}
        />
      </header>
      {take.isError && (
        <Alert variant="destructive" className="m-4 w-auto">
          <AlertDescription>{take.error.message}</AlertDescription>
        </Alert>
      )}
      <ViewerPane viewer={viewer} />
      {owner && (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          The bot's desktop job waits while you have control. Hand back when
          you're done.
        </p>
      )}
    </div>
  );
}

/** A small live view of a bot's desktop that opens the full desktop. */
export function DesktopPreview({ botId }: { botId: string }) {
  const path = agentPath(botId);
  const [asked, setAsked] = useState(false);

  // Machine state has no live event, so poll it.
  const status = useQuery({
    ...desktopStatusQuery(botId),
    refetchInterval: 10_000,
  });

  const live = asked || status.data?.running === true;

  // Until asked, the link only watches: it neither boots the machine nor keeps it awake.
  const viewer = useMutation({
    mutationFn: () =>
      call<DesktopViewer>(
        `${path}/desktop/viewer${asked ? "" : "?passive=true"}`,
        "POST",
      ),
  });

  const { mutate: connect, reset } = viewer;

  useEffect(() => {
    if (live) connect();
    else reset();
  }, [live, connect, reset]);

  if (!live)
    return (
      <button
        type="button"
        title="Wake the bot desktop"
        className="flex aspect-video w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border bg-black text-white/60 transition-colors hover:text-white/85 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        onClick={() => setAsked(true)}
      >
        <HugeiconsIcon icon={ZzzIcon} />
        <span className="text-sm">Sleeping</span>
        <span className="text-xs text-white/40">Click to wake</span>
      </button>
    );

  return (
    <Link
      to="/bots/$botId/desktop"
      params={{ botId }}
      title="Open the bot desktop"
      className="relative block aspect-video overflow-hidden rounded-lg border bg-black"
    >
      {viewer.isPending && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner className="text-white/70" />
        </span>
      )}
      {viewer.isError && (
        <span className="absolute inset-0 flex items-center justify-center p-3 text-center text-xs text-white/60">
          {viewer.error.message}
        </span>
      )}
      {viewer.data && (
        <iframe
          key={viewer.data.path}
          title="Bot desktop preview"
          src={viewer.data.path}
          tabIndex={-1}
          className="pointer-events-none size-full border-0"
        />
      )}
    </Link>
  );
}

const controlLabel = (owner: boolean) =>
  owner ? "You have control" : "The bot has control";

function ViewerPane({
  viewer,
}: {
  viewer: UseMutationResult<DesktopViewer, Error, void>;
}) {
  return (
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
  );
}
