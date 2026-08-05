import { useCallback, useRef, useState } from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { useScrollLock } from "@assistant-ui/react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui";
import { cn } from "../../lib/utils";

/*
  assistant-ui's ToolGroup, vendored and restyled to the cockpit's tokens.

  Two departures from the published source, both forced:

  - It targets Base UI's `data-open` / `data-closed`. This app is on Radix,
    which reports `data-state` and measures the panel into
    `--radix-collapsible-content-height`, so every animation selector is
    rewritten against that and the keyframes live in `styles.css`.
  - Its palette is shadcn's defaults (`text-muted-foreground`, `bg-muted/30`).
    The cockpit's tiers are semantic tokens, and its type scale is named, so
    `text-sm`/`text-xs` become `text-meta-sm`/`text-code-xs`.

  The scroll lock is kept exactly as published: collapsing a group halfway down
  a turn drops everything below it, and `useScrollLock` pins the drawer's
  scroller across the toggle. That is the one primitive the refactor had
  already adopted for the same reason.
*/

/**
 * How long the panel takes to open or close, and therefore how long the scroll
 * lock has to hold.
 *
 * The cockpit's own disclosures had no height transition, so a 120ms lock only
 * had to outlive the reflow. These panels animate, so the lock has to outlive
 * the animation or the rows below snap back mid-collapse.
 */
export const TOOL_GROUP_ANIMATION_MS = 200;
const ANIMATION_DURATION = TOOL_GROUP_ANIMATION_MS;

const toolGroupVariants = cva("w-full min-w-0 max-w-full overflow-hidden", {
  variants: {
    variant: {
      outline: "rounded-sm border border-[var(--border-hairline)] py-2",
      ghost: "my-2",
      muted: "rounded-sm border border-[var(--border-hairline)] bg-[var(--surface-raised)] py-2",
    },
  },
  defaultVariants: { variant: "ghost" },
});

export type ToolGroupRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> &
  VariantProps<typeof toolGroupVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
  };

function ToolGroupRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolGroupRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      if (!isControlled) setUncontrolledOpen(open);
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-group-root"
      data-variant={variant ?? "ghost"}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(toolGroupVariants({ variant }), "group/tool-group-root", className)}
      style={{ "--animation-duration": `${ANIMATION_DURATION}ms` } as React.CSSProperties}
      {...props}
    >
      {children}
    </Collapsible>
  );
}

function ToolGroupTrigger({
  count,
  active = false,
  duration = null,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  count: number;
  active?: boolean;
  /** Wall-clock span, only where every call in the group reported one. */
  duration?: string | null;
}) {
  const label = `${count} tool ${count === 1 ? "call" : "calls"}`;
  return (
    <CollapsibleTrigger
      data-slot="tool-group-trigger"
      data-compact-control
      className={cn(
        "group/trigger flex min-h-9 w-full min-w-0 origin-left items-center gap-2 py-1.5 text-left text-[var(--text-muted)] transition-[color,scale] active:scale-[0.98]",
        "group-data-[variant=outline]/tool-group-root:px-3 group-data-[variant=muted]/tool-group-root:px-3",
        className,
      )}
      {...props}
    >
      {active
        ? <LoaderCircle size={14} strokeWidth={1.75} className="shrink-0 motion-safe:animate-spin [animation-duration:0.6s]" aria-hidden="true" />
        : <ChevronDown
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            className="shrink-0 -rotate-90 transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[state=open]/trigger:rotate-0 motion-reduce:transition-none"
          />}
      <span className="relative min-w-0 flex-1 truncate text-start text-meta-sm font-medium leading-none">
        {label}
        {active && (
          <span aria-hidden="true" className="shimmer pointer-events-none absolute inset-0 text-meta-sm motion-reduce:animate-none">
            {label}
          </span>
        )}
      </span>
      {duration && <span className="shrink-0 text-meta-sm tabular-nums text-[var(--text-faint)]">{duration}</span>}
      {active && <span className="shrink-0 font-mono text-code-xs text-[var(--text-faint)]">active</span>}
    </CollapsibleTrigger>
  );
}

function ToolGroupContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-group-content"
      className={cn(
        "relative min-w-0 max-w-full overflow-hidden outline-none",
        "ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
        "data-[state=open]:animate-[cockpit-collapsible-down_var(--animation-duration)_ease-[cubic-bezier(0.32,0.72,0,1)]]",
        "data-[state=closed]:animate-[cockpit-collapsible-up_var(--animation-duration)_ease-[cubic-bezier(0.32,0.72,0,1)]]",
        className,
      )}
      {...props}
    >
      {/* Frame 11b indents the group body 24px. The marker sits on the element
          that actually carries the containment grammar, not on the animated
          wrapper around it. */}
      <div
        data-tool-group-body
        className={cn(
          "ml-6 grid grid-cols-[minmax(0,1fr)] min-w-0 max-w-full gap-0.5 pt-1",
          "group-data-[variant=outline]/tool-group-root:mx-3 group-data-[variant=outline]/tool-group-root:ml-6 group-data-[variant=outline]/tool-group-root:border-t group-data-[variant=outline]/tool-group-root:border-[var(--rule)] group-data-[variant=outline]/tool-group-root:pt-2",
          "[&>*]:motion-safe:animate-[cockpit-fade-in_var(--animation-duration)_ease-[cubic-bezier(0.32,0.72,0,1)]]",
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

export { ToolGroupRoot, ToolGroupTrigger, ToolGroupContent, toolGroupVariants };
