import { useRef } from "react";
import { X } from "lucide-react";
import { useModalFocus } from "../../hooks/use-modal-focus";
import { SHORTCUT_GROUPS } from "../../lib/shortcuts";

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalFocus<HTMLElement>({ active: open, initialFocusRef: closeRef, onEscape: onClose, priority: 65 });
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[65] bg-black/70" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" tabIndex={-1} className="mx-auto mt-[80px] w-[min(700px,calc(100%-24px))] border border-[var(--border-frame)] bg-[var(--menu)] p-5 shadow-[var(--shadow-frame)]">
        <header className="flex items-center"><h2 id="shortcuts-title" className="text-[17px] font-semibold">Keyboard shortcuts</h2><button ref={closeRef} type="button" data-compact-control className="ml-auto grid size-10 place-items-center" aria-label="Close shortcuts" onClick={onClose}><X size={16} /></button></header>
        <div className="mt-4 grid gap-6 sm:grid-cols-2">{SHORTCUT_GROUPS.map((group) => <section key={group.label}><h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)]">{group.label}</h3><dl className="mt-2 grid gap-1.5">{group.rows.map(([key, label]) => <div key={key} className="flex items-start gap-3"><dt className="w-20 shrink-0 font-mono text-[11.5px] text-[var(--text)]">{key}</dt><dd className="m-0 text-[12.5px] leading-5 text-[var(--text-muted)]">{label}</dd></div>)}</dl></section>)}</div>
      </section>
    </div>
  );
}
