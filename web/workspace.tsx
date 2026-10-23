import type { ReactElement, ReactNode } from "react";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** The header row and scrolling body every workspace and settings page shares. */
export function WorkspacePage({
  title,
  onRefresh,
  refreshing,
  onNew,
  newLabel,
  newDisabled,
  children,
}: {
  title: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  onNew?: () => void;
  newLabel?: string;
  newDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
        <h1 className="font-medium">{title}</h1>
        <div className="flex items-center gap-1">
          {onRefresh && (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Refresh"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RefreshCwIcon
                className={refreshing ? "animate-spin" : undefined}
              />
            </Button>
          )}
          {onNew && (
            <Button
              variant="ghost"
              size="icon-sm"
              title={newLabel}
              disabled={newDisabled}
              onClick={onNew}
            >
              <PlusIcon />
            </Button>
          )}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
          {children}
        </div>
      </div>
    </div>
  );
}

/** Asks before an irreversible delete. */
export function ConfirmDelete({
  title,
  description,
  onConfirm,
  trigger,
}: {
  title: string;
  description: string;
  onConfirm: () => void;
  trigger: ReactElement;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger render={trigger} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A titled group of rows, like a Mac settings section. */
export function Section({
  title,
  footer,
  children,
}: {
  title: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <div className="flex flex-col divide-y rounded-lg border">{children}</div>
      {footer && <p className="text-xs text-muted-foreground">{footer}</p>}
    </section>
  );
}

export function SectionEmpty({ children }: { children: ReactNode }) {
  return <p className="p-3 text-sm text-muted-foreground">{children}</p>;
}
