import { X } from "lucide-react";

export interface QueuedMessageView {
  id: string;
  text: string;
  status: "queued" | "dispatching" | "failed";
}

export function QueuedMessageCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p className="text-center font-mono text-[10.5px] text-[var(--text-faint)]" aria-label={`${count} queued ${count === 1 ? "message" : "messages"}`}>
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
    <section className="grid gap-2" aria-label={`${messages.length} queued ${messages.length === 1 ? "message" : "messages"}`}>
      <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)]">
        <span className="h-px flex-1 bg-[var(--rule)]" />
        <span>Queued · sends when this turn ends</span>
        <span className="h-px flex-1 bg-[var(--rule)]" />
      </div>
      {messages.map((message, index) => (
        <div
          key={message.id}
          className="ml-auto flex max-w-[82%] items-start gap-2 rounded-[12px_12px_4px_12px] border border-dashed border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2.5 text-[13px] text-[var(--text-muted)]"
          data-queue-status={message.status}
        >
          <span className="shrink-0 font-mono text-[10px] text-[var(--text-faint)]">{index + 1}</span>
          <span className="min-w-0 whitespace-pre-wrap break-words">{message.text}</span>
          {canRemove && message.status === "queued" && (
            <button type="button" data-compact-control className="grid size-6 shrink-0 place-items-center" aria-label={`Remove queued message ${index + 1}`} onClick={() => onRemove?.(message.id)}>
              <X size={13} strokeWidth={1.75} />
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
