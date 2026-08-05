import { ComposerPrimitive, QueueItemPrimitive } from "@assistant-ui/react";
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
    <p className="text-center font-mono text-code-xs text-[var(--text-muted)]" aria-label={`${count} queued ${count === 1 ? "message" : "messages"}`}>
      {count} queued · shown in the thread
    </p>
  );
}

function QueueRail({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 font-mono text-eyebrow uppercase text-[var(--text-muted)]">
      <span className="h-px flex-1 bg-[var(--border-hairline)]" />
      <span className="inline-flex shrink-0 items-center gap-1.5"><Clock size={11} strokeWidth={1.75} />{label}</span>
      <span className="h-px flex-1 bg-[var(--border-hairline)]" />
    </div>
  );
}

const BUBBLE = "min-w-0 rounded-bubble border border-dashed border-[var(--border-strong)] bg-[var(--surface-raised-hover)] px-3.5 py-2 text-body-sm whitespace-pre-wrap break-words text-[var(--text-secondary)] [overflow-wrap:anywhere]";

/**
 * The harness's queue, rendered through `ComposerPrimitive.Queue`.
 *
 * The primitives were rejected during the refactor for a reason that has not
 * gone away: `createMessageQueue` owns a *client-side* queue, and this queue is
 * the provider's, arriving as `kind:"queue"` activity items. What changed is
 * the plumbing — the runtime now takes an `ExternalThreadQueueAdapter` that
 * reads those items, so the primitives render provider truth instead of state
 * the browser invented.
 *
 * `QueueItemPrimitive.Remove` is still not usable as shipped: it is an
 * always-enabled button with no way to say that `remove-queued` was withheld.
 * Where the capability is offered it renders; where it is not, the row states
 * why rather than offering a control that would fail.
 */
export function QueuedMessages({
  messages,
  canRemove,
  withheldReason,
}: {
  messages: readonly QueuedMessageView[];
  canRemove: boolean;
  withheldReason?: string | null;
}) {
  if (messages.length === 0) return null;
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3" aria-label={`${messages.length} queued ${messages.length === 1 ? "message" : "messages"}`}>
      <QueueRail label="Queued · sends when this turn ends" />
      <ComposerPrimitive.Queue>
        {({ queueItem }) => {
          const index = messages.findIndex((message) => message.id === queueItem.id);
          const message = messages[index];
          return (
            <div className="ml-auto flex max-w-[88%] min-w-0 items-start gap-2" data-queue-status={message?.status ?? "queued"}>
              <span className="mt-[9px] shrink-0 font-mono text-code-xs leading-none text-[var(--text-faint)]">{index + 1}</span>
              <QueueItemPrimitive.Text className={BUBBLE} />
              {canRemove && message?.status === "queued" && (
                <QueueItemPrimitive.Remove asChild>
                  <Button variant="ghost" size="icon" data-compact-control className="mt-[5px] size-6 rounded-full text-[var(--text-faint)]" aria-label={`Remove queued message ${index + 1}`}>
                    <X size={13} strokeWidth={1.75} />
                  </Button>
                </QueueItemPrimitive.Remove>
              )}
            </div>
          );
        }}
      </ComposerPrimitive.Queue>
      {!canRemove && withheldReason && (
        <p className="text-center text-code-sm text-[var(--text-muted)]" role="status" data-queue-withheld>{withheldReason}</p>
      )}
    </section>
  );
}
