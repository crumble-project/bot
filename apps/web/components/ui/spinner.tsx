import { cn } from "cn";
import { IconLoader2, type IconProps } from "@tabler/icons-react";

function Spinner({ className, ...props }: IconProps) {
  return (
    <IconLoader2
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
