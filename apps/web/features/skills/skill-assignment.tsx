import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import type { Bot } from "@/features/bots/api";
import { BotAvatar } from "@/components/bot-avatar";
import { cn } from "@/lib/utils";
import { assignSkill } from "./api";

export function BotToggles({
  label,
  bots,
  isOn,
  onToggle,
  disabled,
}: {
  label: string;
  bots: Bot[];
  isOn: (bot: Bot) => boolean;
  onToggle: (bot: Bot, on: boolean) => void;
  disabled?: boolean | undefined;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {bots.map((bot) => {
        const on = isOn(bot);

        return (
          <Button
            key={bot.id}
            type="button"
            size="xs"
            variant={on ? "secondary" : "ghost"}
            aria-pressed={on}
            disabled={disabled}
            className={cn(
              "rounded-full border",
              on ? "border-transparent" : "text-muted-foreground",
            )}
            onClick={() => onToggle(bot, !on)}
          >
            <BotAvatar
              bot={bot}
              size={14}
              className={cn(!on && "opacity-50 grayscale")}
            />
            {bot.name}
          </Button>
        );
      })}
    </div>
  );
}

export function toggled(set: Set<string>, key: string, on: boolean) {
  const next = new Set(set);

  if (on) next.add(key);
  else next.delete(key);

  return next;
}

export const botsUsing = (bots: Bot[], skillId: string) =>
  new Set(
    bots.flatMap((bot) =>
      bot.sharedSkills?.includes(skillId) ? [bot.id] : [],
    ),
  );

export async function assignSharedSkill(
  skillId: string,
  bots: Bot[],
  selected: Set<string>,
) {
  const using = botsUsing(bots, skillId);

  await Promise.all(
    bots.flatMap((bot) => {
      const on = selected.has(bot.id);

      return on === using.has(bot.id) ? [] : [assignSkill(skillId, bot.id, on)];
    }),
  );
}

export function UsedByField({
  bots,
  selected,
  onChange,
}: {
  bots: Bot[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
}) {
  if (!bots.length) return null;

  return (
    <Field>
      <FieldLabel>Used by</FieldLabel>
      <BotToggles
        label="Bots that use this skill"
        bots={bots}
        isOn={(bot) => selected.has(bot.id)}
        onToggle={(bot, on) => onChange(toggled(selected, bot.id, on))}
      />
    </Field>
  );
}
