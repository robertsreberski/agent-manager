import { useEffect, useState } from "react";
import { Check, Circle, LoaderCircle, Minus, Plus } from "lucide-react";
import { todoCounts, todoStallMinutes, type TodoListView } from "./model";

export function TodoTickBar({ list }: { list: TodoListView }) {
  const counts = todoCounts(list);
  return (
    <span className="flex gap-1" aria-label={`${counts.completed} of ${counts.total} todos completed`}>
      {list.steps.filter((step) => step.status !== "removed").map((step) => (
        <span key={step.id} className={`h-[3px] w-4 ${step.status === "completed" ? "bg-[var(--accent)]" : step.status === "in-progress" ? "bg-[var(--accent-quiet)]" : "bg-[var(--border)]"}`} />
      ))}
    </span>
  );
}

export function TodoList({
  list,
  now,
  canMessage = false,
  canStop = false,
  onAsk,
  onStop,
}: {
  list: TodoListView;
  now?: number;
  canMessage?: boolean;
  canStop?: boolean;
  onAsk?: () => void;
  onStop?: () => void;
}) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (now !== undefined || !list.running || !list.active || !list.hasMoved || !list.lastTransitionAt) return;
    const transition = Date.parse(list.lastTransitionAt);
    if (!Number.isFinite(transition)) return;
    const elapsed = Math.max(0, Date.now() - transition);
    const delay = Math.max(25, 60_000 - (elapsed % 60_000));
    const timer = window.setTimeout(() => setClock(Date.now()), delay + 25);
    return () => window.clearTimeout(timer);
  }, [clock, list.active, list.hasMoved, list.lastTransitionAt, list.running, now]);
  const counts = todoCounts(list);
  const stalledFor = todoStallMinutes(list, now ?? clock);
  const stalled = stalledFor !== null && stalledFor >= 9;
  if (!list.running) {
    return (
      <div className="flex min-h-10 items-center gap-3 border border-[var(--border)] px-3 text-[12.5px]">
        <Check size={14} className="text-[var(--text-muted)]" /><span>Todos · {counts.completed} of {counts.total}</span><TodoTickBar list={list} />
        {list.duration && <span className="ml-auto font-mono text-[10.5px] text-[var(--text-muted)]">{list.duration}</span>}
      </div>
    );
  }
  return (
    <section className="border border-[var(--border)] bg-[var(--surface-raised)]" aria-label={`Todos, ${counts.completed} of ${counts.total}`}>
      <header className="flex items-center gap-3 border-b border-[var(--rule)] px-3 py-2.5">
        <strong className="text-[13px]">Todos · {counts.completed} of {counts.total}</strong><TodoTickBar list={list} />
      </header>
      <ol className="grid gap-1 p-3">
        {list.steps.map((step) => (
          <li
            key={step.id}
            data-todo-churn={step.status === "removed" ? "removed" : step.addedAfterStart ? "added" : undefined}
            className={`grid grid-cols-[18px_minmax(0,1fr)] items-start gap-2 py-1 text-[13px] ${step.status === "removed" ? "text-[var(--text-faint)]" : ""}`}
          >
            {step.status === "completed" ? <Check size={14} className="mt-0.5 text-[var(--accent)]" /> : step.status === "in-progress" ? <LoaderCircle size={14} className="mt-0.5 motion-safe:animate-spin text-[var(--accent-quiet)]" /> : step.status === "removed" ? <Minus size={14} className="mt-0.5 text-[var(--removed)]" /> : step.addedAfterStart ? <Plus size={14} className="mt-0.5 text-[var(--added)]" /> : <Circle size={10} className="mt-1 text-[var(--text-faint)]" />}
            <span className={step.status === "completed" ? "line-through text-[var(--text-muted)]" : step.status === "in-progress" ? "font-semibold text-[var(--text)]" : step.status === "removed" ? "text-[var(--text-faint)]" : "text-[var(--text-muted)]"}>
              {step.text}
              {step.detail && step.status === "in-progress" && <span className="mt-0.5 block text-[12px] font-normal leading-[18px] text-[var(--text-muted)]">{step.detail}</span>}
              {step.removedReason && step.status === "removed" && <span className="mt-0.5 block text-[11px]">{step.removedReason}</span>}
            </span>
          </li>
        ))}
      </ol>
      {(list.added > 0 || list.removed > 0) && <footer className="border-t border-[var(--rule)] px-3 py-2 font-mono text-[10.5px] text-[var(--text-muted)]">+{list.added} −{list.removed} since it started</footer>}
      {stalled && (
        <div className="m-3 border-l-2 border-[var(--warning)] bg-[var(--warning-field)] p-3">
          <strong className="text-[12.5px] text-[var(--warning)]">No todo has moved in {stalledFor} minutes</strong>
          <p className="mt-1 text-[12px] text-[var(--text-muted)]">It is not blocked on you.</p>
          {(canMessage || canStop) && <div className="mt-2 flex gap-2">{canMessage && <button type="button" className="min-h-9 border border-[var(--border)] px-3 text-[12px]" onClick={onAsk}>Ask what is happening</button>}{canStop && <button type="button" className="min-h-9 border border-[var(--border)] px-3 text-[12px]" onClick={onStop}>Stop the turn</button>}</div>}
        </div>
      )}
    </section>
  );
}
