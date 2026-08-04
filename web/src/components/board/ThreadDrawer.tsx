import { useRef } from "react";
import { X } from "lucide-react";
import { useModalFocus } from "../../hooks/use-modal-focus";
import type { TodoProgressView } from "../../lib/cockpit-view";
import { TodoProgressMeter } from "./TodoProgressMeter";

export interface ThreadDrawerProps {
  open: boolean;
  title: string;
  facts?: readonly { label: string; tone?: "default" | "dirty" | "remote" }[];
  todo?: TodoProgressView | null;
  onClose: () => void;
  children: React.ReactNode;
  composer?: React.ReactNode;
}

export function ThreadDrawer({ open, title, facts = [], todo = null, onClose, children, composer }: ThreadDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useModalFocus<HTMLDivElement>({
    active: open,
    initialFocusRef: closeRef,
    onEscape: onClose,
    priority: 40,
  });
  if (!open) return null;
  return (
    <div
      ref={drawerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="thread-drawer-title"
      className="fixed inset-0 z-50 isolate flex w-full max-w-none flex-col overflow-hidden border-l-0 bg-[var(--ground)] shadow-none min-[901px]:absolute min-[901px]:inset-y-0 min-[901px]:right-0 min-[901px]:left-auto min-[901px]:z-40 min-[901px]:max-w-[760px] min-[901px]:border-l min-[901px]:border-[var(--border-frame)] min-[901px]:bg-[var(--drawer,var(--ground))] min-[901px]:shadow-[-50px_0_120px_rgb(0_0_0/0.8)] min-[901px]:motion-safe:animate-[p-in_160ms_ease-out]"
      data-thread-drawer
      data-phone-surface="fullscreen"
      data-desktop-surface="drawer"
    >
      <header className="flex min-h-[56px] shrink-0 items-center gap-3 border-b border-[var(--rule)] bg-inherit px-4 py-3 sm:px-[22px]" data-thread-header>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 id="thread-drawer-title" className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.015em]">{title}</h2>
            {todo && todo.total > 0 && (
              <TodoProgressMeter todo={todo} className="shrink-0 bg-[var(--surface-raised)] px-2 py-1" />
            )}
          </div>
          {facts.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {facts.map((fact, index) => (
                <span
                  key={`${fact.label}:${index}`}
                  className="bg-[var(--surface-raised)] px-2 py-1 font-mono text-[11.5px] text-[var(--text-muted)] data-[tone=dirty]:text-[var(--dirty)] data-[tone=remote]:text-[var(--remote)]"
                  data-tone={fact.tone ?? "default"}
                >
                  {fact.label}
                </span>
              ))}
            </div>
          )}
        </div>
        <button ref={closeRef} type="button" className="grid size-11 place-items-center text-[var(--text-muted)] sm:size-8" aria-label="Close thread" onClick={onClose}>
          <X size={18} strokeWidth={1.75} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-inherit px-4 py-5 sm:px-6" data-thread-content>{children}</div>
      {composer && <footer className="safe-area-bottom shrink-0 border-t border-[var(--rule)] bg-inherit p-3 sm:p-4" data-thread-composer>{composer}</footer>}
    </div>
  );
}
