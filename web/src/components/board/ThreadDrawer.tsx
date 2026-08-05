import { useRef } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X, type LucideIcon } from "lucide-react";
import { useKeyboardInset } from "../../hooks/use-keyboard-inset";
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
  facts?: readonly { label: string; tone?: FactTone; icon?: LucideIcon }[];
  todo?: TodoProgressView | null;
  onClose: () => void;
  children: React.ReactNode;
  composer?: React.ReactNode;
  /**
   * Attaches the thread viewport to this drawer's own scroller. The drawer owns
   * the only scroll container the thread has, but the runtime that follows new
   * activity lives above it, so the ref is how the two meet — no second
   * scroller is nested inside this one.
   */
  viewportRef?: React.Ref<HTMLDivElement>;
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
export function ThreadDrawer({ open, title, facts = [], todo = null, onClose, children, composer, viewportRef }: ThreadDrawerProps) {
  /*
    iOS paints the keyboard over the page instead of resizing the layout
    viewport, so `fixed inset-0` keeps its full height and the composer ends up
    behind the keys. Lifting the whole surface by the covered strip keeps the
    composer — and the newest activity above it — in the visible area, and
    leaves the desktop drawer untouched because a pointer device reports none.
  */
  const keyboard = useKeyboardInset();
  // There is no `DialogTrigger` to hand focus back to — the drawer is opened by
  // a board card, a shortcut or the palette — so it remembers its own opener.
  const openerRef = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} modal={false} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPrimitive.Content
        onOpenAutoFocus={() => { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true }); }}
        className="fixed inset-0 z-50 isolate flex w-full min-w-0 max-w-none flex-col overflow-hidden border-l-0 bg-[var(--ground)] shadow-none focus-visible:outline-none min-[901px]:absolute min-[901px]:inset-y-0 min-[901px]:right-0 min-[901px]:left-auto min-[901px]:z-40 min-[901px]:max-w-[760px] min-[901px]:border-l min-[901px]:border-[var(--border-strong)] min-[901px]:bg-[var(--drawer,var(--ground))] min-[901px]:shadow-[var(--shadow-drawer)] min-[901px]:motion-safe:animate-[p-in_160ms_ease-out]"
        style={keyboard > 0 ? { paddingBottom: `${keyboard}px` } : undefined}
        data-thread-drawer
        data-phone-surface="fullscreen"
        data-desktop-surface="drawer"
        data-keyboard-inset={keyboard > 0 ? keyboard : undefined}
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
                <p className="truncate font-mono text-code-xs text-[var(--text-muted)] min-[901px]:hidden">
                  {facts.map((fact) => fact.label).join(" · ")}
                </p>
                <div className="hidden min-w-0 shrink-0 gap-1.5 min-[901px]:flex">
                  {facts.map((fact, index) => {
                    const Icon = fact.icon;
                    return (
                      <Badge
                        key={`${fact.label}:${index}`}
                        tone={FACT_TONE[fact.tone ?? "default"]}
                        className="px-[9px] py-1 leading-none"
                        data-tone={fact.tone ?? "default"}
                      >
                        {Icon && <Icon strokeWidth={1.75} aria-hidden="true" />}
                        {fact.label}
                      </Badge>
                    );
                  })}
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
        <div ref={viewportRef} className="min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden overflow-y-auto overscroll-contain bg-inherit pt-4 pr-[calc(1rem_+_max(0px,env(safe-area-inset-right)))] pb-2 pl-[calc(1rem_+_max(0px,env(safe-area-inset-left)))] min-[901px]:px-6 min-[901px]:pt-2 min-[901px]:pb-3" data-thread-content>{children}</div>
        {composer && <footer className="safe-area-bottom w-full min-w-0 max-w-full shrink-0 overflow-x-clip bg-inherit pt-2 pr-[calc(1rem_+_max(0px,env(safe-area-inset-right)))] pb-2 pl-[calc(1rem_+_max(0px,env(safe-area-inset-left)))] min-[901px]:px-6 min-[901px]:pt-0 min-[901px]:pb-[18px]" data-thread-composer>{composer}</footer>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  );
}
