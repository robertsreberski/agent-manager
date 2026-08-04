import { useEffect, useState } from "react";
import type { BoardSession } from "../board/model";

export type SelectionAction = "archive" | "end" | "delete";

export interface SelectionOutcome {
  succeeded: number;
  unsupported: number;
  failed: number;
  cancelled?: boolean;
}

const CAPABILITY: Record<SelectionAction, "archive" | "end" | "delete"> = { archive: "archive", end: "end", delete: "delete" };

export function selectionBreakdown(sessions: readonly BoardSession[]): string {
  const idle = sessions.filter((session) => session.boardState === "idle").length;
  const failed = sessions.filter((session) => session.boardState === "failed").length;
  const repos = new Set(sessions.map((session) => `${session.hostId}:${session.workspaceIdentity?.repoRoot ?? session.cwd}`)).size;
  const running = sessions.filter((session) => session.activity === "running").length;
  return [
    `${sessions.length} selected`,
    idle ? `${idle} idle` : null,
    failed ? `${failed} failed` : null,
    running ? `${running} running (cannot delete)` : null,
    `across ${repos} ${repos === 1 ? "repo" : "repos"}`,
  ].filter(Boolean).join(" · ");
}

export function applicableSelection(sessions: readonly BoardSession[], action: SelectionAction): BoardSession[] {
  return sessions.filter((session) => session.control.capabilities.includes(CAPABILITY[action]) && !(action === "delete" && session.activity === "running"));
}

export function SelectionBar({
  sessions,
  onClear,
  onAction,
}: {
  sessions: readonly BoardSession[];
  onClear: () => void;
  onAction: (action: SelectionAction, sessions: readonly BoardSession[]) => Promise<SelectionOutcome> | SelectionOutcome;
}) {
  const [summary, setSummary] = useState<string | null>(null);
  const selectionIdentity = sessions.map((session) => session.id).join("\u0000");
  useEffect(() => {
    if (sessions.length > 0) setSummary(null);
  }, [selectionIdentity, sessions.length]);
  if (sessions.length === 0 && summary === null) return null;
  return (
    <aside className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-3xl flex-wrap items-center gap-2 border border-[var(--border-frame)] bg-[var(--menu)] p-2.5 shadow-[0_12px_34px_rgb(0_0_0/0.55)] motion-safe:animate-[p-in_160ms_ease-out]" aria-label="Selected sessions">
      <span className="min-w-0 flex-1 px-1 text-[12.5px] text-[var(--text-muted)]" role={sessions.length === 0 ? "status" : undefined}>{summary ?? selectionBreakdown(sessions)}</span>
      {sessions.length > 0 && (["archive", "end", "delete"] as const).map((action) => {
        const applicable = applicableSelection(sessions, action);
        if (applicable.length === 0) return null;
        return <button key={action} type="button" className={`min-h-9 px-3 text-[12px] capitalize ${action === "delete" ? "text-[var(--danger)]" : ""}`} title={applicable.length < sessions.length ? `${sessions.length - applicable.length} not supported${action === "delete" && sessions.some((session) => session.activity === "running") ? "; running sessions cannot be deleted" : ""}` : undefined} onClick={() => { setSummary(null); void Promise.resolve(onAction(action, applicable)).then((outcome) => { if (!outcome.cancelled) setSummary(`${action === "archive" ? "Archived" : action === "end" ? "Ended" : "Deleted"} ${outcome.succeeded} · ${outcome.unsupported} not supported · ${outcome.failed} failed`); }); }}>{action}{applicable.length < sessions.length ? ` ${applicable.length}` : ""}</button>;
      })}
      <button type="button" className="min-h-9 px-3 text-[12px] text-[var(--text-muted)]" onClick={() => { setSummary(null); onClear(); }}>{sessions.length === 0 ? "Dismiss" : "Clear"}</button>
    </aside>
  );
}
