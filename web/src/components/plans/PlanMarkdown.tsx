import Markdown from "react-markdown";
import { cn } from "../../lib/utils";

/**
 * Plan prose is provider-authored markdown, not a checklist model. React
 * Markdown escapes raw HTML by default; remote images are rendered as labels
 * so merely reviewing a plan cannot make an external request.
 */
export function PlanMarkdown({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <div
      className={cn(
        "min-w-0 border-l-2 border-[var(--border)] pl-3 font-mono text-[13px] leading-[21px] whitespace-pre-wrap break-words text-[var(--text)]",
        "[&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-[17px] [&_h1]:font-semibold [&_h1:first-child]:mt-0",
        "[&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2:first-child]:mt-0",
        "[&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:font-semibold [&_h3:first-child]:mt-0",
        "[&_h4]:mb-1.5 [&_h4]:mt-3 [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold",
        "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1",
        "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--text-faint)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-muted)]",
        "[&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:bg-[var(--surface-raised)] [&_pre]:p-3 [&_pre]:whitespace-pre",
        "[&_code]:font-mono [&_:not(pre)>code]:bg-[var(--surface-raised)] [&_:not(pre)>code]:px-1",
        "[&_a]:text-[var(--accent-quiet)] [&_a]:underline [&_a]:underline-offset-2",
        className,
      )}
      data-plan-markdown
    >
      <Markdown
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
          img: ({ alt }) => <span className="text-[var(--text-muted)]">[image{alt ? `: ${alt}` : ""}]</span>,
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
