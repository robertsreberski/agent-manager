import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/** The scrim. Matches the `bg-black/70` the hand-rolled modals already used. */
function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn("fixed inset-0 z-50 bg-black/70", className)}
      {...props}
    />
  );
}

type DialogContentProps = React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean | undefined;
};

/*
  R8 gives frames `--shadow-frame` and menus `--shadow-menu`; a centred modal is
  a frame, so it takes the former (this is also what the hand-rolled modals in
  App.tsx already do). R5 gives it the 6px frame radius.

  `motion-p-in` is the R9 overlay motion. It is safe next to the centring
  translate because Tailwind v4 emits `translate:`, not `transform:`, so the
  keyframe's `transform` does not clobber it.

  The panel itself is a programmatic focus target, not a control, so its focus
  outline is suppressed. Every real control inside keeps the global
  `:focus-visible` ring.
*/
function DialogContent({ className, children, showCloseButton = true, ...props }: DialogContentProps) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-1.5rem)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-frame border border-[var(--border-frame)] bg-[var(--menu)] p-5 text-[var(--text)] shadow-[var(--shadow-frame)] motion-p-in focus-visible:outline-none",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            data-compact-control
            className="absolute top-4 right-4 grid size-7 cursor-pointer place-items-center rounded-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-selected)] hover:text-[var(--text)] disabled:pointer-events-none"
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("grid gap-1.5", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("pr-8 text-title text-[var(--text)]", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-meta text-[var(--text-secondary)]", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
export type { DialogContentProps };
