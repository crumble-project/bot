import { type ReactNode, useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export function OwnerSelectField({
  label,
  owners,
  value,
  disabled,
  onValueChange,
}: {
  label: string;
  owners: { label: string; value: string }[];
  value: string;
  disabled: boolean;
  onValueChange: (value: string | null) => void;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select
        items={owners}
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {owners.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

/** The options of a plain select, one per item. */
export function SelectOptions({
  items,
}: {
  items: { value: string; label: ReactNode }[];
}) {
  return (
    <SelectContent>
      <SelectGroup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectGroup>
    </SelectContent>
  );
}

/** A titled, tinted group of fields inside an editor sheet. */
export function EditorSection({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      {title && (
        <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      )}
      <FieldGroup className="gap-5 rounded-xl border bg-muted/30 p-4">
        {children}
      </FieldGroup>
    </section>
  );
}

/** The side sheet every editor opens in: a scrolling form with its actions pinned below. */
export function EditorSheet({
  title,
  description,
  error,
  submitLabel,
  submitDisabled,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  error?: string | null | undefined;
  submitLabel: string;
  submitDisabled: boolean;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <FieldGroup className="flex-1 overflow-y-auto p-4">
            {children}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
          <SheetFooter className="flex-row justify-end border-t">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {submitLabel}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** A one-line form for an API key or other secret; the value is never shown again. */
export function SecretForm({
  label,
  value,
  pending,
  onChange,
  onSave,
  onCancel,
}: {
  label: string;
  value: string;
  pending: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel?: () => void;
}) {
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();

        if (value.trim()) onSave();
      }}
    >
      <Input
        type="password"
        aria-label={label}
        autoFocus
        autoComplete="off"
        placeholder="API key"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <Button type="submit" disabled={!value.trim() || pending}>
        Save
      </Button>
      {onCancel && (
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </form>
  );
}

/** Copies `text` and shows a check once it did. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={copied ? "Copied" : "Copy"}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => setCopied(true))
      }
    >
      {copied ? <IconCheck /> : <IconCopy />}
    </Button>
  );
}
