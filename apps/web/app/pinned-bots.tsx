import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { IconPinnedOff } from "@tabler/icons-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { botColor, botStyle } from "@/components/bot-avatar";
import { StatusBotAvatar } from "@/features/bot-chat/avatar";
import type { Bot } from "@/features/bots/api";
import { botLabel } from "@/features/bots/status";
import { botPin } from "@/lib/pins";
import type { Pins } from "@/lib/pins";
import { cn } from "@/lib/utils";
import { UnreadDot, useBotUnread } from "./unread";

const CIRCLE = 60;
const AVATAR = 41;

type DraggedRef = { current: string | null };

function PinTile({
  bot,
  pins,
  active,
  draggedRef,
}: {
  bot: Bot;
  pins: Pins;
  active: boolean;
  draggedRef: DraggedRef;
}) {
  const key = botPin(bot.id);
  const [target, setTarget] = useState(false);
  const menuOpen = useRef(false);
  const unread = useBotUnread(bot.id);
  const label = botLabel(bot, { pinned: true, unread });

  return (
    <ContextMenu
      onOpenChange={(open) => {
        menuOpen.current = open;
      }}
    >
      <ContextMenuTrigger
        render={
          <li
            style={botStyle(botColor(bot))}
            draggable
            onDragStart={(event) => {
              draggedRef.current = key;
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (!draggedRef.current || draggedRef.current === key) {
                return;
              }

              event.preventDefault();
              setTarget(true);
            }}
            onDragLeave={() => setTarget(false)}
            onDrop={(event) => {
              event.preventDefault();
              setTarget(false);

              if (draggedRef.current) {
                pins.move(draggedRef.current, key);
              }

              draggedRef.current = null;
            }}
            onDragEnd={() => {
              draggedRef.current = null;
            }}
          />
        }
      >
        <Link
          to="/bots/$botId"
          params={{ botId: bot.id }}
          title={label}
          aria-label={label}
          data-active={active || undefined}
          onClick={(event) => {
            if (menuOpen.current) {
              event.preventDefault();
            }
          }}
          className="group/pin flex w-[72px] flex-col items-center gap-1 rounded-[10px] px-1.5 pt-[7px] pb-1 outline-hidden transition-[scale] focus-visible:ring-2 focus-visible:ring-sidebar-ring active:scale-[0.96] data-active:bg-bot-soft"
        >
          <span
            className={cn(
              "relative grid place-items-center rounded-full bg-background/70 transition-[background-color] group-hover/pin:bg-background group-data-active/pin:bg-background dark:bg-sidebar-accent dark:group-hover/pin:bg-sidebar-accent dark:group-data-active/pin:bg-sidebar-accent",
              target && "ring-2 ring-(--bot)/50",
            )}
            style={{ width: CIRCLE, height: CIRCLE }}
          >
            <StatusBotAvatar bot={bot} size={AVATAR} />
            {unread > 0 && <UnreadDot className="absolute top-0 left-0 z-10" />}
          </span>
          <span
            className={cn(
              "max-w-full truncate text-center text-[11px] leading-[14px] text-muted-foreground group-data-active/pin:font-semibold group-data-active/pin:text-foreground",
              unread > 0 && "font-semibold text-foreground",
              !bot.enabled && "opacity-60",
            )}
          >
            {bot.name}
          </span>
        </Link>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!pins.ready} onClick={() => pins.unpin(key)}>
          <IconPinnedOff />
          Unpin
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function PinnedBots({
  bots,
  pins,
  activeId,
}: {
  bots: Array<Bot>;
  pins: Pins;
  activeId: string | undefined;
}) {
  const draggedRef = useRef<string | null>(null);

  if (bots.length === 0) {
    return null;
  }

  return (
    <ul
      aria-label="Pinned bots"
      className="flex shrink-0 flex-wrap justify-center gap-x-0.5 gap-y-1 px-2 pt-2 pb-2.5"
    >
      {bots.map((bot) => (
        <PinTile
          key={bot.id}
          bot={bot}
          pins={pins}
          active={activeId === bot.id}
          draggedRef={draggedRef}
        />
      ))}
    </ul>
  );
}
