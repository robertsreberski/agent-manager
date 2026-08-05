import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
  Spec 12 R4 — semantic colours are not decoration. The variant names are the
  MEANINGS, not the colours, so that a wrong badge reads wrong in review:

    wants    lime    wants you (and nothing else — R3)
    warning  amber   warning, uncommitted changes — never errors
    access   orange  non-standard access — never warnings
    danger   red     danger, outside the workspace, failed — never routine
    remote   violet  remote host, subagent — never local anything
    added    green   added lines — not success generally
    neutral  grey    everything that is merely a fact
    outline  grey    the same, when it must sit on a filled surface

  R5: chips are square. `shape="pill"` is the opt-in for the pill form.
*/
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 border border-transparent px-2 py-0.5 font-mono text-code-sm whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "bg-[var(--surface-selected)] text-[var(--text-secondary)]",
        outline: "border-[var(--border)] text-[var(--text-secondary)]",
        wants: "border-[var(--wants-outline)] bg-[var(--wants-field)] text-[var(--wants-text)]",
        warning: "bg-[var(--warning-field)] text-[var(--warning)]",
        access: "bg-[var(--access-field)] text-[var(--access)]",
        danger: "bg-[var(--danger-field)] text-[var(--danger-text)]",
        remote: "bg-[var(--remote-field)] text-[var(--remote)]",
        added: "bg-[var(--added-field)] text-[var(--added)]",
      },
      shape: {
        square: "rounded-sm",
        pill: "rounded-full px-2.5",
      },
      // assistant-ui's badge sizes, kept for API parity. `tone` stays the
      // app's own axis: spec 12 R4 names variants by meaning rather than
      // colour, so a wrong badge reads wrong in review.
      size: {
        sm: "px-1.5 py-0",
        default: "",
        lg: "px-2.5 py-1 text-meta-sm",
      },
    },
    defaultVariants: { tone: "neutral", shape: "square", size: "default" },
  },
);

type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean | undefined;
  };

function Badge({ className, tone, shape, size, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot : "span";
  return <Comp data-slot="badge" className={cn(badgeVariants({ tone, shape, size, className }))} {...props} />;
}

export { Badge, badgeVariants };
export type { BadgeProps };
