import type { ReactElement, ReactNode } from "react";
import { IconPlus, IconRefresh } from "@tabler/icons-react";
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
import { SidebarTrigger } from "@/components/ui/sidebar";
import { FieldError } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/**
 * Opens the sidebar on phones from a page's own header. The shell hides its
 * fallback header row while a page renders one of these.
 */
export function MobileSidebarTrigger({ className }: { className?: string }) {
  return (
    <SidebarTrigger
      data-page-trigger
      className={cn("-ml-2 size-9 shrink-0 md:hidden", className)}
    />
  );
}

/** The header row and scrolling body every workspace and settings page shares. */
export function WorkspacePage({
  title,
  onRefresh,
  refreshing,
  onNew,
  newLabel,
  newDisabled,
  actions,
  wide,
  children,
}: {
  title: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  onNew?: () => void;
  newLabel?: string;
  newDisabled?: boolean;
  actions?: ReactNode;
  /** Room for a table, wider than the reading width of other pages. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4">
        <div className="flex min-w-0 items-center gap-1">
          {/* Settings pages open the sidebar from the section nav above. */}
          <MobileSidebarTrigger className="in-data-[slot=settings-page]:hidden" />
          <h1 className="truncate font-heading text-base font-semibold">
            {title}
          </h1>
        </div>
        <div className="flex items-center gap-1">
          {onRefresh && (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Refresh"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <IconRefresh
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
              <IconPlus />
            </Button>
          )}
          {actions}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex w-full flex-col gap-8 p-6",
            wide ? "max-w-5xl" : "max-w-3xl",
          )}
        >
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
      <ConfirmDeleteContent
        title={title}
        description={description}
        onConfirm={onConfirm}
      />
    </AlertDialog>
  );
}

export function ConfirmDeleteContent({
  title,
  description,
  error,
  pending,
  onConfirm,
}: {
  title: string;
  description: string;
  error?: Error | null;
  pending?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      {error && <FieldError>{error.message}</FieldError>}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          disabled={pending}
          onClick={onConfirm}
        >
          Delete
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}

/** A titled group of rows, like a Mac settings section. */
export function Section({
  title,
  icon,
  footer,
  children,
}: {
  title: string;
  /** Shown before the title, such as the avatar of the bot a section belongs to. */
  icon?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        {icon}
        {title}
      </h2>
      <div className="flex flex-col divide-y rounded-lg border">{children}</div>
      {footer && <p className="text-xs text-muted-foreground">{footer}</p>}
    </section>
  );
}

export function SectionEmpty({ children }: { children: ReactNode }) {
  return <p className="p-3 text-sm text-muted-foreground">{children}</p>;
}
