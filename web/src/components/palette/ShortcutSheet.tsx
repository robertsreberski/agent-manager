import { Fragment, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, Separator } from "../ui";
import { SHORTCUT_GROUPS } from "../../lib/shortcuts";

/** Frame 13b prints each chord as its own key cap, split on the separators. */
function keyCaps(keys: string): readonly string[] {
  return keys.split(" ").filter((part) => part.length > 0);
}

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  // `?` opens this sheet, so there is no `DialogTrigger` for Radix to return
  // focus to. Remember the opener before the focus scope takes over.
  const openerRef = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[calc(100dvh-5rem)] max-w-[700px] overflow-y-auto px-[30px] pt-[26px] pb-6"
        onOpenAutoFocus={() => { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); openerRef.current?.focus(); }}
      >
        <DialogHeader className="gap-0 pb-1.5">
          {/* The frame prints "Keys"; assistive tech gets the full name. */}
          <DialogTitle className="sr-only">Keyboard shortcuts</DialogTitle>
          <p className="flex items-baseline gap-2.5 pr-8">
            <span aria-hidden="true" className="text-title-md text-[var(--text)]">Keys</span>
            <span className="font-mono text-code-sm text-[var(--text-faint)]">? closes this</span>
          </p>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-x-[34px] gap-y-0 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.label} className="flex flex-col pb-1.5">
              <h3 className="block pt-2.5 pb-[7px] font-mono text-eyebrow text-[var(--text-faint)] uppercase">{group.label}</h3>
              <dl className="m-0 grid">
                {group.rows.map(([keys, label]) => (
                  <Fragment key={keys}>
                    <div className="flex items-center gap-[11px] py-1.5">
                      <dt className="flex min-w-[62px] shrink-0 gap-[3px]">
                        {keyCaps(keys).map((cap, index) => cap === "/"
                          ? <span key={`${cap}:${index}`} className="text-[var(--text-faint)]">/</span>
                          : <kbd key={`${cap}:${index}`} className="inline-flex h-[19px] min-w-[19px] items-center justify-center bg-[var(--surface-selected)] px-[5px] font-mono text-code-xs text-[var(--text-secondary)]">{cap}</kbd>)}
                      </dt>
                      <dd className="m-0 min-w-0 flex-1 text-meta-sm text-[var(--text-secondary)]">{label}</dd>
                    </div>
                    <Separator />
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
