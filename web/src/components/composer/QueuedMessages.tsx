import { Clock, X } from "lucide-react";
import { Button } from "../ui";

export interface QueuedMessageView {
  id: string;
  text: string;
  status: "queued" | "dispatching" | "failed";
}

export function QueuedMessageCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p className="text-center font-mono text-code-xs text-[var(--text-faint)]" aria-label={`${count} queued ${count === 1 ? "message" : "messages"}`}>
      {count} queued · shown in the thread
    </p>
  );
}

export function QueuedMessages({
  messages,
  canRemove,
  onRemove,
}: {
  messages: readonly QueuedMessageView[];
  canRemove: boolean;
  onRemove?: (id: string) => void;
}) {
  if (messages.length === 0) return null;
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3" aria-label={`${messages.length} queued ${messages.length === 1 ? "message" : "messages"}`}>
      <div className="flex items-center gap-2.5 font-mono text-eyebrow uppercase text-[var(--text-faint)]">
        <span className="h-px flex-1 bg-[var(--border-hairline)]" />
        <span className="inline-flex shrink-0 items-center gap-1.5"><Clock size={11} strokeWidth={1.75} />Queued · sends when this turn ends</span>
        <span className="h-px flex-1 bg-[var(--border-hairline)]" />
      </div>
      {messages.map((message, index) => (
        <div key={message.id} className="ml-auto flex max-w-[88%] min-w-0 items-start gap-2" data-queue-status={message.status}>
          <span className="mt-[9px] shrink-0 font-mono text-code-xs leading-none text-[var(--text-faint)]">{index + 1}</span>
          <div className="min-w-0 rounded-bubble border border-dashed border-[var(--border-strong)] bg-[var(--surface-raised-hover)] px-3.5 py-2 text-body-sm whitespace-pre-wrap break-words text-[var(--text-secondary)] [overflow-wrap:anywhere]">
            {message.text}
          </div>
          {canRemove && message.status === "queued" && (
            <Button variant="ghost" size="icon" data-compact-control className="mt-[5px] size-6 rounded-full text-[var(--text-faint)]" aria-label={`Remove queued message ${index + 1}`} onClick={() => onRemove?.(message.id)}>
              <X size={13} strokeWidth={1.75} />
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}
