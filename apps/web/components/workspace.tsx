import type { ReactElement, ReactNode } from "react";
import {
  IconDots,
  IconPlus,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
  actions,
  children,
}: {
  title: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  actions?: ReactNode;
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
          {actions}
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6">
          {children}
        </div>
      </div>
    </div>
  );
}

/** The row above a page's list: a search field, and the page's main action at the end. */
export function PageToolbar({
  search,
  searchLabel,
  onSearch,
  children,
}: {
  search?: string;
  searchLabel?: string;
  onSearch?: (search: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      {onSearch && (
        <div className="relative flex-1">
          <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label={searchLabel}
            placeholder={searchLabel}
            className="pl-8"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
          />
        </div>
      )}
      {children}
    </div>
  );
}

/** One filter choice: its label, and an optional icon and count. */
export type FilterPill = {
  value: string;
  label: string;
  icon?: ReactNode;
  count?: number;
};

/** A scrolling row of rounded filter buttons, one pressed. */
export function FilterPills({
  label,
  pills,
  value,
  onChange,
}: {
  label: string;
  pills: FilterPill[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="-mx-1 flex min-w-0 gap-1 overflow-x-auto px-1 pb-1"
    >
      {pills.map((pill) => (
        <Button
          key={pill.value}
          type="button"
          size="sm"
          variant={value === pill.value ? "secondary" : "ghost"}
          aria-pressed={value === pill.value}
          className="shrink-0 rounded-full"
          onClick={() => onChange(pill.value)}
        >
          {pill.icon}
          {pill.label}
          {pill.count !== undefined && (
            <span className="text-muted-foreground tabular-nums">
              {pill.count}
            </span>
          )}
        </Button>
      ))}
    </div>
  );
}

/** A page's create button, such as "New memory". */
export function NewButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button disabled={disabled} onClick={onClick}>
      <IconPlus data-icon="inline-start" />
      {label}
    </Button>
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

/** A titled group of rows in a tinted frame, like a Mac settings section. */
export function Section({
  title,
  icon,
  description,
  action,
  footer,
  children,
}: {
  title: string;
  /** Shown before the title, such as the avatar of the bot a section belongs to. */
  icon?: ReactNode;
  description?: ReactNode;
  /** A control at the end of the heading, such as an Add button. */
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-8 items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            {icon}
            {title}
          </h2>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      <div className="flex flex-col divide-y overflow-hidden rounded-xl border bg-muted/30">
        {children}
      </div>
      {footer && <p className="text-xs text-muted-foreground">{footer}</p>}
    </section>
  );
}

export function SectionEmpty({ children }: { children: ReactNode }) {
  return <p className="p-3 text-sm text-muted-foreground">{children}</p>;
}

/** A square tile that leads a row: an icon or a letter on a soft background. */
export function RowTile({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-xs text-muted-foreground [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** One setting: what it is on the left, its control on the right. */
export function SettingRow({
  tile,
  title,
  description,
  children,
}: {
  tile?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-3 py-2">
      {tile}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          {title}
        </span>
        {description && (
          <span className="text-xs wrap-break-word text-muted-foreground">
            {description}
          </span>
        )}
      </div>
      {children && (
        <div className="flex shrink-0 items-center gap-1">{children}</div>
      )}
    </div>
  );
}

/** A green dot for on, a hollow one for off, with its label. */
export function StatusDot({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={cn(
          "size-1.5 rounded-full",
          on ? "bg-emerald-500" : "border border-muted-foreground/50",
        )}
      />
      {label}
    </span>
  );
}

/** The "…" menu at the end of a row. */
export function RowMenu({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" title="More">
            <IconDots />
          </Button>
        }
      />
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
