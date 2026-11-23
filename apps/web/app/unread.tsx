import { useRouter } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { useUnread } from "@/lib/notifications";

export function useBotUnread(id: string) {
  const router = useRouter();

  return useUnread(
    router.buildLocation({ to: "/bots/$botId", params: { botId: id } })
      .pathname,
  );
}

export function UnreadDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-[11px] shrink-0 rounded-full bg-bot-strong ring-2 ring-sidebar",
        className,
      )}
    />
  );
}
