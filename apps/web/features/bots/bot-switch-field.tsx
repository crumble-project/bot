import type { ReactNode } from "react";
import { BotAvatar, type AvatarBot } from "@/components/bot-avatar";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

export function BotSwitchField({
  id,
  bot,
  checked,
  disabled,
  onCheckedChange,
  children,
}: {
  id: string;
  bot: AvatarBot & { name: string };
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent className="min-w-0">
        <FieldLabel htmlFor={id} className="flex items-center gap-2">
          <BotAvatar bot={bot} size={22} />
          <span className="min-w-0 truncate">{bot.name}</span>
          {children}
        </FieldLabel>
      </FieldContent>
      <Switch
        id={id}
        checked={checked}
        {...(disabled !== undefined && { disabled })}
        onCheckedChange={onCheckedChange}
      />
    </Field>
  );
}
