import { type ReactNode, useEffect, useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
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
      <FieldGroup className="gap-5 rounded-xl surface p-4">
        {children}
      </FieldGroup>
    </section>
  );
}

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
          <ScrollArea className="min-h-0 flex-1">
            <FieldGroup className="p-4">
              {children}
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </FieldGroup>
          </ScrollArea>
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

const ICON_SWAP =
  "transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)]";

export function CopyButton({
  text,
  size = "icon-sm",
}: {
  text: string;
  size?: "icon-sm" | "icon-xs";
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timer = setTimeout(() => setCopied(false), 1500);

    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="ghost"
      size={size}
      title={copied ? "Copied" : "Copy"}
      className="relative"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => setCopied(true))
      }
    >
      <IconCopy
        className={cn(ICON_SWAP, copied && "scale-25 opacity-0 blur-[4px]")}
      />
      <IconCheck
        className={cn(
          ICON_SWAP,
          "absolute",
          !copied && "scale-25 opacity-0 blur-[4px]",
        )}
      />
    </Button>
  );
}
