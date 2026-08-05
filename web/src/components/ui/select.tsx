import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";
import { menuItem, menuSurface } from "./dropdown-menu";

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

type SelectTriggerProps = React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "md" | "touch" | undefined;
};

/** Sized off the same R7 ladder as `Button`, so a select can sit in a control row. */
const triggerSize = {
  sm: "h-[29px] text-meta-sm",
  md: "h-[var(--control-height)] text-meta",
  touch: "min-h-[var(--touch-target)] text-body-sm",
} as const;

function SelectTrigger({ className, size = "md", children, ...props }: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit cursor-pointer items-center justify-between gap-2 rounded-sm border border-[var(--border-frame)] bg-transparent px-3 text-[var(--text)] whitespace-nowrap transition-colors select-none hover:bg-[var(--surface-raised-hover)] disabled:pointer-events-none disabled:opacity-45 data-[placeholder]:text-[var(--text-muted)] [&_svg]:pointer-events-none [&_svg]:shrink-0",
        triggerSize[size],
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown size={14} strokeWidth={1.75} className="text-[var(--text-muted)]" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn(
          menuSurface,
          "relative max-h-(--radix-select-content-available-height)",
          position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className,
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-2.5 py-1.5 font-mono text-eyebrow text-[var(--text-faint)] uppercase", className)}
      {...props}
    />
  );
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className={cn(menuItem, "pr-8", className)} {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="pointer-events-none absolute right-2.5 grid size-4 place-items-center">
        <SelectPrimitive.ItemIndicator>
          <Check size={13} strokeWidth={2} className="text-[var(--accent)]" aria-hidden="true" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("-mx-1 my-1 h-px bg-[var(--rule)]", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn("flex cursor-default items-center justify-center py-1 text-[var(--text-muted)]", className)}
      {...props}
    >
      <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn("flex cursor-default items-center justify-center py-1 text-[var(--text-muted)]", className)}
      {...props}
    >
      <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
export type { SelectTriggerProps };
