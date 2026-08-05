import { useEffect, useState } from "react";
import { Check, LoaderCircle, Minus, Plus } from "lucide-react";
import { Button, Separator } from "../ui";
import { todoCounts, todoStallMinutes, type TodoListView } from "./model";

export function TodoTickBar({ list }: { list: TodoListView }) {
  const counts = todoCounts(list);
  return (
    <span className="flex shrink-0 gap-[3px]" aria-label={`${counts.completed} of ${counts.total} todos completed`}>
      {list.steps.filter((step) => step.status !== "removed").map((step) => (
        <span key={step.id} className={`h-[3px] w-4 ${step.status === "completed" ? "bg-[var(--accent)]" : step.status === "in-progress" ? "bg-[var(--accent-quiet)]" : "bg-[var(--border-strong)]"}`} />
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
      <div className="flex min-h-10 items-center gap-2.5 py-1.5 text-body-sm text-[var(--text-muted)]">
        <Check size={15} strokeWidth={1.75} className="shrink-0" /><span className="shrink-0 text-meta-sm font-medium text-[var(--text)]">Todos</span><span className="shrink-0 font-mono text-code-sm">{counts.completed} of {counts.total}</span><TodoTickBar list={list} />
        {list.duration && <span className="ml-auto shrink-0 font-mono text-code-sm text-[var(--text-faint)]">{list.duration}</span>}
      </div>
    );
  }
  return (
    <section className="min-w-0 max-w-full border border-[var(--border-frame)] bg-[var(--surface-raised)]" aria-label={`Todos, ${counts.completed} of ${counts.total}`}>
      <header className="flex min-w-0 items-center gap-2.5 px-3.5 py-2.5">
        <strong className="shrink-0 text-meta-sm font-medium">Todos</strong><span className="shrink-0 font-mono text-code-sm text-[var(--text-secondary)]">{counts.completed} of {counts.total}</span><TodoTickBar list={list} />
      </header>
      <Separator className="bg-[var(--border-hairline)]" />
      <ol className="grid grid-cols-[minmax(0,1fr)] px-3.5 pt-1.5 pb-2.5">
        {list.steps.map((step) => (
          <li
            key={step.id}
            data-todo-churn={step.status === "removed" ? "removed" : step.addedAfterStart ? "added" : undefined}
            className={`grid grid-cols-[15px_minmax(0,1fr)] items-start gap-[11px] py-[7px] text-[13.5px] leading-5 ${step.status === "removed" ? "text-[var(--text-faint)]" : ""}`}
          >
            {step.status === "completed" ? <Check size={15} strokeWidth={1.75} className="mt-[3px] text-[var(--text-faint)]" /> : step.status === "in-progress" ? <LoaderCircle size={15} strokeWidth={1.75} className="mt-[3px] motion-safe:animate-spin text-[var(--accent)]" /> : step.status === "removed" ? <Minus size={15} strokeWidth={1.75} className="mt-[3px] text-[var(--removed)]" /> : step.addedAfterStart ? <Plus size={15} strokeWidth={1.75} className="mt-[3px] text-[var(--added)]" /> : <span className="mt-[3px] grid size-[15px] place-items-center"><span className="size-[9px] rounded-full border border-[var(--border-loud)]" /></span>}
            <span className={`min-w-0 [overflow-wrap:anywhere] [text-wrap:pretty] ${step.status === "completed" ? "text-[var(--text-secondary)] line-through decoration-[var(--text-faint)]" : step.status === "in-progress" ? "font-semibold text-[var(--text)]" : step.status === "removed" ? "text-[var(--text-faint)]" : "text-[var(--text-secondary)]"}`}>
              {step.text}
              {step.detail && step.status === "in-progress" && <span className="mt-0.5 block font-mono text-code-sm leading-[17px] font-normal text-[var(--text-muted)]">{step.detail}</span>}
              {step.removedReason && step.status === "removed" && <span className="mt-0.5 block font-mono text-code-sm leading-[17px]">{step.removedReason}</span>}
            </span>
          </li>
        ))}
      </ol>
      {(list.added > 0 || list.removed > 0) && <>
        <Separator className="bg-[var(--border-hairline)]" />
        <footer className="px-3.5 py-2 font-mono text-code-sm text-[var(--text-faint)]">+{list.added} −{list.removed} since it started</footer>
      </>}
      {stalled && (
        <div className="m-3 border-l-2 border-[var(--warning)] bg-[var(--warning-field)] p-3">
          <strong className="text-meta-sm text-[var(--warning)]">No todo has moved in {stalledFor} minutes</strong>
          <p className="mt-1 text-meta-sm text-[var(--text-muted)]">It is not blocked on you.</p>
          {/* A stall is not an attention request: these stay secondary, never lime. */}
          {(canMessage || canStop) && <div className="mt-2 flex gap-2">{canMessage && <Button variant="secondary" size="touch" className="border-[var(--border)] px-3" onClick={onAsk}>Ask what is happening</Button>}{canStop && <Button variant="secondary" size="touch" className="border-[var(--border)] px-3" onClick={onStop}>Stop the turn</Button>}</div>}
        </div>
      )}
    </section>
  );
}
