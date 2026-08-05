import type { FC } from "react";
import { useMessageTiming } from "@assistant-ui/react";
import { Timer } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui";
import { cn } from "../../lib/utils";

/*
  assistant-ui's MessageTiming, vendored and restyled — and fed a different
  kind of fact than the published component expects.

  Upstream it reads browser-stream measurements: when the first chunk arrived,
  how many chunks there were, a tokens-per-second derived from a client clock.
  This cockpit prints what the provider itself reported and nothing else, which
  is why `useMessageTiming` was rejected during the refactor (issue #5) — its
  fields are exactly the ones we cannot honestly source.

  What changed is where the numbers come from, not the component:
  `activityToThreadMessages` populates `metadata.timing` from the provider's own
  `startedAt`/`completedAt` span and usage totals, and omits anything the
  provider did not state.

  The one row that could not be sourced is deleted rather than filled in.
  `totalChunks` counts stream chunks the browser received; this cockpit is not
  the thing receiving the stream, and a chunk count invented here would read as
  a provider fact beside three that are. The turn's tool-call count takes its
  place — the same shape of fact, and one the provider actually states.
*/

function formatMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return ms < 10_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.round(ms / 1_000)}s`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}

export const MessageTiming: FC<{
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
}> = ({ className, side = "top" }) => {
  const timing = useMessageTiming();
  // A turn whose provider never stated a span has nothing to show. Rendering a
  // zero here would be the cockpit inventing the one number it is missing.
  if (timing?.totalStreamTime === undefined) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="message-timing-trigger"
            data-compact-control="height"
            aria-label="Turn timing"
            className={cn(
              "inline-flex min-h-6 items-center gap-1 rounded-sm px-1 font-mono text-code-xs tabular-nums text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-selected)] hover:text-[var(--text)]",
              className,
            )}
          >
            <Timer size={11} strokeWidth={1.75} aria-hidden="true" />
            {formatMs(timing.totalStreamTime)}
          </button>
        </TooltipTrigger>
        <TooltipContent side={side} sideOffset={8} data-slot="message-timing-popover">
          <div className="grid min-w-36 gap-1.5 text-code-xs">
            <Row label="Total" value={formatMs(timing.totalStreamTime)} />
            {timing.tokenCount !== undefined && (
              <Row label="Tokens" value={timing.tokenCount.toLocaleString()} />
            )}
            {timing.tokensPerSecond !== undefined && (
              <Row label="Speed" value={`${timing.tokensPerSecond.toFixed(1)} tok/s`} />
            )}
            {timing.toolCallCount > 0 && (
              <Row label="Tool calls" value={String(timing.toolCallCount)} />
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
