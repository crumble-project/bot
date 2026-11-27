import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Section, SettingRow } from "@/components/page";
import { setTheme, useTheme } from "@/lib/theme";

export const THEME_OPTIONS = [
  { value: "system", label: "System", icon: IconDeviceDesktop },
  { value: "light", label: "Light", icon: IconSun },
  { value: "dark", label: "Dark", icon: IconMoon },
] as const;

export function Appearance() {
  const theme = useTheme();

  return (
    <Section title="Appearance">
      <SettingRow title="Theme">
        <div className="flex gap-1">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <Button
              key={value}
              size="sm"
              variant={theme === value ? "secondary" : "ghost"}
              aria-pressed={theme === value}
              onClick={() => void setTheme(value)}
            >
              <Icon data-icon="inline-start" />
              {label}
            </Button>
          ))}
        </div>
      </SettingRow>
    </Section>
  );
}
