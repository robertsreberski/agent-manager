import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
  Spec 12 R3 — the lime accent means exactly one thing.

  `primary` is the ONLY lime variant, and lime here means "the operator's own
  action": New thread, Execute this plan, Send, Allow. It is the same lime that
  marks a wants-you session, and that is deliberate — both are "this one is
  yours". It must never be used to mark status. Working is grey (`ghost` /
  `secondary`), failed is red (`danger`), idle is dimmer grey. The moment lime
  shows up on a running session the board stops being scannable, which is its
  only job.

  Per R5, controls are square by default (`--radius-sm` is 0). `rounded-full`
  belongs to pills and round buttons only, which is why `primary` opts in
  rather than the base doing it for everyone.
*/
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-sm font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary:
          "rounded-full bg-[var(--accent)] text-[var(--accent-ink)] hover:bg-[var(--accent-hover)] active:bg-[var(--accent-active)]",
        secondary:
          "border border-[var(--border-frame)] text-[var(--text)] hover:bg-[var(--surface-raised-hover)] active:bg-[var(--surface-raised-active)]",
        ghost:
          "text-[var(--text-secondary)] hover:bg-[var(--surface-selected)] hover:text-[var(--text)] active:bg-[var(--surface-selected-active)]",
        danger:
          "border border-[var(--danger)] bg-[var(--danger-field)] text-[var(--danger-text)] hover:bg-[var(--danger-pill-field)]",
      },
      size: {
        // R7: desktop targets are 26–32px. `md` is `--control-height` exactly.
        sm: "h-[29px] px-2.5 text-meta-sm",
        md: "h-[var(--control-height)] px-3.5 text-meta",
        icon: "size-[var(--control-height)] p-0",
        // R7: phone targets are 44–48px. `--touch-target` is 2.75rem = 44px.
        touch: "min-h-[var(--touch-target)] px-4 text-body-sm",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean | undefined;
  };

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
export type { ButtonProps };
