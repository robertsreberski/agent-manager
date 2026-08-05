import type * as React from "react";

import { cn } from "@/lib/utils";

type SeparatorProps = React.ComponentProps<"div"> & {
  orientation?: "horizontal" | "vertical" | undefined;
  /** A decorative rule is invisible to assistive tech; a semantic one is a `separator`. */
  decorative?: boolean | undefined;
};

/*
  Stock shadcn builds this on `@radix-ui/react-separator`, which this repo does
  not install (spec 12 R11: no reserved dependencies). The primitive is a div
  with a role and an orientation, so it is spelled out here instead.

  The rule colour is `--rule`, the inside-a-frame hairline, not `--border`.
*/
function Separator({ className, orientation = "horizontal", decorative = true, ...props }: SeparatorProps) {
  return (
    <div
      data-slot="separator"
      data-orientation={orientation}
      role={decorative ? "none" : "separator"}
      aria-orientation={decorative || orientation === "horizontal" ? undefined : "vertical"}
      className={cn(
        "shrink-0 bg-[var(--rule)]",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px self-stretch",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
export type { SeparatorProps };
