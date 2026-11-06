import { IconUsersGroup } from "@tabler/icons-react";
import { BotAvatar, type AvatarBot } from "@/components/bot-avatar";
import type { FilterPill } from "@/components/page";
import { ALL, SHARED } from "./queries";

const counted = (pill: FilterPill, count: number | undefined): FilterPill =>
  count === undefined ? pill : { ...pill, count };

export const allPill = (count?: number) =>
  counted({ value: ALL, label: "All" }, count);

export const sharedPill = (count: number) =>
  counted({ value: SHARED, label: "Shared", icon: <IconUsersGroup /> }, count);

export const botPill = (bot: AvatarBot & { name: string }, count?: number) =>
  counted(
    { value: bot.id, label: bot.name, icon: <BotAvatar bot={bot} size={18} /> },
    count,
  );
