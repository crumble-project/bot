import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { type Bot, agentPath, send } from "@/lib/api";
import { BotAvatar } from "@/features/bots/avatar";
import { cn } from "@/lib/utils";

/** Pressed pills, one per bot, for choosing which bots have a skill. */
export function BotPills({
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

/** A copy of `set` with `key` in it when `on`, without it otherwise. */
export function toggled(set: Set<string>, key: string, on: boolean) {
  const next = new Set(set);

  if (on) next.add(key);
  else next.delete(key);

  return next;
}

/** The bots whose shared skills include `skillId`. */
export const botsUsing = (bots: Bot[], skillId: string) =>
  new Set(
    bots.flatMap((bot) =>
      bot.sharedSkills?.includes(skillId) ? [bot.id] : [],
    ),
  );

/** Turns a shared skill on for the `selected` bots and off for the rest, changing only bots that differ. */
export async function assignSharedSkill(
  skillId: string,
  bots: Bot[],
  selected: Set<string>,
) {
  const using = botsUsing(bots, skillId);

  await Promise.all(
    bots.flatMap((bot) => {
      const on = selected.has(bot.id);

      if (on === using.has(bot.id)) return [];
      const others = (bot.sharedSkills ?? []).filter((id) => id !== skillId);

      return [
        send(agentPath(bot.id), "PATCH", {
          sharedSkills: (on ? [...others, skillId] : others).toSorted(),
        }),
      ];
    }),
  );
}

/** A form field choosing which bots use a shared skill. */
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
      <BotPills
        label="Bots that use this skill"
        bots={bots}
        isOn={(bot) => selected.has(bot.id)}
        onToggle={(bot, on) => onChange(toggled(selected, bot.id, on))}
      />
    </Field>
  );
}
