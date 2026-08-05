import { useRef } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { TodoProgressView } from "../../lib/cockpit-view";
import { Badge, Button, Separator } from "../ui";
import { TodoProgressMeter } from "./TodoProgressMeter";

type FactTone = "default" | "dirty" | "remote";

/*
  Spec 12 R4 — the drawer's fact chips are read by meaning, not by colour.
  A dirty worktree is amber because uncommitted work is a warning, never an
  error; a remote host is violet because violet is what "not this machine"
  means everywhere else in the cockpit.
*/
const FACT_TONE = { default: "neutral", dirty: "warning", remote: "remote" } as const satisfies Record<FactTone, "neutral" | "warning" | "remote">;

export interface ThreadDrawerProps {
  open: boolean;
  title: string;
  facts?: readonly { label: string; tone?: FactTone }[];
  todo?: TodoProgressView | null;
  onClose: () => void;
  children: React.ReactNode;
  composer?: React.ReactNode;
}

/*
  The one shadcn surface in the cockpit that is deliberately NOT portalled.
  Spec 05 R7: the drawer overlays the board region only, so it must stay a child
  of `[data-board-region]` — `SheetContent` portals to `document.body`, which
  would make it a sibling of the header and swallow every header control. Radix
  is used for what it is here for: Escape ownership through DismissableLayer,
  and mount focus through FocusScope.

  `modal={false}` is the other deliberate choice. The board behind the drawer
  stays clickable on desktop — that click is how a session is switched — so the
  drawer takes no scrim, no outside-pointer blocking, and `onInteractOutside` is
  prevented so a board click selects instead of dismissing.
*/
export function ThreadDrawer({ open, title, facts = [], todo = null, onClose, children, composer }: ThreadDrawerProps) {
  // There is no `DialogTrigger` to hand focus back to — the drawer is opened by
  // a board card, a shortcut or the palette — so it remembers its own opener.
  const openerRef = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} modal={false} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPrimitive.Content
        onOpenAutoFocus={() => { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true }); }}
        className="fixed inset-0 z-50 isolate flex w-full max-w-none flex-col overflow-hidden border-l-0 bg-[var(--ground)] shadow-none focus-visible:outline-none min-[901px]:absolute min-[901px]:inset-y-0 min-[901px]:right-0 min-[901px]:left-auto min-[901px]:z-40 min-[901px]:max-w-[760px] min-[901px]:border-l min-[901px]:border-[var(--border-strong)] min-[901px]:bg-[var(--drawer,var(--ground))] min-[901px]:shadow-[var(--shadow-drawer)] min-[901px]:motion-safe:animate-[p-in_160ms_ease-out]"
        data-thread-drawer
        data-phone-surface="fullscreen"
        data-desktop-surface="drawer"
        onInteractOutside={(event) => event.preventDefault()}
      >
        {/*
          The phone surface is `fixed inset-0`, so it covers the app header —
          the only element carrying `safe-area-top`. With `viewport-fit=cover`
          and a black-translucent status bar, the title would otherwise sit
          under the notch, and a landscape phone would put the close control
          under the rounded corner. The desktop drawer is inset inside an
          already-padded region and keeps its own spacing.
        */}
        <header
          className="flex shrink-0 items-center gap-2 bg-inherit pt-[calc(0.25rem_+_max(0px,env(safe-area-inset-top)))] pr-[calc(1rem_+_max(0px,env(safe-area-inset-right)))] pb-3 pl-[calc(1rem_+_max(0px,env(safe-area-inset-left)))] min-[901px]:px-[22px] min-[901px]:pt-4 min-[901px]:pb-3"
          data-thread-header
        >
          <div className="min-w-0 flex-1 min-[901px]:flex min-[901px]:items-center min-[901px]:gap-2">
            <DialogPrimitive.Title className="truncate text-title-sm min-[901px]:min-w-0 min-[901px]:shrink">{title}</DialogPrimitive.Title>
            {facts.length > 0 && (
              <>
                {/* Phone (9a-2) states the same facts as one mono subtitle; the drawer (4a) chips them. */}
                <p className="truncate font-mono text-code-xs text-[var(--text-faint)] min-[901px]:hidden">
                  {facts.map((fact) => fact.label).join(" · ")}
                </p>
                <div className="hidden min-w-0 shrink-0 gap-1.5 min-[901px]:flex">
                  {facts.map((fact, index) => (
                    <Badge
                      key={`${fact.label}:${index}`}
                      tone={FACT_TONE[fact.tone ?? "default"]}
                      className="px-[9px] py-1 leading-none"
                      data-tone={fact.tone ?? "default"}
                    >
                      {fact.label}
                    </Badge>
                  ))}
                </div>
              </>
            )}
          </div>
          {todo && todo.total > 0 && (
            <TodoProgressMeter todo={todo} className="shrink-0 bg-[var(--surface-raised)] px-2 py-1" />
          )}
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon" className="size-11 shrink-0 min-[901px]:size-7" aria-label="Close thread">
              <X size={16} strokeWidth={1.75} />
            </Button>
          </DialogPrimitive.Close>
        </header>
        {/* The phone surface rules the header off; the desktop drawer does not. */}
        <Separator className="shrink-0 bg-[var(--border-hairline)] min-[901px]:hidden" />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-inherit pt-4 pr-[calc(1rem_+_max(0px,env(safe-area-inset-right)))] pb-2 pl-[calc(1rem_+_max(0px,env(safe-area-inset-left)))] min-[901px]:px-6 min-[901px]:pt-2 min-[901px]:pb-3" data-thread-content>{children}</div>
        {composer && <footer className="safe-area-bottom shrink-0 bg-inherit pt-2 pr-[calc(1rem_+_max(0px,env(safe-area-inset-right)))] pb-2 pl-[calc(1rem_+_max(0px,env(safe-area-inset-left)))] min-[901px]:px-6 min-[901px]:pt-0 min-[901px]:pb-[18px]" data-thread-composer>{composer}</footer>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  );
}
