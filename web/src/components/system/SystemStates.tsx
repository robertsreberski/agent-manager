import { AlertTriangle, Check, ChevronRight, Copy, FolderGit2, LoaderCircle, PlugZap, RotateCcw, Server, WifiOff } from "lucide-react";
import type { CockpitSessionView, SessionCapability } from "../../lib/cockpit-view";
import type { SetupHookOffer, SetupHostProbe, SetupNearbyWorkspace } from "../../../../src/shared/setup.ts";
import type { SelectedSessionFactsResponse, SessionTurnUsage } from "../../../../src/shared/session-facts.ts";
import { useState, type FormEvent, type ReactNode } from "react";

export function ConnectingState({ sources }: { sources: readonly string[] }) {
  return (
    <section className="mx-auto grid max-w-lg gap-5 p-8 text-center" aria-live="polite">
      <LoaderCircle size={22} className="mx-auto motion-safe:animate-spin text-[var(--text-muted)]" />
      <div><h2 className="text-[17px] font-semibold">Finding agent sessions</h2><p className="mt-1 text-[13px] text-[var(--text-muted)]">{sources.length ? sources.join(" · ") : "Starting discovery"}</p></div>
      <div className="grid gap-2" aria-hidden="true">{[80, 64, 72].map((width) => <span key={width} className="mx-auto h-8 animate-pulse bg-[var(--surface-raised)] motion-reduce:animate-none" style={{ width: `${width}%` }} />)}</div>
    </section>
  );
}

function staleDuration(generatedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(generatedAt)) / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

export function OfflineState({ generatedAt, now = Date.now() }: { generatedAt: string; now?: number }) {
  return (
    <div className="flex items-start gap-2 border-l-2 border-[var(--warning)] bg-[var(--warning-field)] px-3 py-2.5 text-[12.5px]" role="status">
      <WifiOff size={15} className="mt-0.5 text-[var(--warning)]" />
      <p><strong className="text-[var(--warning)]">Cockpit offline.</strong> Agents are still running. Showing a {staleDuration(generatedAt, now)} old snapshot from {new Date(generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Messages stay here until the connection is safe to resume.</p>
    </div>
  );
}

export function EmptyState({ repositories, onOpen }: { repositories: readonly { id: string; name: string; path: string }[]; onOpen: (id: string) => void }) {
  return (
    <section className="mx-auto max-w-lg p-8 text-center">
      <FolderGit2 size={24} className="mx-auto text-[var(--text-muted)]" /><h2 className="mt-4 text-[17px] font-semibold">No agent sessions yet</h2><p className="mt-1 text-[13px] text-[var(--text-muted)]">Start a thread in a repository already visible to Agent Manager.</p>
      <div className="mt-5 grid gap-2">{repositories.map((repo) => <button key={repo.id} type="button" className="flex min-h-11 items-center gap-2 border border-[var(--border)] px-3 text-left" onClick={() => onOpen(repo.id)}><span className="min-w-0 flex-1"><strong className="block text-[13px]">{repo.name}</strong><span className="block truncate font-mono text-[10.5px] text-[var(--text-muted)]">{repo.path}</span></span><ChevronRight size={14} /></button>)}</div>
    </section>
  );
}

export function SessionEndedState({
  canResume,
  resumeCommand,
  resumeDescription,
  resumeError,
  resumeUnavailableReason,
  loadingResume = false,
  onResume,
  canContinue,
  onContinue,
}: {
  canResume: boolean;
  resumeCommand?: string | null;
  resumeDescription?: string | null;
  resumeError?: string | null;
  resumeUnavailableReason?: string | null;
  loadingResume?: boolean;
  onResume?: () => void;
  canContinue: boolean;
  onContinue?: () => void;
}) {
  return (
    <section className="border border-[var(--border)] p-4 text-center"><Check size={18} className="mx-auto text-[var(--text-muted)]" /><h3 className="mt-2 text-sm font-semibold">This session ended</h3>
      {canResume && !resumeCommand && <button type="button" className="mx-auto mt-3 flex min-h-10 items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-[12.5px] font-medium text-[var(--accent-ink)] disabled:opacity-40" disabled={loadingResume} onClick={onResume}><RotateCcw size={13} />{loadingResume ? "Loading resume wrapper…" : "Show resume command"}</button>}
      {canResume && resumeCommand && <div className="mt-3 text-left"><p className="text-[12px] text-[var(--text-muted)]">{resumeDescription ?? "Run this authenticated wrapper in a terminal to resume the same provider session."}</p><div className="mt-2 flex items-start gap-2"><pre className="min-w-0 flex-1 overflow-x-auto bg-[var(--surface-raised)] p-2 font-mono text-[11px]">{resumeCommand}</pre><button type="button" className="min-h-9 border border-[var(--border)] px-2 text-[11px]" onClick={() => void navigator.clipboard?.writeText(resumeCommand)}>Copy</button></div></div>}
      {resumeError && <p className="mt-2 text-[11.5px] text-[var(--warning)]">{resumeError}</p>}
      {!canResume && resumeUnavailableReason && <p className="mt-2 text-[11.5px] text-[var(--text-muted)]">{resumeUnavailableReason}</p>}
      {canContinue && <button type="button" className={`${canResume ? "mt-2 text-[var(--text-muted)] underline" : "mx-auto mt-3 flex rounded-full bg-[var(--accent)] px-4 font-medium text-[var(--accent-ink)]"} min-h-10 items-center gap-1.5 text-[12.5px]`} onClick={onContinue}><RotateCcw size={13} />Start a new thread in this worktree</button>}
      {!canResume && !canContinue && !resumeUnavailableReason && <p className="mt-1 text-[12.5px] text-[var(--text-muted)]">This harness does not expose a safe continuation.</p>}
    </section>
  );
}

const CAPABILITY_SENTENCE: Record<SessionCapability, string> = {
  queue: "Queue messages for the next turn", steer: "Steer the active turn", interrupt: "Stop the active turn", respond: "Answer exact questions and approvals", "set-profile": "Change the execution profile", "set-model": "Change the model", "set-effort": "Change reasoning effort", "remove-queued": "Remove queued messages", preview: "Preview the native terminal", attach: "Attach from a terminal", resume: "Resume this session", end: "End this managed run", archive: "Archive this thread", delete: "Delete this thread", "open-editor": "Open changed files in the editor",
};
const ALL_CAPABILITIES = Object.keys(CAPABILITY_SENTENCE) as SessionCapability[];

const HARNESS_LABEL: Record<CockpitSessionView["control"]["plane"], string> = {
  "codex-private": "Codex managed app server",
  "codex-hook-bridge": "Codex hook bridge",
  "claude-sdk": "Claude Agent SDK",
  "claude-hook-bridge": "Claude hook bridge",
  "tmux-attach": "tmux observation",
  "resume-only": "Provider resume only",
  "observe-only": "Observation only",
};

function FactSection({ title, children }: { title: string; children: ReactNode }) {
  return <div><h3 className="border-b border-[var(--rule)] pb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)]">{title}</h3>{children}</div>;
}

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 border-b border-[var(--rule)] py-2 last:border-b-0"><span className="text-[var(--text-muted)]">{label}</span><span className="min-w-0 break-words font-mono text-[12px]">{children}</span></div>;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatProfile(value: CockpitSessionView["profile"]): string {
  switch (value) {
    case "ask-first": return "Ask first";
    case "plan": return "Plan";
    case "execute": return "Standard access";
    case "full-access": return "Full access";
    case null: return "Unknown";
  }
}

function formatPlan(value: string): string {
  return value === "unknown"
    ? "Unknown plan"
    : `${value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase())} plan`;
}

function rateWindow(value: { usedPercent: number; resetsAt: number | null }): string {
  const reset = value.resetsAt === null
    ? null
    : `resets ${new Date(value.resetsAt * 1_000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  return [`${value.usedPercent}% used`, reset].filter(Boolean).join(" · ");
}

function TurnFacts({ usage, factsStatus }: { usage: SessionTurnUsage | null; factsStatus: "loading" | "loaded" | "error" }) {
  if (factsStatus === "loading" && usage === null) return <p className="mt-3 text-[12px] text-[var(--text-muted)]">Reading exact usage facts…</p>;
  if (factsStatus === "error" && usage === null) return <p className="mt-3 text-[12px] text-[var(--text-muted)]">Exact turn usage is unavailable.</p>;
  if (usage === null) return <p className="mt-3 text-[12px] text-[var(--text-muted)]">No exact turn usage has been exposed.</p>;
  const metrics = [
    usage.totalTokens !== null ? { label: "Tokens", value: formatTokens(usage.totalTokens) } : null,
    usage.inputTokens !== null ? { label: "Input", value: formatTokens(usage.inputTokens) } : null,
    usage.outputTokens !== null ? { label: "Output", value: formatTokens(usage.outputTokens) } : null,
    usage.costUsd !== null ? { label: "Cost", value: `$${usage.costUsd.toFixed(4)}` } : null,
  ].filter((value): value is { label: string; value: string } => value !== null);
  return metrics.length === 0
    ? <p className="mt-3 text-[12px] text-[var(--text-muted)]">The harness emitted usage without token or cost totals.</p>
    : <div className="mt-3 grid grid-cols-2 gap-px bg-[var(--rule)] sm:grid-cols-4">{metrics.map((metric) => <div key={metric.label} className="bg-[var(--surface-raised)] p-2.5"><span className="block font-mono text-[9.5px] uppercase tracking-[0.08em] text-[var(--text-faint)]">{metric.label}</span><strong className="mt-1 block text-[15px] tabular-nums">{metric.value}</strong></div>)}</div>;
}

export function SessionCapabilityPanel({
  session,
  facts,
  factsStatus,
  attachCommand,
  attachError,
  loadingAttach,
  onRevealAttach,
}: {
  session: CockpitSessionView;
  facts: SelectedSessionFactsResponse | null;
  factsStatus: "loading" | "loaded" | "error";
  attachCommand?: string | null;
  attachError?: string | null;
  loadingAttach?: boolean;
  onRevealAttach?: () => void;
}) {
  const offered = new Set(session.control.capabilities);
  const withheld = new Map(session.control.withheld.map((item) => [item.capability, item.reason]));
  const workspace = session.workspaceIdentity;
  const canRevealAttach = offered.has("attach") || offered.has("resume");
  const account = facts?.account.available ? facts.account : null;
  return (
    <section className="grid gap-5 text-[13px]">
      <FactSection title="Where it runs"><div className="mt-1"><FactRow label="Host">{session.hostLabel}{session.hostId !== session.hostLabel ? <span className="ml-2 text-[var(--text-faint)]">{session.hostId}</span> : null}</FactRow><FactRow label="Repository">{workspace?.repoName ?? "Unknown"}</FactRow><FactRow label="Worktree">{workspace?.worktreePath ?? session.cwd ?? "Unknown"}</FactRow><FactRow label="Branch">{workspace?.detached ? "Detached HEAD" : workspace?.branch ?? "Unknown"}</FactRow>{workspace?.dirtyCount !== null && workspace?.dirtyCount !== undefined && <FactRow label="Changes">{workspace.dirtyCount === 0 ? "Clean" : `${workspace.dirtyCount} uncommitted`}</FactRow>}<FactRow label="Harness"><span className="font-sans font-medium">{HARNESS_LABEL[session.control.plane]}</span>{session.model && <span className="ml-2 text-[var(--text-muted)]">{session.model}</span>}{session.effort && <span className="ml-2 text-[var(--text-faint)]">{session.effort}</span>}</FactRow></div></FactSection>
      <FactSection title="What it may do"><ul className="mt-3 grid gap-1.5">{ALL_CAPABILITIES.map((capability) => <li key={capability} className="flex gap-2"><span aria-label={offered.has(capability) ? "Available" : withheld.has(capability) ? "Unavailable" : "Unknown"}>{offered.has(capability) ? "✓" : withheld.has(capability) ? "×" : "?"}</span><span>{CAPABILITY_SENTENCE[capability]}{withheld.get(capability) && <span className="block text-[11.5px] text-[var(--text-muted)]">{withheld.get(capability)}</span>}</span></li>)}</ul><p className="mt-3 text-[12px]"><span className="text-[var(--text-muted)]">Execution profile</span> · {formatProfile(session.profile)}{offered.has("set-profile") && <span className="ml-2 font-mono text-[10px] text-[var(--text-faint)]">changeable mid-session</span>}</p></FactSection>
      <FactSection title="What this turn cost"><TurnFacts usage={facts?.turnUsage ?? null} factsStatus={factsStatus} />{account?.usage && <div className="mt-3 border-t border-[var(--rule)] pt-3"><p className="text-[12px]"><span className="text-[var(--text-muted)]">Codex account</span>{account.usage.summary.lifetimeTokens !== null && <> · {formatTokens(account.usage.summary.lifetimeTokens)} lifetime tokens</>}{account.usage.summary.peakDailyTokens !== null && <> · {formatTokens(account.usage.summary.peakDailyTokens)} peak day</>}</p>{account.usage.recentDays.length > 0 && <ul className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] text-[var(--text-muted)]" aria-label="Recent account token usage">{account.usage.recentDays.slice(-7).map((day) => <li key={day.date}>{day.date.slice(5)} · {formatTokens(day.tokens)}</li>)}</ul>}</div>}{account?.rateLimits && account.rateLimits.length > 0 && <ul className="mt-3 grid gap-2 border-t border-[var(--rule)] pt-3">{account.rateLimits.map((limit, index) => <li key={`${limit.label ?? "limit"}:${index}`} className="text-[12px]"><span className="font-medium">{limit.label ?? "Codex limit"}</span>{limit.planType && <span className="ml-2 text-[var(--text-muted)]">{formatPlan(limit.planType)}</span>}{limit.primary && <span className="block font-mono text-[10.5px] text-[var(--text-muted)]">Primary · {rateWindow(limit.primary)}</span>}{limit.secondary && <span className="block font-mono text-[10.5px] text-[var(--text-muted)]">Secondary · {rateWindow(limit.secondary)}</span>}{limit.spendControlReached === true && <span className="block text-[var(--warning)]">Account spend control reached</span>}</li>)}</ul>}{facts?.account.available === false && facts.account.reason === "provider-unavailable" && <p className="mt-3 text-[11.5px] text-[var(--text-muted)]">Codex account facts are temporarily unavailable.</p>}</FactSection>
      <FactSection title="How to attach from a terminal">{attachCommand ? <div className="mt-3 flex items-start gap-2 bg-[var(--surface-raised)] p-2"><pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11.5px]">{attachCommand}</pre><button type="button" className="grid min-h-9 min-w-9 place-items-center" aria-label="Copy guarded attach command" onClick={() => void navigator.clipboard?.writeText(attachCommand)}><Copy size={14} /></button></div> : canRevealAttach ? <button type="button" className="mt-3 min-h-10 border border-[var(--border)] px-3 text-[12px]" disabled={loadingAttach} onClick={onRevealAttach}>{loadingAttach ? "Loading guarded wrapper…" : "Show guarded attach command"}</button> : <p className="mt-3 text-[12px] text-[var(--text-muted)]">{withheld.get("attach") ?? withheld.get("resume") ?? "This harness does not expose a guarded attach wrapper."}</p>}{attachError && <p className="mt-2 text-[11.5px] text-[var(--warning)]">{attachError}</p>}{attachCommand && <p className="mt-2 font-mono text-[10px] text-[var(--text-faint)]">Copied, never run by the browser.</p>}</FactSection>
    </section>
  );
}

export function FirstRun({
  nearby,
  hosts,
  onChooseFolder,
  onBrowse,
}: {
  nearby: readonly SetupNearbyWorkspace[];
  hosts: readonly Pick<SetupHostProbe, "id" | "label" | "kind">[];
  onChooseFolder: (workspace: Pick<SetupNearbyWorkspace, "hostId" | "path">) => void;
  onBrowse: (hostId: string, path: string) => Promise<readonly string[]>;
}) {
  const [browseOpen, setBrowseOpen] = useState(false);
  const [hostId, setHostId] = useState(hosts.find((host) => host.kind === "local")?.id ?? hosts[0]?.id ?? "local");
  const [path, setPath] = useState("");
  const [paths, setPaths] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function findFolders(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setPaths([]);
    try {
      const matches = await onBrowse(hostId, path.trim());
      setPaths(matches);
      if (matches.length === 0) setError("No accessible folders matched that path.");
    } catch (browseError) {
      setError(browseError instanceof Error ? browseError.message : "Folder lookup failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mx-auto grid max-w-xl gap-6 p-6 sm:p-10">
      <div><p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)]">First run · 1 of 3</p><h1 className="mt-2 text-[24px] font-semibold tracking-[-0.02em]">Choose a folder</h1><p className="mt-2 text-sm text-[var(--text-muted)]">Folders already known to Agent Manager appear here. Repositories and worktrees seen through bounded session discovery are remembered locally too.</p></div>
      <div className="grid gap-2">
        {nearby.map((workspace) => <button key={`${workspace.hostId}:${workspace.path}`} type="button" className="flex min-h-11 items-center gap-3 border border-[var(--border)] px-3 py-2 text-left" onClick={() => onChooseFolder(workspace)}><FolderGit2 size={15} className="shrink-0 text-[var(--text-muted)]" /><span className="min-w-0 flex-1"><strong className="block text-[12.5px]">{workspace.label}</strong><span className="block truncate font-mono text-[10px] text-[var(--text-muted)]">{workspace.path}</span></span>{workspace.source === "discovered" && <span className="font-mono text-[9.5px] uppercase text-[var(--text-faint)]">seen now</span>}</button>)}
        <button type="button" className="min-h-11 border border-dashed border-[var(--border)] px-3 text-[12.5px]" aria-expanded={browseOpen} onClick={() => setBrowseOpen((open) => !open)}>Browse another folder…</button>
      </div>
      {browseOpen && <form className="grid gap-3 border border-[var(--border)] p-3" onSubmit={(event) => void findFolders(event)}>
        <p className="text-[12px] leading-5 text-[var(--text-muted)]">Browse folders on the selected Agent Manager host. Only server-confirmed directory suggestions can be chosen.</p>
        <div className="flex min-w-0">
          <select aria-label="Browse host" value={hostId} onChange={(event) => { setHostId(event.target.value); setPaths([]); setError(null); }} className="min-h-11 max-w-40 border border-[var(--border)] bg-[var(--menu)] px-2 text-[12px]">
            {hosts.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}
          </select>
          <input aria-label="Browse folder path" value={path} onChange={(event) => { setPath(event.target.value); setPaths([]); setError(null); }} className="min-h-11 min-w-0 flex-1 border border-l-0 border-[var(--border)] bg-transparent px-3 font-mono text-[11.5px]" placeholder="/path/to/repository" autoComplete="off" />
          <button type="submit" disabled={loading} className="min-h-11 border border-l-0 border-[var(--border)] px-3 text-[12px] disabled:opacity-40">{loading ? "Finding…" : "Find"}</button>
        </div>
        {error && <p role="alert" className="text-[12px] text-[var(--warning)]">{error}</p>}
        {paths.length > 0 && <ul className="grid gap-1" aria-label="Matching folders">{paths.map((match) => <li key={match}><button type="button" className="min-h-10 w-full truncate border border-[var(--border)] px-3 text-left font-mono text-[11px]" title={match} onClick={() => onChooseFolder({ hostId, path: match })}>{match}</button></li>)}</ul>}
      </form>}
      {nearby.length === 0 && <p className="flex gap-2 text-[12px] text-[var(--warning)]"><AlertTriangle size={14} />No nearby repositories were discovered. You can still browse for one.</p>}
    </section>
  );
}

function hookStateLabel(hook: SetupHookOffer): string {
  switch (hook.state) {
    case "active": return "Active";
    case "installed-unseen": return "Installed · no event seen yet";
    case "awaiting-trust": return "Installed · awaiting Codex trust";
    case "absent": return "Not installed";
    case "stale-token-schema": return "Installed configuration is stale";
    case "untrusted": return "Unrecognized Agent Manager hook";
    case "provider-disabled": return "Provider disabled";
  }
}

export function HookSetupStep({ hooks, onContinue }: {
  hooks: { claude: SetupHookOffer; codex: SetupHookOffer };
  onContinue: () => void;
}) {
  return (
    <section className="mx-auto grid max-w-3xl gap-5 p-6 sm:p-10">
      <div><p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)]">Optional setup · 2 of 3</p><h1 className="mt-2 text-[24px] font-semibold">See terminal-started sessions</h1><p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">Hooks let Agent Manager see and answer sessions you started in a terminal. Review the exact CLI command and redacted settings diff below, then run the command yourself if you want the integration. This browser never changes provider settings. Skipping this step changes nothing.</p></div>
      <div className="grid gap-3 sm:grid-cols-2">{([hooks.claude, hooks.codex] as const).map((hook) => <article key={hook.provider} className="min-w-0 border border-[var(--border)] p-4"><div className="flex items-start gap-2"><PlugZap size={15} className="mt-0.5 text-[var(--text-muted)]" /><div className="min-w-0"><h2 className="capitalize text-[14px] font-semibold">{hook.provider}</h2><p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">{hookStateLabel(hook)}</p></div></div><p className="mt-3 break-all font-mono text-[10px] text-[var(--text-faint)]">{hook.settingsPath}</p><pre className="mt-3 overflow-x-auto bg-[var(--surface-raised)] p-2 font-mono text-[10.5px] leading-4">{hook.command}</pre>{hook.diff && <details className="mt-3" open><summary className="cursor-pointer text-[11.5px] font-medium">Exact redacted settings diff</summary><pre className="mt-2 max-h-72 overflow-auto bg-[var(--ground)] p-2 font-mono text-[10px] leading-4">{hook.diff}</pre></details>}{hook.notice && <p className="mt-2 text-[11px] leading-4 text-[var(--text-muted)]">{hook.notice}</p>}<div className="mt-4 flex justify-end"><span className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]"><Check size={13} />{hook.changed ? "Run the command in a terminal to apply" : "No settings change needed"}</span></div></article>)}</div>
      <div className="flex justify-end"><button type="button" className="min-h-10 px-3 text-[12.5px] text-[var(--text-muted)]" onClick={onContinue}>Continue without changing settings</button></div>
    </section>
  );
}

function harnessLabel(host: SetupHostProbe, provider: "codex" | "claude"): string {
  const harness = host.harnesses[provider];
  if (harness.state === "present") return `${provider} present`;
  if (harness.state === "missing") return `${provider} missing`;
  return `${provider} not checked`;
}

export function HostSetupStep({ hosts, onContinue }: { hosts: readonly SetupHostProbe[]; onContinue: () => void }) {
  const remote = hosts.filter((host) => host.kind === "ssh");
  return (
    <section className="mx-auto grid max-w-xl gap-5 p-6 sm:p-10">
      <div><p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-faint)]">Optional setup · 3 of 3</p><h1 className="mt-2 text-[24px] font-semibold">Existing remote hosts</h1><p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">Each configured SSH host is checked within a short deadline. A missing harness only limits what that host can run; it does not fail setup.</p></div>
      <div className="grid gap-2">{remote.map((host) => <article key={host.id} className="border border-[var(--border)] p-3"><div className="flex items-center gap-2"><Server size={14} className="text-[var(--remote)]" /><strong className="text-[13px]">{host.label}</strong><span className="ml-auto font-mono text-[10px] text-[var(--text-faint)]">{host.status}</span></div><div className="mt-2 flex flex-wrap gap-2">{(["codex", "claude"] as const).map((provider) => { const available = host.harnesses[provider]; return <span key={provider} className={`border border-[var(--border)] px-2 py-1 font-mono text-[10.5px] ${available.state === "missing" ? "text-[var(--warning)]" : "text-[var(--text-muted)]"}`} title={available.reason ?? undefined}>{harnessLabel(host, provider)}</span>; })}</div></article>)}{remote.length === 0 && <p className="text-[12.5px] text-[var(--text-muted)]">No remote hosts are configured. Add one later with <code className="font-mono">agent-manager host add</code>.</p>}</div>
      <div className="flex justify-end"><button type="button" className="min-h-10 rounded-full bg-[var(--accent)] px-4 text-[12.5px] font-medium text-[var(--accent-ink)]" onClick={onContinue}>Continue to new thread</button></div>
    </section>
  );
}
