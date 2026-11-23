import {
  IconCircle,
  IconCloud,
  IconDeviceDesktop,
  IconMoon,
  IconSun,
} from "@tabler/icons-react";
import type { TablerIcon } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Section, SettingRow } from "@/components/page";
import { setAvatarMaterial, useAvatarMaterial } from "@/lib/avatar-material";
import { setTheme, useTheme } from "@/lib/theme";

export const THEME_OPTIONS = [
  { value: "system", label: "System", icon: IconDeviceDesktop },
  { value: "light", label: "Light", icon: IconSun },
  { value: "dark", label: "Dark", icon: IconMoon },
] as const;

const MATERIAL_OPTIONS = [
  { value: "flat", label: "Flat", icon: IconCircle },
  { value: "fluffy", label: "Fluffy", icon: IconCloud },
] as const;

function Choice<Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: Value; label: string; icon: TablerIcon }>;
  value: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-1">
      {options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant={option.value === value ? "secondary" : "ghost"}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          <option.icon data-icon="inline-start" />
          {option.label}
        </Button>
      ))}
    </div>
  );
}

export function Appearance() {
  const theme = useTheme();
  const material = useAvatarMaterial();

  return (
    <Section title="Appearance">
      <SettingRow title="Theme">
        <Choice
          label="Theme"
          options={THEME_OPTIONS}
          value={theme}
          onChange={(next) => void setTheme(next)}
        />
      </SettingRow>
      <SettingRow
        title="Avatars"
        description="Fluffy gives larger, animated avatars fur. Small ones stay flat."
      >
        <Choice
          label="Avatars"
          options={MATERIAL_OPTIONS}
          value={material}
          onChange={(next) => void setAvatarMaterial(next)}
        />
      </SettingRow>
    </Section>
  );
}
