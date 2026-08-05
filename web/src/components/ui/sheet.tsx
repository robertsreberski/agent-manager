import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetOverlay({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn("fixed inset-0 z-50 bg-black/70", className)}
      {...props}
    />
  );
}

/*
  Edge-anchored panels. R8's `--shadow-drawer` is directional (`-50px 0 …`), so
  only the right variant — the thread drawer the app actually ships — can use
  it. The other three fall back to the frame shadow rather than inventing a
  mirrored literal; a `--shadow-drawer-start` token would fix that properly.

  The bottom variant is the phone sheet: rounded top corners and the safe-area
  inset the app already respects via `.safe-area-bottom`.
*/
const sheetVariants = cva(
  "fixed z-50 flex flex-col gap-4 bg-[var(--drawer)] p-5 text-[var(--text)] motion-p-in focus-visible:outline-none",
  {
    variants: {
      side: {
        right: "inset-y-0 right-0 h-full w-[min(760px,calc(100%-2rem))] border-l border-[var(--border-strong)] shadow-[var(--shadow-drawer)]",
        left: "inset-y-0 left-0 h-full w-[min(760px,calc(100%-2rem))] border-r border-[var(--border-strong)] shadow-[var(--shadow-frame)]",
        top: "inset-x-0 top-0 h-auto max-h-[80dvh] border-b border-[var(--border-strong)] shadow-[var(--shadow-frame)]",
        bottom:
          "inset-x-0 bottom-0 h-auto max-h-[85dvh] rounded-t-sheet border-t border-[var(--border-strong)] pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[var(--shadow-sheet-bottom)]",
      },
    },
    defaultVariants: { side: "right" },
  },
);

type SheetContentProps = React.ComponentProps<typeof SheetPrimitive.Content> &
  VariantProps<typeof sheetVariants> & {
    showCloseButton?: boolean | undefined;
  };

function SheetContent({ className, children, side, showCloseButton = true, ...props }: SheetContentProps) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content data-slot="sheet-content" className={cn(sheetVariants({ side, className }))} {...props}>
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            data-compact-control
            className="absolute top-4 right-4 grid size-7 cursor-pointer place-items-center rounded-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-selected)] hover:text-[var(--text)] disabled:pointer-events-none"
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("grid gap-1.5", className)} {...props} />;
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-footer" className={cn("mt-auto flex flex-col gap-2", className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("pr-8 text-title text-[var(--text)]", className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-meta text-[var(--text-secondary)]", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
  sheetVariants,
};
export type { SheetContentProps };
