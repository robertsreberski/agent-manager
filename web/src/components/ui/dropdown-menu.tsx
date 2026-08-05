import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
  The menu surface, defined once here and reused by every popover-shaped
  primitive in this directory: R2's `--menu` fill, the loudest frame hairline,
  R8's menu shadow, R5's 6px frame radius, R9's `p-in`.

  The content box is a programmatic focus target rather than a control, so its
  focus outline is suppressed; every item inside keeps the global
  `:focus-visible` ring from `styles.css`.
*/
const menuSurface =
  "z-50 min-w-[10rem] overflow-x-hidden overflow-y-auto rounded-frame border border-[var(--border-strong)] bg-[var(--menu)] p-1 text-[var(--text)] shadow-[var(--shadow-menu)] motion-p-in focus-visible:outline-none";

/*
  R7: 32px on desktop, `--touch-target` on a coarse pointer — the same rule
  `[data-compact-control]` applies in `styles.css`, expressed as a variant so
  no extra global CSS is needed.
*/
const menuItem =
  "relative flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-meta-sm select-none pointer-coarse:min-h-[var(--touch-target)] data-[highlighted]:bg-[var(--surface-selected)] data-[disabled]:pointer-events-none data-[disabled]:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

/** R4: red is danger, and only danger. */
const menuItemDanger =
  "data-[variant=danger]:text-[var(--danger-text)] data-[variant=danger]:data-[highlighted]:bg-[var(--danger-field)] data-[variant=danger]:[&_svg]:text-[var(--danger-text)]";

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(menuSurface, "max-h-(--radix-dropdown-menu-content-available-height)", className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

type DropdownMenuItemProps = React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  /** Aligns the label with items that carry a check or radio indicator. */
  inset?: boolean | undefined;
  variant?: "default" | "danger" | undefined;
};

function DropdownMenuItem({ className, inset, variant = "default", ...props }: DropdownMenuItemProps) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset ? "" : undefined}
      data-variant={variant}
      className={cn(menuItem, menuItemDanger, "data-[inset]:pl-8", className)}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(menuItem, "pl-8", className)}
      {...props}
    >
      <span className="pointer-events-none absolute left-2.5 grid size-4 place-items-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check size={13} strokeWidth={2} className="text-[var(--accent)]" aria-hidden="true" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(menuItem, "pl-8", className)}
      {...props}
    >
      <span className="pointer-events-none absolute left-2.5 grid size-4 place-items-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle className="size-2 fill-[var(--accent)] stroke-[var(--accent)]" aria-hidden="true" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

type DropdownMenuLabelProps = React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean | undefined;
};

function DropdownMenuLabel({ className, inset, ...props }: DropdownMenuLabelProps) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset ? "" : undefined}
      className={cn(
        "px-2.5 py-1.5 font-mono text-eyebrow text-[var(--text-faint)] uppercase data-[inset]:pl-8",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-[var(--rule)]", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("ml-auto pl-4 font-mono text-code-xs text-[var(--text-faint)]", className)}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

type DropdownMenuSubTriggerProps = React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean | undefined;
};

function DropdownMenuSubTrigger({ className, inset, children, ...props }: DropdownMenuSubTriggerProps) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset ? "" : undefined}
      className={cn(menuItem, "data-[inset]:pl-8 data-[state=open]:bg-[var(--surface-selected)]", className)}
      {...props}
    >
      {children}
      <ChevronRight size={14} strokeWidth={1.75} className="ml-auto text-[var(--text-muted)]" aria-hidden="true" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(menuSurface, className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  menuItem,
  menuSurface,
};
