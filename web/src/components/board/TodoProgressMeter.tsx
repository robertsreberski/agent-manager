import type { TodoProgressView } from "../../lib/cockpit-view";

export function TodoProgressMeter({
  todo,
  className = "",
}: {
  todo: TodoProgressView;
  className?: string;
}) {
  if (todo.total <= 0) return null;
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-2 text-[11px] text-[var(--text-muted)] ${className}`}
      aria-label={`${todo.completed} of ${todo.total} todos completed`}
      data-todo-progress
    >
      <span className="flex shrink-0 gap-[3px]" aria-hidden="true">
        {Array.from({ length: todo.total }, (_, index) => (
          <span
            key={index}
            className={`h-[3px] w-4 ${index < todo.completed
              ? "bg-[var(--accent)]"
              : index === todo.completed && todo.current
                ? "bg-[var(--accent-quiet)]"
                : "bg-[var(--border)]"}`}
          />
        ))}
      </span>
      <span className="shrink-0 font-mono">{todo.completed} of {todo.total}</span>
    </span>
  );
}
