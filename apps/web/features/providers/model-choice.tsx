import type { ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SelectOptions } from "@/components/form-fields";
import { SettingRow } from "@/components/page";

type ModelRef = { provider: string; model: string };

export const modelKey = (ref: ModelRef) => `${ref.provider}/${ref.model}`;

export function ModelChoiceRow({
  title,
  tile,
  unset,
  chosen,
  choices,
  description,
  save,
}: {
  title: string;
  tile: ReactNode;
  unset: { value: string; label: string };
  chosen: ModelRef | null;
  choices: (ModelRef & { name: string })[];
  description: string;
  save: (choice: ModelRef | null) => Promise<void>;
}) {
  const gone =
    chosen && !choices.some((item) => modelKey(item) === modelKey(chosen))
      ? [{ value: modelKey(chosen), label: `${chosen.model} (no key)` }]
      : [];

  const items = [
    unset,
    ...choices.map((item) => ({ value: modelKey(item), label: item.name })),
    ...gone,
  ];

  // `save` writes the server's answer into the query cache.
  // react-doctor-disable-next-line query-mutation-missing-invalidation
  const change = useMutation({
    mutationFn: (value: string) => {
      const choice = choices.find((item) => modelKey(item) === value);

      return save(
        choice ? { provider: choice.provider, model: choice.model } : null,
      );
    },
  });

  return (
    <SettingRow
      tile={tile}
      title={title}
      description={change.error?.message ?? description}
    >
      <Select
        items={items}
        value={chosen ? modelKey(chosen) : unset.value}
        onValueChange={(next) => change.mutate(next ?? unset.value)}
      >
        <SelectTrigger aria-label={title} className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectOptions items={items} />
      </Select>
    </SettingRow>
  );
}
