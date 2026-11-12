import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SelectOptions } from "@/components/form-fields";
import type { Bot } from "./api";

export function BotSelect({
  id,
  label,
  bots,
  value,
  invalid,
  optional = false,
  onChange,
}: {
  id?: string;
  label: string;
  bots: Bot[];
  value: string | null;
  invalid?: boolean;
  optional?: boolean;
  onChange: (value: string | null) => void;
}) {
  const items = [
    { value: "", label: optional ? "None" : "Choose a bot" },
    ...bots.map((bot) => ({
      value: bot.id,
      label: bot.enabled ? bot.name : `${bot.name} (disabled)`,
    })),
    ...(value && !bots.some((bot) => bot.id === value)
      ? [{ value, label: "Deleted bot" }]
      : []),
  ];

  return (
    <Select
      items={items}
      value={value ?? ""}
      onValueChange={(next) => onChange(next || null)}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        aria-invalid={invalid || undefined}
        className="w-48"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectOptions items={items} />
    </Select>
  );
}
