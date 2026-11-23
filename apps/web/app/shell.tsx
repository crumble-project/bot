import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useMatchRoute,
  useNavigate,
  useRouter,
  useRouterState,
  Outlet,
} from "@tanstack/react-router";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { botsQuery } from "@/features/bots/api";
import type { Bot } from "@/features/bots/api";
import { authClient } from "@/lib/auth-client";
import { setThemeColor, useAccountTheme, useTheme } from "@/lib/theme";
import { resetSession, signedOut } from "@/lib/session";
import { usePins } from "@/lib/pins";
import { followActivity } from "./activity-stream";
import { markSeen, useUnreadCount } from "@/lib/notifications";
import { CommandPalette } from "./command-palette";
import { AppSidebar } from "./sidebar";
import type { ReplyChat } from "@/lib/notifications";

function useResetOnUserChange(userId: string | undefined) {
  const previousUserId = useRef(userId);
  const navigate = useNavigate();

  useEffect(() => {
    if (
      previousUserId.current !== undefined &&
      previousUserId.current !== userId
    ) {
      if (!userId) {
        signedOut();
      } else {
        resetSession();
        void navigate({ to: "/" });
      }
    }

    previousUserId.current = userId;
  }, [navigate, userId]);
}

const chatLocation = ({ id }: ReplyChat) =>
  ({ to: "/bots/$botId", params: { botId: id } }) as const;

function useFollowActivity(userId: string | undefined) {
  const navigate = useNavigate();
  const router = useRouter();
  const path = useRouterState({ select: (state) => state.location.pathname });

  useEffect(markSeen, [path]);

  useEffect(() => {
    if (!userId) {
      return;
    }

    const controller = new AbortController();

    followActivity(
      {
        open: (chat) => void navigate(chatLocation(chat)),
        pathOf: (chat) => router.buildLocation(chatLocation(chat)).pathname,
      },
      controller.signal,
    );

    return () => controller.abort();
  }, [navigate, router, userId]);
}

function useDocumentTitle(bots: Array<Bot> | undefined) {
  const matchRoute = useMatchRoute();
  const unread = useUnreadCount();
  const bot = matchRoute({ to: "/bots/$botId" });
  const chat = bot ? bots?.find(({ id }) => id === bot.botId)?.name : undefined;

  useEffect(() => {
    const title = chat ? `${chat} | Crumble` : "Crumble";
    document.title = unread ? `(${unread}) ${title}` : title;
  }, [chat, unread]);
}

const SIDEBAR_THEME_COLOR = { light: "#e4e6ea", dark: "#030304" };

function SidebarThemeColor() {
  const { isMobile, openMobile } = useSidebar();
  const theme = useTheme();
  const tinted = isMobile && openMobile;

  useEffect(() => {
    if (!tinted) {
      return;
    }

    setThemeColor(SIDEBAR_THEME_COLOR);

    return () => setThemeColor();
  }, [tinted, theme]);

  return null;
}

export function Shell() {
  const session = authClient.useSession();
  const bots = useQuery(botsQuery);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pins = usePins(bots.data);
  const userId = session.data?.user.id;
  useResetOnUserChange(userId);
  useFollowActivity(userId);
  useDocumentTitle(bots.data);
  useAccountTheme();

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar
          bots={bots}
          pins={pins}
          onSearch={() => setPaletteOpen(true)}
        />
        <SidebarThemeColor />
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <SidebarInset className="group/inset h-dvh min-w-0 overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] md:peer-data-[state=expanded]:pl-0 md:h-[calc(100dvh-1rem)] md:shadow-sm md:ring-1 md:ring-sidebar-border dark:md:shadow-none">
          <header className="flex h-12 shrink-0 items-center px-2 group-has-[[data-page-trigger]]/inset:hidden md:hidden">
            <SidebarTrigger className="size-9" />
          </header>
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
