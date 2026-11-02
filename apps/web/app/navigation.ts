import {
  IconActivity,
  IconBrain,
  IconCalendarRepeat,
  IconDeviceDesktop,
  IconMoon,
  IconSun,
} from "@tabler/icons-react";

export const WORKSPACE = [
  { to: "/memory", label: "Memory", icon: IconBrain },
  { to: "/automations", label: "Automations", icon: IconCalendarRepeat },
  { to: "/activity", label: "Activity", icon: IconActivity },
] as const;

export const THEME_OPTIONS = [
  { value: "system", label: "System", icon: IconDeviceDesktop },
  { value: "light", label: "Light", icon: IconSun },
  { value: "dark", label: "Dark", icon: IconMoon },
] as const;
