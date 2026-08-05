import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
  The board's selection checkbox, promoted to a primitive: `--border-loud` when
  empty (frame 12a's loudest hairline, for a control whose whole job is to
  announce a mode), the lime fill when ticked.

  R3 permits the lime here: a ticked box is the operator's own choice, the same
  category as a primary button — not a status the app is reporting back.

  R5: square. `size-4` with the 0 radius from `--radius-sm`.
*/
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer grid size-4 shrink-0 cursor-pointer place-items-center rounded-sm border border-[var(--border-loud)] bg-transparent transition-colors disabled:pointer-events-none disabled:opacity-45 data-[state=checked]:border-[var(--accent)] data-[state=checked]:bg-[var(--accent)] data-[state=checked]:text-[var(--accent-ink)] data-[state=indeterminate]:border-[var(--accent)] data-[state=indeterminate]:bg-[var(--accent)] data-[state=indeterminate]:text-[var(--accent-ink)]",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="grid place-items-center text-current">
        <Check size={11} strokeWidth={2} aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
