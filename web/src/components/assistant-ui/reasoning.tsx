import { useCallback, useEffect, useRef, useState } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Brain, ChevronDown } from "lucide-react";
import { useScrollLock } from "@assistant-ui/react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui";
import { cn } from "../../lib/utils";

/*
  assistant-ui's Reasoning, vendored and restyled to the cockpit's tokens.

  Departures from the published source, all forced or deliberate:

  - Base UI's `data-open`/`data-closed` become Radix's `data-state`, and the
    height keyframes live in `styles.css` against
    `--radix-collapsible-content-height`.
  - The trigger label is a prop rather than the literal "Reasoning". Codex
    projects one thought twice — a summarised `summary-N` and a raw `raw-N`,
    each with its own provider label — and a fixed label made the pair read as
    one event rendered twice.
  - The published live preview follows the newest tokens inside a pinned,
    fixed-height panel while streaming. That is not ported: the drawer's own
    viewport already follows new activity, and a second self-scrolling region
    inside it fights the auto-scroll the thread just gained. Streaming still
    holds the disclosure open, which is the part that matters.
*/

const ANIMATION_DURATION = 200;

const reasoningVariants = cva("w-full min-w-0 max-w-full overflow-hidden", {
  variants: {
    variant: {
      outline: "rounded-sm border border-[var(--border-hairline)] px-3 py-1.5",
      ghost: "",
      muted: "rounded-sm bg-[var(--surface-raised)] px-3 py-1.5",
    },
  },
  defaultVariants: { variant: "ghost" },
});

export type ReasoningRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> &
  VariantProps<typeof reasoningVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
    /** Held open while the provider is still thinking. */
    streaming?: boolean;
  };

function ReasoningRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  streaming = false,
  children,
  ...props
}: ReasoningRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [userOpen, setUserOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : streaming || userOpen;

  // Returning to the collapsed state when the provider stops thinking is a
  // height change like any other, so it takes the same scroll lock.
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming && !isControlled && !userOpen) lockScroll();
    wasStreaming.current = streaming;
  }, [streaming, isControlled, userOpen, lockScroll]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      if (!isControlled) setUserOpen(open);
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="reasoning-root"
      data-variant={variant ?? "ghost"}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn("group/reasoning-root", reasoningVariants({ variant, className }))}
      style={{ "--animation-duration": `${ANIMATION_DURATION}ms` } as React.CSSProperties}
      {...props}
    >
      {children}
    </Collapsible>
  );
}

function ReasoningTrigger({
  label = "Reasoning",
  active = false,
  duration = null,
  disabled = false,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  /** The provider's own name for this thought. */
  label?: string;
  active?: boolean;
  duration?: string | null;
}) {
  const text = duration ? `${label} (${duration})` : label;
  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      data-reasoning-label={label}
      data-compact-control="height"
      disabled={disabled}
      className={cn(
        "group/trigger flex min-h-8 max-w-full origin-left items-center gap-2 py-1.5 text-meta-sm text-[var(--text-muted)] transition-[color,scale] hover:text-[var(--text-secondary)] active:scale-[0.98] disabled:cursor-default disabled:hover:text-[var(--text-muted)] disabled:active:scale-100",
        className,
      )}
      {...props}
    >
      <Brain size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
      <span className="relative inline-block min-w-0 truncate leading-none tabular-nums">
        {text}
        {active && (
          <span aria-hidden="true" className="shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none">
            {text}
          </span>
        )}
      </span>
      {!disabled && (
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 -rotate-90 transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[state=open]/trigger:rotate-0 motion-reduce:transition-none"
        />
      )}
    </CollapsibleTrigger>
  );
}

function ReasoningContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="reasoning-content"
      className={cn(
        "relative min-w-0 max-w-full overflow-hidden text-meta-sm text-[var(--text-muted)] outline-none",
        "ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
        "data-[state=open]:animate-[cockpit-collapsible-down_var(--animation-duration)_ease-[cubic-bezier(0.32,0.72,0,1)]]",
        "data-[state=closed]:animate-[cockpit-collapsible-up_var(--animation-duration)_ease-[cubic-bezier(0.32,0.72,0,1)]]",
        className,
      )}
      {...props}
    >
      {children}
    </CollapsibleContent>
  );
}

function ReasoningText({ className, children, ...props }: React.ComponentProps<"pre">) {
  return (
    <pre
      data-slot="reasoning-text"
      className={cn(
        "min-w-0 max-w-full overflow-x-hidden border-l border-[var(--rule)] pl-3 font-mono text-code-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
        "motion-safe:animate-[cockpit-fade-in_var(--animation-duration)_ease-[cubic-bezier(0.32,0.72,0,1)]]",
        className,
      )}
      {...props}
    >
      {children}
    </pre>
  );
}

export { ReasoningRoot, ReasoningTrigger, ReasoningContent, ReasoningText, reasoningVariants };
