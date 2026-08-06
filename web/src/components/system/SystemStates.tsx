import { AlertTriangle, Check, ChevronRight, CircleHelp, CircleX, Copy, FolderGit2, LoaderCircle, Plus, PlugZap, RotateCcw, Server, Trash2, WifiOff, X } from "lucide-react";
import { workspaceChangeFacts, workspaceChangeLabel, type CockpitSessionView, type SessionCapability } from "../../lib/cockpit-view";
import type { SetupHookOffer, SetupHostProbe, SetupNearbyWorkspace } from "../../../../src/shared/setup.ts";
import type { SelectedSessionFactsResponse, SessionTurnUsage } from "../../../../src/shared/session-facts.ts";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
} from "../ui";

export function ConnectingState({ sources }: { sources: readonly string[] }) {
  return (
    <section className="mx-auto grid max-w-lg gap-5 p-8 text-center" aria-live="polite">
      <LoaderCircle size={22} className="mx-auto motion-safe:animate-spin text-[var(--text-muted)]" />
      <div><h2 className="text-title">Finding agent sessions</h2><p className="mt-1 text-meta text-[var(--text-muted)]">{sources.length ? sources.join(" · ") : "Starting discovery"}</p></div>
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
    <div className="flex items-start gap-2 border-l-2 border-[var(--warning)] bg-[var(--warning-field)] px-3 py-2.5 text-meta-sm" role="status">
      <WifiOff size={15} className="mt-0.5 text-[var(--warning)]" />
      <p><strong className="text-[var(--warning)]">Cockpit offline.</strong> Agents are still running. Showing a {staleDuration(generatedAt, now)} old snapshot from {new Date(generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Messages stay here until the connection is safe to resume.</p>
    </div>
  );
}

export function EmptyState({ repositories, onOpen }: { repositories: readonly { id: string; name: string; path: string }[]; onOpen: (id: string) => void }) {
  return (
    <section className="mx-auto max-w-lg p-8 text-center">
      <FolderGit2 size={24} className="mx-auto text-[var(--text-muted)]" /><h2 className="mt-4 text-title">No agent sessions yet</h2><p className="mt-1 text-meta text-[var(--text-muted)]">Start a thread in a repository already visible to Agent Manager.</p>
      <div className="mt-5 grid gap-2">{repositories.map((repo) => <Button key={repo.id} variant="secondary" size="touch" className="w-full justify-start border-[var(--border)] px-3 text-left" onClick={() => onOpen(repo.id)}><span className="min-w-0 flex-1"><strong className="block text-meta">{repo.name}</strong><span className="block truncate font-mono text-code-xs text-[var(--text-muted)]">{repo.path}</span></span><ChevronRight size={14} /></Button>)}</div>
    </section>
  );
}

export function SessionEndedState({
  canResume,
  resumeUnavailableReason,
  resuming = false,
  resumeDisabled = false,
  onResume,
  canContinue,
  onContinue,
}: {
  canResume: boolean;
  resumeUnavailableReason?: string | null;
  resuming?: boolean;
  resumeDisabled?: boolean;
  onResume?: () => void;
  canContinue: boolean;
  onContinue?: () => void;
}) {
  return (
    <section className="border border-[var(--border)] p-4 text-center"><Check size={18} className="mx-auto text-[var(--text-muted)]" /><h3 className="mt-2 text-body-sm font-semibold">This session ended</h3>
      {canResume && <><p className="mt-1 text-meta-sm text-[var(--text-muted)]">Continue this exact provider conversation in Agent Manager.</p><Button variant="primary" size="touch" className="mx-auto mt-3 gap-1.5" disabled={resuming || resumeDisabled} onClick={onResume}><RotateCcw size={13} />{resuming ? "Resuming…" : "Resume here"}</Button></>}
      {!canResume && resumeUnavailableReason && <p className="mt-2 text-code-sm text-[var(--text-muted)]">{resumeUnavailableReason}</p>}
      {canContinue && <Button variant={canResume ? "ghost" : "primary"} size="touch" className={`mx-auto gap-1.5 ${canResume ? "mt-2 underline" : "mt-3"}`} onClick={onContinue}><RotateCcw size={13} />Start a new thread in this worktree</Button>}
      {!canResume && !canContinue && !resumeUnavailableReason && <p className="mt-1 text-meta-sm text-[var(--text-muted)]">This harness does not expose a safe continuation.</p>}
    </section>
  );
}

const CAPABILITY_SENTENCE: Record<SessionCapability, string> = {
  queue: "Queue messages for the next turn", steer: "Steer the active turn", interrupt: "Stop the active turn", respond: "Answer exact questions and approvals", "set-profile": "Change the execution profile", "set-sandbox": "Change the Codex sandbox while the thread is idle", "set-model": "Change the model", "set-effort": "Change reasoning effort", "remove-queued": "Remove queued messages", preview: "Preview the native terminal", attach: "Attach from a terminal", resume: "Resume the exact session in the web app", end: "End this managed run", archive: "Archive this thread", delete: "Delete this thread", "take-control": "Connect provider control to the web app", "cancel-take-control": "Cancel a pending control migration", "retry-control": "Retry provider control recovery", "open-editor": "Open changed files in the editor",
};
const ALL_CAPABILITIES = Object.keys(CAPABILITY_SENTENCE) as SessionCapability[];

const HARNESS_LABEL: Record<CockpitSessionView["control"]["plane"], string> = {
  "codex-private": "Codex managed app server",
  "claude-sdk": "Claude Agent SDK",
  "claude-hook-bridge": "Claude hook bridge",
  "tmux-attach": "tmux observation",
  "resume-only": "Provider resume only",
  "observe-only": "Observation only",
};

function FactSection({ title, children }: { title: string; children: ReactNode }) {
  return <div><h3 className="pb-[9px] font-mono text-eyebrow leading-none text-[var(--text-faint)] uppercase">{title}</h3><Separator className="bg-[var(--border-hairline)]" />{children}</div>;
}

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div className="flex items-baseline gap-[14px] py-[9px]"><span className="w-[104px] shrink-0 text-meta-sm leading-[1.5] text-[var(--text-muted)]">{label}</span><span className="min-w-0 flex-1 break-words font-mono text-meta leading-[1.5]">{children}</span></div>
      {/* The rule belongs between rows, so the trailing one removes itself. */}
      <Separator className="last:hidden" />
    </>
  );
}

function capabilitySentence(session: CockpitSessionView, capability: SessionCapability): string {
  if (capability === "attach" && session.control.coordination.nativeAttach === "join") {
    return session.provider === "codex"
      ? "Open the same conversation in Codex CLI"
      : "Open the same conversation in Claude Code";
  }
  /*
    Only Codex offers takeover now: a standalone Codex process must migrate once
    before it can be shared, because a rollout is a flat event log with no parent
    pointers and cannot represent two concurrent writers. Claude is joined
    instead, so the Claude branch that used to read "Move exclusive Claude Code
    control to the web app" is gone.
  */
  if (capability === "take-control") {
    return "Migrate once to shared CLI + web control";
  }
  return CAPABILITY_SENTENCE[capability];
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

function formatSandbox(value: CockpitSessionView["sandbox"]): string {
  if (value === null) return "No sandbox";
  switch (value.mode) {
    case "read-only": return "Read-only sandbox";
    case "danger-full-access": return "Full access sandbox";
    case "workspace-write":
      return `Workspace sandbox · network ${value.networkAccess ? "on" : "off"}`;
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
  if (factsStatus === "loading" && usage === null) return <p className="mt-3 text-meta-sm text-[var(--text-muted)]">Reading exact usage facts…</p>;
  if (factsStatus === "error" && usage === null) return <p className="mt-3 text-meta-sm text-[var(--text-muted)]">Exact turn usage is unavailable.</p>;
  if (usage === null) return <p className="mt-3 text-meta-sm text-[var(--text-muted)]">No exact turn usage has been exposed.</p>;
  const metrics = [
    usage.totalTokens !== null ? { label: "Tokens", value: formatTokens(usage.totalTokens) } : null,
    usage.inputTokens !== null ? { label: "Input", value: formatTokens(usage.inputTokens) } : null,
    usage.outputTokens !== null ? { label: "Output", value: formatTokens(usage.outputTokens) } : null,
    usage.costUsd !== null ? { label: "Cost", value: `$${usage.costUsd.toFixed(4)}` } : null,
  ].filter((value): value is { label: string; value: string } => value !== null);
  return metrics.length === 0
    ? <p className="mt-3 text-meta-sm text-[var(--text-muted)]">The harness emitted usage without token or cost totals.</p>
    // Frame 9b separates the tiles with a 1px rule showing through the gap
    // rather than raising them off the panel.
    : <div className="mt-3 grid grid-cols-2 gap-px bg-[var(--border-hairline)] sm:grid-cols-4">{metrics.map((metric) => <div key={metric.label} className="bg-[var(--drawer)] px-3 py-[11px]"><span className="block font-mono text-eyebrow uppercase leading-none tracking-[0.08em] text-[var(--text-faint)]">{metric.label}</span><strong className="mt-[5px] block text-title leading-none tabular-nums">{metric.value}</strong></div>)}</div>;
}

export function SessionCapabilityPanel({
  session,
  archived = false,
  facts,
  factsStatus,
  attachCommand,
  attachDescription,
  attachError,
  loadingAttach,
  onRevealAttach,
}: {
  session: CockpitSessionView;
  archived?: boolean;
  facts: SelectedSessionFactsResponse | null;
  factsStatus: "loading" | "loaded" | "error";
  attachCommand?: string | null;
  attachDescription?: string | null;
  attachError?: string | null;
  loadingAttach?: boolean;
  onRevealAttach?: () => void;
}) {
  const archivedReason = "Archived sessions are read-only.";
  const offered = new Set(archived ? [] : session.control.capabilities);
  const withheld = new Map(session.control.withheld.map((item) => [item.capability, item.reason]));
  if (archived) {
    for (const capability of ALL_CAPABILITIES) withheld.set(capability, archivedReason);
  }
  const workspace = session.workspaceIdentity;
  const changes = workspaceChangeFacts(workspace);
  const canRevealAttach = offered.has("attach") || offered.has("resume");
  const joinsNative = session.control.coordination.nativeAttach === "join";
  const nativeCommandLabel = session.provider === "codex"
    ? "Show Codex CLI join command"
    : "Show Claude Code join command";
  const account = facts?.account.available ? facts.account : null;
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-5 text-meta">
      <FactSection title="Where it runs"><div className="mt-1"><FactRow label="Host">{session.hostLabel}{session.hostId !== session.hostLabel ? <span className="ml-2 text-[var(--text-muted)]">{session.hostId}</span> : null}</FactRow><FactRow label="Repository">{workspace?.repoName ?? "Unknown"}</FactRow><FactRow label="Worktree">{workspace?.worktreePath ?? session.cwd ?? "Unknown"}</FactRow><FactRow label="Branch">{workspace?.detached ? "Detached HEAD" : workspace?.branch ?? "Unknown"}</FactRow>{workspace?.dirtyCount !== null && workspace?.dirtyCount !== undefined && <FactRow label="Changes">{changes === null ? "Clean" : `${workspaceChangeLabel(changes)} uncommitted`}</FactRow>}<FactRow label="Harness"><span className="font-sans font-medium">{HARNESS_LABEL[session.control.plane]}</span>{session.model && <span className="ml-2 text-[var(--text-muted)]">{session.model}</span>}{session.effort && <span className="ml-2 text-[var(--text-muted)]">{session.effort}</span>}</FactRow><FactRow label="Control">{archived ? "Archived · read-only" : session.control.coordination.mode === "shared" ? "Shared CLI + web" : session.control.coordination.mode === "exclusive" ? "One active writer" : "Observation only"}{session.control.recovery && <span className="ml-2 text-[var(--warning)]">{session.control.recovery.state === "needs-attention" ? "needs attention" : `${session.control.recovery.state.replaceAll("-", " ")} · attempt ${session.control.recovery.attempt}`}</span>}{!archived && session.control.coordination.mode === "shared" && <span className="mt-1 block font-sans text-meta-sm text-[var(--text-muted)]">{session.provider === "codex" ? "Use Codex CLI and web together. The first surface to answer a question or approval wins." : "Use Claude Code and web together. Each surface drives its own turns and answers its own approvals. If both send at once, the conversation forks."}</span>}</FactRow></div></FactSection>
      {/*
        Frame 9b marks each sentence with a glyph rather than a character: a
        lime tick for offered, an amber question for genuinely unknown, and a
        grey cross with greyed text for withheld — the cross carries its reason.
      */}
      <FactSection title="What it may do"><ul className="grid gap-[7px] pt-3">{ALL_CAPABILITIES.map((capability) => {
        const state = offered.has(capability) ? "offered" : withheld.has(capability) ? "withheld" : "unknown";
        const Glyph = state === "offered" ? Check : state === "withheld" ? CircleX : CircleHelp;
        return <li key={capability} className="flex items-center gap-[11px]">
          {/* Frame 9b ticks an offered capability lime. */}
          <Glyph size={14} strokeWidth={1.75} className={`shrink-0 ${state === "offered" ? "text-[var(--accent)]" : state === "withheld" ? "text-[var(--text-muted)]" : "text-[var(--warning)]"}`} aria-label={state === "offered" ? "Available" : state === "withheld" ? "Unavailable" : "Unknown"} />
          <span className={`min-w-0 flex-1 text-[13.5px] leading-[1.5] ${state === "withheld" ? "text-[var(--text-secondary)]" : ""}`}>{capabilitySentence(session, capability)}{withheld.get(capability) && <span className="block text-code-sm text-[var(--text-muted)]">{withheld.get(capability)}</span>}</span>
        </li>;
      })}</ul><div className="mt-3 flex flex-wrap items-center gap-2.5">{/* R4: the profile is merely a fact, so it is the neutral chip. */}<Badge tone="neutral" className="font-sans"><span className="sr-only">Execution profile · </span>{formatProfile(session.profile)}</Badge>{session.provider === "codex" && <Badge tone="neutral" className="font-sans"><span className="sr-only">Sandbox · </span>{formatSandbox(session.sandbox)}</Badge>}{offered.has("set-profile") && <span className="font-mono text-code-sm leading-[1.4] text-[var(--text-muted)]">changeable mid-session</span>}</div></FactSection>
      <FactSection title="What this turn cost"><TurnFacts usage={facts?.turnUsage ?? null} factsStatus={factsStatus} />{account?.usage && <><Separator className="mt-3" /><div className="pt-3"><p className="text-meta-sm"><span className="text-[var(--text-muted)]">Codex account</span>{account.usage.summary.lifetimeTokens !== null && <> · {formatTokens(account.usage.summary.lifetimeTokens)} lifetime tokens</>}{account.usage.summary.peakDailyTokens !== null && <> · {formatTokens(account.usage.summary.peakDailyTokens)} peak day</>}</p>{account.usage.recentDays.length > 0 && <ul className="mt-2 flex flex-wrap gap-2 font-mono text-eyebrow tracking-normal text-[var(--text-muted)]" aria-label="Recent account token usage">{account.usage.recentDays.slice(-7).map((day) => <li key={day.date}>{day.date.slice(5)} · {formatTokens(day.tokens)}</li>)}</ul>}</div></>}{account?.rateLimits && account.rateLimits.length > 0 && <><Separator className="mt-3" /><ul className="grid gap-2 pt-3">{account.rateLimits.map((limit, index) => <li key={`${limit.label ?? "limit"}:${index}`} className="text-meta-sm"><span className="font-medium">{limit.label ?? "Codex limit"}</span>{limit.planType && <span className="ml-2 text-[var(--text-muted)]">{formatPlan(limit.planType)}</span>}{limit.primary && <span className="block font-mono text-code-xs text-[var(--text-muted)]">Primary · {rateWindow(limit.primary)}</span>}{limit.secondary && <span className="block font-mono text-code-xs text-[var(--text-muted)]">Secondary · {rateWindow(limit.secondary)}</span>}{limit.spendControlReached === true && <span className="block text-[var(--warning)]">Account spend control reached</span>}</li>)}</ul></>}{facts?.account.available === false && facts.account.reason === "provider-unavailable" && <p className="mt-3 text-code-sm text-[var(--text-muted)]">Codex account facts are temporarily unavailable.</p>}</FactSection>
      <Collapsible data-advanced-cli-access>
        <CollapsibleTrigger data-compact-control className="group flex min-h-9 w-full cursor-pointer items-center gap-2 border-t border-[var(--border-hairline)] pt-3 text-left font-mono text-code-sm text-[var(--text-muted)]">
          <ChevronRight size={14} className="transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
          Advanced · CLI access
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-1">
          {attachCommand ? <><div className="mt-3 flex items-start gap-2.5 bg-[var(--surface-raised)] px-[13px] py-3"><pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-code leading-[19px] text-[var(--text)]">{attachCommand}</pre><Button variant="ghost" size="icon" data-compact-control className="size-[26px] shrink-0" aria-label={joinsNative ? `Copy ${session.provider === "codex" ? "Codex CLI" : "Claude Code"} join command` : "Copy guarded attach command"} onClick={() => void navigator.clipboard?.writeText(attachCommand)}><Copy size={15} strokeWidth={1.75} /></Button></div>{attachDescription && <p className="mt-2 text-meta-sm text-[var(--text-muted)]">{attachDescription}</p>}<p className="mt-[9px] font-mono text-code-sm leading-[17px] text-[var(--text-muted)]">{joinsNative ? "CLI joins; web control stays active" : "copied, not run — the browser never attaches"}</p></> : canRevealAttach ? <Button variant="secondary" size="touch" className="mt-3 border-[var(--border)] px-3" disabled={loadingAttach} onClick={onRevealAttach}>{loadingAttach ? (joinsNative ? "Preparing join command…" : "Loading guarded wrapper…") : nativeCommandLabel}</Button> : <p className="mt-3 text-meta-sm text-[var(--text-muted)]">{withheld.get("attach") ?? withheld.get("resume") ?? "Agent Manager has no terminal command for this session."}</p>}
          {attachError && <p className="mt-2 text-code-sm text-[var(--warning)]">{attachError}</p>}
        </CollapsibleContent>
      </Collapsible>
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
    // Frame 13c asks for exactly one thing: the folder field is the primary
    // affordance and the discovered repositories sit under it as chips.
    <section className="mx-auto grid max-w-2xl gap-5 p-6 sm:px-10 sm:py-9">
      <div>
        <p className="font-mono text-eyebrow text-[var(--text-faint)] uppercase">First run · 1 of 3</p>
        <h1 className="mt-[15px] text-display">Point it at a folder</h1>
        <p className="mt-2.5 max-w-[480px] text-body-sm text-[var(--text-muted)]">A folder with a git repository in it. Everything else — harness, model, remote hosts — can wait until you need it. Repositories seen through bounded session discovery are remembered locally.</p>
      </div>
      <form className="grid gap-3.5" onSubmit={(event) => void findFolders(event)}>
        <div className="flex items-center gap-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2.5 border border-[var(--border)] bg-[var(--surface-raised-hover)] px-[13px] py-[11px]">
            <FolderGit2 size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--text-muted)]" />
            <Select value={hostId} onValueChange={(next) => { setHostId(next); setPaths([]); setError(null); }}>
              {/* `h-auto` cancels the size preset, so without the touch floor
                  this collapses to its line box — an 18px target on the one
                  screen a first-run operator has to get through. */}
              <SelectTrigger size="sm" data-compact-control="height" aria-label="Browse host" className="h-auto max-w-32 shrink-0 border-0 px-0 font-mono text-code-sm text-[var(--text-muted)] hover:bg-transparent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {hosts.map((host) => <SelectItem key={host.id} value={host.id}>{host.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <input aria-label="Browse folder path" data-compact-control="height" value={path} onChange={(event) => { setPath(event.target.value); setPaths([]); setError(null); }} className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[13.5px] leading-[1.4] outline-none placeholder:text-[var(--text-faint)]" placeholder="~/" autoComplete="off" />
          </div>
          {/* R3: finding the folder is the operator's own action on this screen. */}
          <Button type="submit" variant="primary" size="touch" className="shrink-0 px-5 font-semibold" disabled={loading}>{loading ? "Finding…" : "Find"}</Button>
        </div>
        <p className="text-meta-sm text-[var(--text-muted)]">Only server-confirmed directory suggestions can be chosen.</p>
        {error && <p role="alert" className="text-meta-sm text-[var(--warning)]">{error}</p>}
        {paths.length > 0 && <ul className="grid gap-1" aria-label="Matching folders">{paths.map((match) => <li key={match}><Button variant="secondary" size="touch" className="w-full justify-start truncate border-[var(--border)] px-3 text-left font-mono text-code-xs" title={match} onClick={() => onChooseFolder({ hostId, path: match })}>{match}</Button></li>)}</ul>}
      </form>
      {nearby.length > 0 && <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-code-sm leading-none text-[var(--text-faint)]">found nearby</span>
        {nearby.map((workspace) => <Button key={`${workspace.hostId}:${workspace.path}`} variant="secondary" size="sm" data-compact-control className="max-w-full justify-start gap-[7px] px-[11px] font-mono text-code" title={`${workspace.label} · ${workspace.path}`} onClick={() => onChooseFolder(workspace)}><Plus size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--text-muted)]" /><span className="min-w-0 truncate">{workspace.path}</span>{workspace.source === "discovered" && <span className="shrink-0 text-[var(--accent-quiet)]">seen now</span>}</Button>)}
      </div>}
      {nearby.length === 0 && <p className="flex items-center gap-2 text-meta-sm text-[var(--warning)]"><AlertTriangle size={14} />No nearby repositories were discovered. You can still browse for one.</p>}
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

/** `standalone` drops the first-run wizard framing for the palette surface. */
export function HookSetupStep({ hooks, onApply, onRefresh, onContinue, standalone = false }: {
  hooks: { claude: SetupHookOffer };
  onApply?: (provider: "claude", previewId: string) => Promise<void>;
  onRefresh?: () => void;
  onContinue?: () => void;
  standalone?: boolean;
}) {
  const [applying, setApplying] = useState<"claude" | null>(null);
  const [applyError, setApplyError] = useState<{ provider: "claude"; message: string } | null>(null);

  async function applyHook(hook: SetupHookOffer): Promise<void> {
    if (!hook.previewId || !onApply || applying !== null) return;
    setApplying(hook.provider);
    setApplyError(null);
    try {
      await onApply(hook.provider, hook.previewId);
    } catch (error) {
      setApplyError({
        provider: hook.provider,
        message: error instanceof Error ? error.message : "The hook could not be installed.",
      });
    } finally {
      setApplying(null);
    }
  }

  return (
    <section className={`mx-auto grid max-w-3xl gap-5 ${standalone ? "p-5" : "p-6 sm:p-10"}`}>
      <div><p className="font-mono text-eyebrow text-[var(--text-faint)] uppercase">{standalone ? "Provider hooks" : "Optional setup · 2 of 3"}</p><h1 className={`mt-2 ${standalone ? "text-title" : "text-display-md"}`}>See terminal-started sessions</h1><p className="mt-2 text-body-sm text-[var(--text-muted)]">Hooks add exact live activity and surface held approvals or questions. Review the redacted settings change, then install it directly from Agent Manager. Sending new messages still requires provider control. {standalone ? "Manual installation remains available under Advanced." : "You can skip this optional step."}</p></div>
      <div className="grid gap-3">{([hooks.claude] as const).map((hook) => {
        const pending = applying === hook.provider;
        const installLabel = hook.state === "absent" || hook.state === "provider-disabled" ? "Install" : "Update";
        return <article key={hook.provider} className="min-w-0 border border-[var(--border)] p-4"><div className="flex items-start gap-2"><PlugZap size={15} className="mt-0.5 text-[var(--text-muted)]" /><div className="min-w-0"><h2 className="capitalize text-body-sm font-semibold">{hook.provider}</h2><p className="mt-0.5 text-code-sm text-[var(--text-muted)]">{hookStateLabel(hook)}</p></div></div><p className="mt-3 break-all font-mono text-eyebrow tracking-normal text-[var(--text-muted)]">{hook.settingsPath}</p>{hook.diff && <Collapsible defaultOpen className="mt-3">{/* Radix wires aria-controls and aria-expanded that the bare <details> never had. */}<CollapsibleTrigger data-compact-control className="cursor-pointer text-code-sm font-medium">Exact redacted settings diff</CollapsibleTrigger><CollapsibleContent><pre className="mt-2 max-h-72 overflow-auto bg-[var(--ground)] p-2 font-mono text-code-xs leading-4">{hook.diff}</pre></CollapsibleContent></Collapsible>}{hook.notice && <p className="mt-2 text-code-xs leading-4 text-[var(--text-muted)]">{hook.notice}</p>}{applyError?.provider === hook.provider && <div className="mt-3 flex items-start justify-between gap-3"><p role="alert" className="text-code-sm leading-4 text-[var(--warning)]">{applyError.message}</p>{onRefresh && <Button variant="ghost" size="sm" data-compact-control className="shrink-0" onClick={() => { setApplyError(null); onRefresh(); }}>Refresh preview</Button>}</div>}<div className="mt-4 flex justify-end">{hook.changed ? <Button variant="primary" size="touch" className="gap-1.5 px-4" disabled={!hook.previewId || !onApply || applying !== null} onClick={() => void applyHook(hook)}>{pending && <LoaderCircle size={13} className="motion-safe:animate-spin" aria-hidden="true" />}{pending ? (installLabel === "Install" ? "Installing…" : "Updating…") : `${installLabel} ${hook.provider} hook`}</Button> : <span className="flex items-center gap-1.5 text-code-sm text-[var(--text-muted)]"><Check size={13} />No settings change needed</span>}</div><Collapsible className="mt-3"><CollapsibleTrigger data-compact-control className="group flex w-full cursor-pointer items-center gap-1.5 border-t border-[var(--border-hairline)] pt-3 text-left font-mono text-code-sm text-[var(--text-muted)]"><ChevronRight size={13} className="transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />Advanced · manual installation</CollapsibleTrigger><CollapsibleContent><div className="mt-2 flex items-start gap-2 bg-[var(--surface-raised)] p-2"><pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-code-xs leading-4">{hook.command}</pre><Button variant="ghost" size="icon" data-compact-control className="size-[26px] shrink-0" aria-label={`Copy ${hook.provider} manual installation command`} onClick={() => void navigator.clipboard?.writeText(hook.command)}><Copy size={14} aria-hidden="true" /></Button></div></CollapsibleContent></Collapsible></article>;
      })}</div>
      {onContinue && !standalone && <div className="flex justify-end"><Button variant="ghost" size="touch" onClick={onContinue}>Continue without installing hooks</Button></div>}
    </section>
  );
}

function harnessLabel(host: SetupHostProbe, provider: "codex" | "claude"): string {
  const harness = host.harnesses[provider];
  if (harness.state === "present") return `${provider} present`;
  if (harness.state === "missing") return `${provider} missing`;
  return `${provider} not checked`;
}

export function HostSetupStep({ hosts, onAddHost, onRemoveHost, onContinue, standalone = false }: {
  hosts: readonly SetupHostProbe[];
  onAddHost: (label: string, target: string) => Promise<void>;
  onRemoveHost: (hostId: string) => Promise<void>;
  onContinue?: () => void;
  standalone?: boolean;
}) {
  const remote = hosts.filter((host) => host.kind === "ssh");
  const fieldId = useId();
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [pending, setPending] = useState<"add" | `remove:${string}` | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function addHost(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending !== null) return;
    const normalizedLabel = label.trim();
    const normalizedTarget = target.trim();
    if (!normalizedLabel || !normalizedTarget) {
      setError("Enter both a host label and an SSH target.");
      return;
    }
    setPending("add");
    setError(null);
    try {
      await onAddHost(normalizedLabel, normalizedTarget);
      setLabel("");
      setTarget("");
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "The remote host could not be added.");
    } finally {
      setPending(null);
    }
  }

  async function removeHost(host: SetupHostProbe): Promise<void> {
    if (pending !== null) return;
    setPending(`remove:${host.id}`);
    setError(null);
    try {
      await onRemoveHost(host.id);
      setConfirmingRemove(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : `${host.label} could not be removed.`);
    } finally {
      setPending(null);
    }
  }

  return (
    <section className={`mx-auto grid max-w-2xl gap-5 ${standalone ? "p-5" : "p-6 sm:p-10"}`}>
      <div><p className="font-mono text-eyebrow text-[var(--text-faint)] uppercase">{standalone ? "Connections" : "Optional setup · 3 of 3"}</p><h1 className={`mt-2 ${standalone ? "text-title" : "text-display-md"}`}>{standalone ? "Remote hosts" : "Connect another host"}</h1><p className="mt-2 max-w-xl text-body-sm text-[var(--text-muted)]">Register the same SSH target you use in a terminal. Agent Manager keeps the connection locally and checks each host within a short deadline.</p></div>
      <form className="grid gap-3 border border-[var(--border)] bg-[var(--surface-raised-hover)] p-4" aria-busy={pending === "add"} onSubmit={(event) => void addHost(event)}>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-meta-sm font-medium" htmlFor={`${fieldId}-label`}>Host label<input id={`${fieldId}-label`} value={label} onChange={(event) => { setLabel(event.target.value); setError(null); }} maxLength={120} required disabled={pending !== null} autoComplete="off" placeholder="Build host" className="min-h-10 border border-[var(--border)] bg-[var(--surface-raised)] px-3 text-body-sm font-normal outline-none focus:border-[var(--border-strong)] disabled:opacity-60" /></label>
          <label className="grid gap-1.5 text-meta-sm font-medium" htmlFor={`${fieldId}-target`}>SSH target<input id={`${fieldId}-target`} value={target} onChange={(event) => { setTarget(event.target.value); setError(null); }} maxLength={512} required disabled={pending !== null} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby={`${fieldId}-target-help`} placeholder="dev@build.example" className="min-h-10 border border-[var(--border)] bg-[var(--surface-raised)] px-3 font-mono text-code font-normal outline-none focus:border-[var(--border-strong)] disabled:opacity-60" /></label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3"><p id={`${fieldId}-target-help`} className="text-code-sm text-[var(--text-muted)]">Use a host alias or <span className="font-mono">user@host</span>; SSH configuration stays authoritative.</p><Button type="submit" variant="primary" size="touch" className="gap-1.5 px-4" disabled={pending !== null}>{pending === "add" && <LoaderCircle size={13} className="motion-safe:animate-spin" aria-hidden="true" />}{pending === "add" ? "Adding…" : "Add host"}</Button></div>
      </form>
      {error && <p role="alert" className="border-l-2 border-[var(--warning)] bg-[var(--warning-field)] px-3 py-2 text-code-sm text-[var(--warning)]">{error}</p>}
      {/*
        Frame 13c reports each probe as a line with its own tick or cross, so a
        missing harness reads as a limit on that host rather than a failure.
      */}
      <div className="grid gap-3" aria-busy={pending?.startsWith("remove:") ?? false}>{remote.map((host) => { const removing = pending === `remove:${host.id}`; const confirming = confirmingRemove === host.id; return <article key={host.id} className="flex items-start gap-3.5 border border-[var(--border-hairline)] bg-[var(--surface-raised-hover)] px-[18px] py-4"><Server size={17} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[var(--remote)]" /><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate text-body-sm font-semibold">{host.label}</h2><p className="mt-1 font-mono text-code-sm leading-[1.5] text-[var(--text-muted)]">{host.statusMessage ?? host.status}</p></div>{!confirming && <Button type="button" variant="ghost" size="sm" data-compact-control className="shrink-0 gap-1.5 px-2 [color:var(--text-muted)]" aria-label={`Remove ${host.label}`} disabled={pending !== null} onClick={() => { setConfirmingRemove(host.id); setError(null); }}><Trash2 size={13} aria-hidden="true" />Remove</Button>}</div>{confirming && <div className="mt-3 flex flex-wrap items-center gap-2 border-l-2 border-[var(--warning)] bg-[var(--warning-field)] px-3 py-2" aria-label={`Confirm removal of ${host.label}`}><p className="min-w-[220px] flex-1 text-code-sm text-[var(--text-muted)]">Forget this host and its remembered workspaces?</p><Button type="button" variant="ghost" size="sm" data-compact-control autoFocus disabled={removing} aria-label={`Cancel removal of ${host.label}`} onClick={() => setConfirmingRemove(null)}>Cancel</Button><Button type="button" variant="secondary" size="sm" data-compact-control className="gap-1.5 border-[var(--warning)]" disabled={removing} aria-label={removing ? `Removing ${host.label}` : `Confirm removal of ${host.label}`} onClick={() => void removeHost(host)}>{removing && <LoaderCircle size={13} className="motion-safe:animate-spin" aria-hidden="true" />}{removing ? "Removing…" : "Confirm remove"}</Button></div>}<div className="mt-3 grid gap-[9px]">{(["codex", "claude"] as const).map((provider) => { const available = host.harnesses[provider]; const missing = available.state === "missing"; return <p key={provider} className={`flex items-center gap-2.5 font-mono text-meta-sm leading-[1.5] ${missing ? "text-[var(--text-muted)]" : "text-[var(--text-secondary)]"}`}>{/* Frame 13c ticks a present harness green; spec 12 R4 reserves green for added lines, so the tick stays neutral. */}
                    {/* Frame 13c: a harness that is actually present reads green. */}
                    {missing ? <X size={14} strokeWidth={1.75} className="shrink-0 text-[var(--text-muted)]" aria-hidden="true" /> : <Check size={14} strokeWidth={1.75} className={`shrink-0 ${available.state === "present" ? "text-[var(--added)]" : "text-[var(--text-muted)]"}`} aria-hidden="true" />}<span className="min-w-0">{harnessLabel(host, provider)}{available.reason && <span className="text-[var(--text-muted)]"> — {available.reason}</span>}</span></p>; })}</div></div></article>; })}{remote.length === 0 && <p className="border border-dashed border-[var(--border)] px-4 py-5 text-center text-meta-sm text-[var(--text-muted)]">No remote hosts are configured yet.</p>}</div>
      <p className="text-code-sm leading-5 text-[var(--text-muted)]">Removing a host forgets its remembered workspaces in Agent Manager. It does not delete remote files or stop remote processes.</p>
      {/* R3: leaving setup for the new thread is the operator's own action. */}
      {onContinue && !standalone && <div className="flex justify-end"><Button variant="primary" size="touch" onClick={onContinue}>Continue to new thread</Button></div>}
    </section>
  );
}
