import { useEffect, useEffectEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { IconPlus, IconUsersGroup } from "@tabler/icons-react";
import { defaultFilter } from "cmdk";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { useSidebar } from "@/components/ui/sidebar";
import { type Bot, botsQuery } from "@/features/bots/api";
import { type GroupChat, groupsQuery } from "@/features/group-chats/api";
import { setTheme, useTheme } from "@/lib/theme";
import { BotAvatar } from "@/components/bot-avatar";
import { settingsSections } from "@/features/settings/sections";
import { useIsAdmin } from "@/lib/auth-client";
import { THEME_OPTIONS, PAGES } from "./navigation";
import { MIN_GROUP_MEMBERS } from "@crumble/server/contract/limits";

// Chat items keep their id as the value so equal names stay distinct; match them by name only.
const filter = (value: string, search: string, keywords?: string[]) =>
  keywords?.length
    ? defaultFilter(keywords.join(" "), search)
    : defaultFilter(value, search);

export const PALETTE_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.userAgent)
  ? "⌘K"
  : "Ctrl K";

type Run = (action: () => void) => void;

type Go = (options: Parameters<ReturnType<typeof useNavigate>>[0]) => void;

function usePaletteShortcut(onToggle: () => void) {
  const toggle = useEffectEvent(onToggle);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "k" || !(event.metaKey || event.ctrlKey)) return;

      event.preventDefault();
      toggle();
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function BotCommands({ bots, run }: { bots: Bot[] | undefined; run: Run }) {
  const navigate = useNavigate();

  if (!bots?.length) return null;

  return (
    <CommandGroup heading="Bots">
      {bots.map((bot) => (
        <CommandItem
          key={bot.id}
          value={`bot ${bot.id}`}
          keywords={[bot.name]}
          onSelect={() =>
            run(
              () =>
                void navigate({
                  to: "/bots/$botId",
                  params: { botId: bot.id },
                }),
            )
          }
        >
          <BotAvatar bot={bot} size={20} />
          <span className="truncate">{bot.name}</span>
          {!bot.enabled && <CommandShortcut>Paused</CommandShortcut>}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function GroupCommands({
  groups,
  run,
}: {
  groups: GroupChat[] | undefined;
  run: Run;
}) {
  const navigate = useNavigate();

  if (!groups?.length) return null;

  return (
    <CommandGroup heading="Group chats">
      {groups.map((group) => (
        <CommandItem
          key={group.id}
          value={`group ${group.id}`}
          keywords={[group.name]}
          onSelect={() =>
            run(
              () =>
                void navigate({
                  to: "/groups/$groupId",
                  params: { groupId: group.id },
                }),
            )
          }
        >
          <IconUsersGroup />
          <span className="truncate">{group.name}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function PageCommands({ admin, go }: { admin: boolean; go: Go }) {
  return (
    <>
      <CommandGroup heading="Workspace">
        {PAGES.map((item) => (
          <CommandItem key={item.to} onSelect={() => go({ to: item.to })}>
            <item.icon />
            {item.label}
          </CommandItem>
        ))}
      </CommandGroup>
      <CommandGroup heading="Settings">
        {settingsSections(admin).map((section) => (
          <CommandItem
            key={section.to}
            value={`Settings ${section.label}`}
            onSelect={() => go({ to: section.to })}
          >
            <section.icon />
            {section.label}
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  );
}

function ThemeCommands({
  theme,
  run,
}: {
  theme: ReturnType<typeof useTheme>;
  run: Run;
}) {
  return (
    <CommandGroup heading="Theme">
      {THEME_OPTIONS.map((option) => (
        <CommandItem
          key={option.value}
          value={`Theme ${option.label}`}
          onSelect={() => run(() => void setTheme(option.value))}
        >
          <option.icon />
          {option.label} theme
          {theme === option.value && <CommandShortcut>Current</CommandShortcut>}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const bots = useQuery(botsQuery);
  const groups = useQuery(groupsQuery);
  const admin = useIsAdmin();
  const theme = useTheme();
  const { setOpenMobile } = useSidebar();

  usePaletteShortcut(() => onOpenChange(!open));

  const run = (action: () => void) => {
    onOpenChange(false);
    setOpenMobile(false);
    action();
  };

  const go: Go = (options) => run(() => void navigate(options));

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search chats, pages, and settings"
    >
      <Command filter={filter}>
        <CommandInput placeholder="Search chats, pages, and settings" />
        <CommandList>
          <CommandEmpty>No results</CommandEmpty>
          <BotCommands bots={bots.data} run={run} />
          <GroupCommands groups={groups.data} run={run} />
          <CommandGroup heading="Create">
            <CommandItem onSelect={() => go({ to: "/bots/new" })}>
              <IconPlus />
              New bot
            </CommandItem>
            {(bots.data?.length ?? 0) >= MIN_GROUP_MEMBERS && (
              <CommandItem onSelect={() => go({ to: "/groups/new" })}>
                <IconPlus />
                New group chat
              </CommandItem>
            )}
          </CommandGroup>
          <PageCommands admin={admin} go={go} />
          <ThemeCommands theme={theme} run={run} />
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
