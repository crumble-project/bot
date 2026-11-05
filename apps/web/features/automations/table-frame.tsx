import type { ReactNode } from "react";
import { Table, TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** The rounded, tinted frame both tables sit in. */
export function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl surface px-2 py-1">
      <Table>{children}</Table>
    </div>
  );
}

export function Heading({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <TableHead className={cn("font-normal text-muted-foreground", className)}>
      {children}
    </TableHead>
  );
}
