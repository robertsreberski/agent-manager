import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Circle } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root data-slot="radio-group" className={cn("grid gap-2", className)} {...props} />;
}

/*
  R5 keeps everything square except round buttons and pills; a radio is the
  round control the ladder was written for, so it is the one `rounded-full`
  here. Same lime-for-the-operator's-own-choice reasoning as `Checkbox`.
*/
function RadioGroupItem({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "aspect-square size-4 shrink-0 cursor-pointer rounded-full border border-[var(--border-loud)] bg-transparent transition-colors disabled:pointer-events-none disabled:opacity-45 data-[state=checked]:border-[var(--accent)]",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="grid size-full place-items-center"
      >
        <Circle className="size-2 fill-[var(--accent)] stroke-[var(--accent)]" aria-hidden="true" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
