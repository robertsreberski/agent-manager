import type { FC, ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui";
import { cn } from "../../lib/utils";

/*
  assistant-ui's ContextDisplay, vendored and restyled.

  The published component reads `useThreadTokenUsage()` from
  `@assistant-ui/react-ai-sdk` — the AI SDK transport, which this cockpit does
  not use. It already supports being handed a `usage` object instead, and that
  is the only path kept here: the numbers come from the provider's own usage
  item, so the package and its hook are not a dependency.

  The window is the other half. Both providers state it — Codex on every
  `thread/tokenUsage/updated`, Claude on the result message — and both
  projectors used to drop it. Where a provider states none, the meter is not
  rendered at all: a percentage needs a denominator, and inventing one is the
  thing this cockpit does not do.
*/

export interface ContextTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return `${tokens}`;
}

function usagePercent(totalTokens: number, modelContextWindow: number): number {
  if (!totalTokens || modelContextWindow <= 0) return 0;
  return Math.min((totalTokens / modelContextWindow) * 100, 100);
}

/** The cockpit's own severity tokens rather than Tailwind's palette. */
function barColor(percent: number): string {
  if (percent >= 90) return "bg-[var(--danger)]";
  if (percent >= 75) return "bg-[var(--warning)]";
  return "bg-[var(--text-secondary)]";
}

function segments(usage: ContextTokenUsage): { label: string; tokens: number }[] {
  return [
    { label: "Input", tokens: usage.inputTokens ?? 0 },
    { label: "Cached input", tokens: usage.cachedInputTokens ?? 0 },
    { label: "Output", tokens: usage.outputTokens ?? 0 },
    { label: "Reasoning", tokens: usage.reasoningTokens ?? 0 },
  ].filter((segment) => segment.tokens > 0);
}

/**
 * The breakdown itself, with no opinion about what surrounds it.
 *
 * It is deliberately not a `TooltipContent`: the transcript's meter reveals on
 * hover, and the composer's chip has to open on a click, so the same body has
 * to sit inside either a `Tooltip` or a `Popover`.
 */
function ContextDisplayDetail({
  usage,
  totalTokens,
  percent,
  modelContextWindow,
}: {
  usage: ContextTokenUsage;
  totalTokens: number;
  percent: number;
  modelContextWindow: number;
}) {
  const parts = segments(usage);
  return (
    <div className="text-code-xs">
      <div className="flex items-baseline justify-between gap-6 whitespace-nowrap">
        <span className="font-medium">Context usage</span>
        <span className="text-[var(--text-muted)] tabular-nums">
          {formatTokenCount(Math.min(totalTokens, modelContextWindow))} of {formatTokenCount(modelContextWindow)}
        </span>
      </div>
      <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-[var(--surface-selected)]">
        <div
          className={cn("h-full rounded-full transition-[width] duration-300", totalTokens > 0 && "min-w-1", barColor(percent))}
          style={{ width: `${percent}%` }}
        />
      </div>
      {parts.length > 0 && (
        <div className="mt-3 grid gap-1.5">
          {parts.map((segment) => (
            <div key={segment.label} className="flex items-baseline justify-between gap-6">
              <span className="text-[var(--text-muted)]">{segment.label}</span>
              <span className="font-mono tabular-nums">{formatTokenCount(segment.tokens)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface ContextDisplayProps {
  usage: ContextTokenUsage;
  /** The provider's own window. Absent means the meter is not shown at all. */
  modelContextWindow: number | null;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
  children?: ReactNode;
}

const TRIGGER = "inline-flex min-h-6 items-center gap-1.5 rounded-sm px-1 font-mono text-code-xs tabular-nums text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-selected)] hover:text-[var(--text)]";

function triggerLabel(percent: number, modelContextWindow: number): string {
  return `Context usage: ${Math.round(percent)}% of ${formatTokenCount(modelContextWindow)}`;
}

function ContextDisplayShell({ usage, modelContextWindow, className, side = "top", children }: ContextDisplayProps) {
  const totalTokens = usage.totalTokens ?? 0;
  if (modelContextWindow === null || modelContextWindow <= 0) return null;
  const percent = usagePercent(totalTokens, modelContextWindow);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="context-display-trigger"
            data-compact-control="height"
            aria-label={triggerLabel(percent, modelContextWindow)}
            className={cn(TRIGGER, className)}
          >
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent side={side} sideOffset={8} data-slot="context-display-popover" className="w-56 p-3 text-left">
          <ContextDisplayDetail usage={usage} totalTokens={totalTokens} percent={percent} modelContextWindow={modelContextWindow} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export interface ContextDisplayChipProps extends ContextDisplayProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * The composer's meter: the same fact, opened by a click rather than a hover.
 *
 * The transcript printed one of these per turn, scattered down the thread. The
 * window state belongs beside the model and the effort — one reading of it, in
 * the bar the operator is already looking at when they decide what to send.
 */
function ContextDisplayChip({ usage, modelContextWindow, className, side = "top", open, onOpenChange }: ContextDisplayChipProps) {
  const totalTokens = usage.totalTokens ?? 0;
  if (modelContextWindow === null || modelContextWindow <= 0) return null;
  const percent = usagePercent(totalTokens, modelContextWindow);
  return (
    <Popover {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="context-display-trigger"
          data-compact-control="height"
          aria-label={triggerLabel(percent, modelContextWindow)}
          className={cn(TRIGGER, className)}
        >
          <span className="h-1 w-10 overflow-hidden rounded-full bg-[var(--surface-selected)]" aria-hidden="true">
            <span className={cn("block h-full rounded-full", totalTokens > 0 && "min-w-1", barColor(percent))} style={{ width: `${percent}%` }} />
          </span>
          {Math.round(percent)}%
        </button>
      </PopoverTrigger>
      <PopoverContent side={side} align="start" sideOffset={8} data-slot="context-display-popover" className="w-56 p-3 text-left">
        <ContextDisplayDetail usage={usage} totalTokens={totalTokens} percent={percent} modelContextWindow={modelContextWindow} />
      </PopoverContent>
    </Popover>
  );
}

/** A short meter with the percentage beside it. */
const ContextDisplayBar: FC<ContextDisplayProps> = (props) => {
  const totalTokens = props.usage.totalTokens ?? 0;
  if (props.modelContextWindow === null || props.modelContextWindow <= 0) return null;
  const percent = usagePercent(totalTokens, props.modelContextWindow);
  return (
    <ContextDisplayShell {...props}>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-[var(--surface-selected)]" aria-hidden="true">
        <span className={cn("block h-full rounded-full", totalTokens > 0 && "min-w-1", barColor(percent))} style={{ width: `${percent}%` }} />
      </span>
      {Math.round(percent)}%
    </ContextDisplayShell>
  );
};

/** The same fact as one number, for a row that has no room for a meter. */
const ContextDisplayText: FC<ContextDisplayProps> = (props) => {
  const totalTokens = props.usage.totalTokens ?? 0;
  if (props.modelContextWindow === null || props.modelContextWindow <= 0) return null;
  return (
    <ContextDisplayShell {...props}>
      {formatTokenCount(totalTokens)} / {formatTokenCount(props.modelContextWindow)}
    </ContextDisplayShell>
  );
};

export const ContextDisplay = {
  Bar: ContextDisplayBar,
  Text: ContextDisplayText,
  Chip: ContextDisplayChip,
  Root: ContextDisplayShell,
};
