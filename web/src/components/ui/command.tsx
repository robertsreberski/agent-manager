import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";
import { menuItem } from "./dropdown-menu";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-frame bg-[var(--menu)] text-[var(--text)]",
        className,
      )}
      {...props}
    />
  );
}

type CommandDialogProps = React.ComponentProps<typeof Dialog> & {
  title?: string | undefined;
  description?: string | undefined;
  className?: string | undefined;
  showCloseButton?: boolean | undefined;
  /*
    Forwarded to the inner `Command`. A caller that has already filtered its own
    rows must be able to pass `shouldFilter={false}`: cmdk's default filter scores
    against the RAW input, so a prefixed query like `#term` or `>term` would score
    0 against every row the caller just returned and silently empty the list.
  */
  commandProps?: Omit<React.ComponentProps<typeof Command>, "children" | "className"> | undefined;
  /*
    Forwarded to `DialogContent`. A palette opened from application state rather
    than a `DialogTrigger` has nothing for Radix to return focus to on close, so
    it needs `onOpenAutoFocus`/`onCloseAutoFocus` to remember the opener itself.
  */
  contentProps?: Omit<React.ComponentProps<typeof DialogContent>, "children" | "className" | "showCloseButton"> | undefined;
};

/*
  The palette is a frame, not a menu: it is top-anchored so the list grows
  downward without the dialog re-centring on every keystroke. Everything else
  comes from `DialogContent`.
*/
function CommandDialog({
  title = "Command palette",
  description = "Search sessions and commands.",
  children,
  className,
  showCloseButton = false,
  commandProps,
  contentProps,
  ...props
}: CommandDialogProps) {
  return (
    <Dialog {...props}>
      <DialogContent
        {...contentProps}
        showCloseButton={showCloseButton}
        className={cn(
          "top-[110px] max-w-[600px] translate-y-0 gap-0 overflow-hidden p-0",
          "max-h-[min(620px,calc(100dvh-140px))]",
          className,
        )}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Command {...commandProps} className="rounded-none [&_[cmdk-input-wrapper]]:h-11">{children}</Command>
      </DialogContent>
    </Dialog>
  );
}

/*
  The one place the global `:focus-visible` ring is suppressed on a real
  control. The palette input is focused for the entire life of the dialog, so
  the ring would be permanent decoration rather than a focus cue — the dialog
  frame is already the focus context.
*/
function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="flex h-11 items-center gap-2.5 border-b border-[var(--rule)] px-3">
      <Search size={15} strokeWidth={1.75} className="shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-full w-full bg-transparent py-3 text-body-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus-visible:outline-none disabled:opacity-45",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn("max-h-[400px] scroll-py-1 overflow-x-hidden overflow-y-auto p-1", className)}
      {...props}
    />
  );
}

function CommandEmpty({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-meta-sm text-[var(--text-muted)]", className)}
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden text-[var(--text)] [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-eyebrow [&_[cmdk-group-heading]]:text-[var(--text-faint)] [&_[cmdk-group-heading]]:uppercase",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 my-1 h-px bg-[var(--rule)]", className)}
      {...props}
    />
  );
}

/*
  cmdk marks the active row with `data-selected="true"` rather than Radix's
  `data-highlighted`, so the shared `menuItem` string gets that one extra rule.
*/
function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        menuItem,
        "data-[selected=true]:bg-[var(--surface-selected)] data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn("ml-auto pl-4 font-mono text-code-xs text-[var(--text-faint)]", className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};
export type { CommandDialogProps };
