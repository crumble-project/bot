import { IconActivity, IconCalendarRepeat } from "@tabler/icons-react";

export const AUTOMATIONS = {
  to: "/automations",
  label: "Automations",
  icon: IconCalendarRepeat,
} as const;

export const ACTIVITY = {
  to: "/activity",
  label: "Activity",
  icon: IconActivity,
} as const;

export const PAGES = [AUTOMATIONS, ACTIVITY] as const;
