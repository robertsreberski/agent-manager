import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";

import { cn } from "../../lib/utils";

/**
 * assistant-ui's ready markdown renderer, styled for the cockpit timeline.
 * Streaming stays provider-paced: the SSE projector already supplies small,
 * ordered deltas, so an additional reveal animation would only add latency.
 */
export function MarkdownText({ className }: { className?: string }) {
  return (
    <MarkdownTextPrimitive
      smooth={false}
      className={cn(
        "aui-md min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]",
        "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
        // The heading ladder, not Tailwind's default type scale: `text-title*`
        // carries the 600 weight and tightened tracking, so no `font-semibold`.
        "[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-title",
        "[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-title-md",
        "[&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-title-sm",
        "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-0.5 [&_li_p]:my-0 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        "[&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted/60 [&_pre]:p-3",
        // 0.85em, not a ladder step: inline code inherits whatever size the
        // surrounding prose is set to (14px in a turn, 12.5px in a subagent
        // step), so a fixed px would be wrong in one of them.
        "[&_code]:font-mono [&_code]:text-[0.85em] [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5",
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4",
        "[&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse",
        "[&_th]:border [&_th]:bg-muted/60 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:px-2 [&_td]:py-1",
        className,
      )}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    />
  );
}
