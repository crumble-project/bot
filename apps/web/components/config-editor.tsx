import { IconPlus, IconTrash } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";

export function AddRowButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={onClick}
    >
      <IconPlus data-icon="inline-start" />
      {label}
    </Button>
  );
}

export function RemoveRowButton({
  title,
  onClick,
}: {
  title: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={title}
      onClick={onClick}
    >
      <IconTrash />
    </Button>
  );
}

type SaveState = {
  isPending: boolean;
  isSuccess: boolean;
  error: Error | null;
};

function saveStatus(dirty: boolean, save: SaveState) {
  if (save.isPending) return "Saving…";

  if (dirty) return "Unsaved changes";

  return save.isSuccess ? "Saved" : "";
}

export function SaveBar({
  dirty,
  save,
  onReset,
}: {
  dirty: boolean;
  save: SaveState;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="mr-auto text-sm text-muted-foreground" role="status">
        {save.error ? (
          <FieldError>{save.error.message}</FieldError>
        ) : (
          saveStatus(dirty, save)
        )}
      </span>
      <Button
        type="button"
        variant="ghost"
        disabled={!dirty || save.isPending}
        onClick={onReset}
      >
        Reset
      </Button>
      <Button type="submit" disabled={!dirty || save.isPending}>
        Save
      </Button>
    </div>
  );
}

export function QueryState({
  pending,
  error,
}: {
  pending: boolean;
  error: Error | null;
}) {
  if (error) return <FieldError>{error.message}</FieldError>;

  return pending ? <Skeleton className="h-64 w-full rounded-xl" /> : null;
}
