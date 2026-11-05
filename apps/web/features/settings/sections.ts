import {
  IconAdjustmentsHorizontal,
  IconCode,
  IconEye,
  IconKey,
  IconLock,
  IconLogin2,
  IconMessages,
  IconPlug,
  IconScale,
  IconSparkles,
  IconUsers,
  IconVault,
  IconWebhook,
  IconWorld,
} from "@tabler/icons-react";

const SETTINGS_SECTIONS = [
  {
    to: "/settings/general",
    label: "General",
    icon: IconAdjustmentsHorizontal,
  },
  { to: "/settings/providers", label: "Providers", icon: IconKey },
  {
    to: "/settings/password-managers",
    label: "Password managers",
    icon: IconVault,
  },
  { to: "/settings/web-search", label: "Web search", icon: IconWorld },
  { to: "/settings/credentials", label: "Credentials", icon: IconLock },
  { to: "/settings/logins", label: "Logins", icon: IconLogin2 },
  { to: "/settings/judge-model", label: "Judge model", icon: IconScale },
  { to: "/settings/vision-model", label: "Vision model", icon: IconEye },
  { to: "/settings/integrations", label: "Integrations", icon: IconPlug },
  { to: "/settings/coding", label: "Coding", icon: IconCode },
  { to: "/settings/users", label: "Users", icon: IconUsers, admin: true },
  {
    to: "/settings/message-gateways",
    label: "Message gateways",
    icon: IconMessages,
  },
  { to: "/settings/event-relay", label: "Event relay", icon: IconWebhook },
  { to: "/settings/skills", label: "Skills", icon: IconSparkles },
] as const;

export const settingsSections = (admin: boolean) =>
  SETTINGS_SECTIONS.filter((section) => admin || !("admin" in section));
