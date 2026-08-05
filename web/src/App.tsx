import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  BellOff,
  Check,
  CodeXml,
  Command,
  Cpu,
  FileDiff,
  GitBranch,
  Laptop,
  ListTodo,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Server,
  Tag,
  TriangleAlert,
  WifiOff,
  X,
} from "lucide-react";
import {
  DesktopBoard,
  PhoneBoardBands,
  ThreadDrawer,
  type BoardColumn,
  type BoardSession,
  toBoardSession,
  useBoardModel,
} from "./components/board";
import {
  canAttemptDraftCreation,
  DraftThread,
  draftIdempotencyKey,
  draftLaunchPath,
  draftReducer,
  newDraftSession,
  type DraftAction,
  type DraftSession,
  type DraftWorkspaceInput,
} from "./components/composer";
import { DiffReview, diffIdentityKey, fileChangeIsUpserting, relativeEditorPath, type FileChangeView } from "./components/diffs";
import {
  CommandPalette,
  SelectionBar,
  ShortcutSheet,
  type PaletteEntry,
  type PaletteSources,
  type SelectionAction,
  type SelectionOutcome,
  sessionPaletteEntries,
  worktreePaletteEntries,
} from "./components/palette";
import {
  EMPTY_NOTIFICATION_STATE,
  ConnectingState,
  EmptyState,
  exactWantsYouSessionCount,
  FirstRun,
  HookSetupStep,
  HostSetupStep,
  OfflineState,
  reduceNotifications,
  type NotificationReducerState,
  type NotificationPreferences,
} from "./components/system";
import { SessionRuntimeProvider, SessionThread, SessionThreadComposer } from "./components/session-thread";
import { currentQueue, preferredFileChangeItems, sessionTodoProgress } from "./components/session-activity";
import { useCockpit } from "./hooks/use-cockpit";
import { usePhoneAttentionLabels } from "./hooks/use-phone-attention-labels";
import { useSessionActivity } from "./hooks/use-session-activity";
import { useTodoDetails } from "./hooks/use-todo-details";
import {
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui";
import { toCockpitSessionView, workspaceChangeFacts, workspaceChangeLabel } from "./lib/cockpit-view";
import type { ProviderSettingsOptionsResponse, SessionSettingsOptionsResponse, SetupReadModel, TranscriptSearchMatch } from "./lib/api";
import type { SessionScope } from "./lib/session-navigation";
import { isTypingTarget } from "./lib/shortcuts";
import { coveringModelOption } from "./lib/model-catalog";
import type { ActivityItem, HostOption, ReasoningEffort, SessionView } from "./types";

const FILTERS = [
  ["all", "All"],
  ["wants-you", "Wants you"],
  ["working", "Working"],
  ["idle", "Idle"],
  ["archived", "Archived"],
] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed.";
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const body = "body" in error ? (error as { body?: unknown }).body : error;
  if (!body || typeof body !== "object") return null;
  const outer = body as Record<string, unknown>;
  const nested = outer.error && typeof outer.error === "object" ? outer.error as Record<string, unknown> : outer;
  return typeof nested.code === "string" ? nested.code : null;
}

/*
  Every chip carries an icon. Six mono strings in a row read as one run of text
  and the operator has to parse each to find the one they wanted; a glyph makes
  each scannable without reading it. The icon states the *kind* of fact — the
  chip's tone still states its meaning (spec 12 R4).
*/
function drawerFacts(session: SessionView, remote: boolean) {
  const changes = workspaceChangeFacts(toCockpitSessionView(session, { remote }).workspaceIdentity);
  return [
    { label: session.provider, icon: CodeXml },
    /*
      The execution profile is deliberately absent. It was badged here, on the
      composer's profile trigger, and a third time as a shield chip beside that
      trigger; full access shouted from three places at once reads as decoration
      rather than warning. It now appears once, orange, on the control that
      changes it, and neutrally in the Session facts panel.
    */
    session.model.value ? { label: session.model.value, icon: Cpu } : null,
    session.workspaceIdentity?.branch ? { label: session.workspaceIdentity.branch, icon: GitBranch } : null,
    changes ? { label: workspaceChangeLabel(changes), icon: FileDiff, tone: "dirty" as const } : null,
    remote ? { label: session.hostLabel, icon: Server, tone: "remote" as const } : null,
    session.archived ? { label: "Archived · read-only", icon: Archive } : null,
  ].filter((fact): fact is NonNullable<typeof fact> => fact !== null);
}

function workspaceForColumn(column: BoardColumn): DraftWorkspaceInput | undefined {
  const group = column.worktrees[0];
  if (!group) return undefined;
  const path = group.identity?.worktreePath ?? (group.key === "unknown" ? null : group.key);
  return path ? { hostId: column.hostId, path } : undefined;
}

export function settingsUnavailableMessage(
  reason: Extract<SessionSettingsOptionsResponse | ProviderSettingsOptionsResponse, { available: false }>["reason"],
): string {
  switch (reason) {
    case "remote-session": return "Model choices are unavailable for remote sessions.";
    case "remote-host": return "Model choices are unavailable when creating a thread on a remote host.";
    case "not-manager-owned": return "Model choices stay in the CLI that owns this session.";
    case "unsupported-provider": return "This provider does not expose a live model catalog.";
    case "provider-unavailable": return "The provider model catalog is temporarily unavailable.";
  }
}

export function effectiveDraftHostId(
  draft: Pick<DraftSession, "workspace"> | null,
  hosts: readonly Pick<HostOption, "id" | "kind">[],
): string | null {
  if (!draft) return null;
  return draft.workspace?.hostId
    ?? hosts.find((host) => host.kind === "local")?.id
    ?? hosts[0]?.id
    ?? "local";
}

/** Effort support is model-specific in each provider's live catalog. */
export function modelCatalogEfforts(
  model: string | null,
  response: SessionSettingsOptionsResponse | ProviderSettingsOptionsResponse | null,
): readonly ReasoningEffort[] | undefined {
  if (!response?.available) return undefined;
  const option = coveringModelOption(model, response.models);
  // A live catalog replaces every provider-wide guess. Missing metadata leaves
  // the meter word-only instead of fabricating support the model never declared;
  // the capability-gated vocabulary fallback lives at the composer wiring.
  return option?.efforts ?? [];
}

/**
 * One quiet refetch per turn boundary. A catalog read can trip its provider
 * bound while the session saturates the CLI streaming a turn; the settled
 * edge is exactly when the provider can answer again. A persistent outage
 * never loops — the next attempt needs another running→settled edge — and
 * structural refusals (remote, foreign, unsupported) are not retried at all.
 */
export function shouldRetrySettingsLookup(
  previousStatus: string | null,
  status: string,
  lookup:
    | { state: "loading" | "error"; response: null }
    | { state: "loaded"; response: SessionSettingsOptionsResponse | ProviderSettingsOptionsResponse }
    | null,
): boolean {
  if (!lookup) return false;
  const failed = lookup.state === "error"
    || (lookup.state === "loaded" && !lookup.response.available && lookup.response.reason === "provider-unavailable");
  return failed && previousStatus === "running" && (status === "idle" || status === "waiting");
}

const NOTIFICATION_SETTINGS_KEY = "agent-manager.notification-preferences.v1";
export interface ClientNotificationPreferences extends NotificationPreferences { browser: boolean }
const DEFAULT_NOTIFICATION_PREFERENCES: ClientNotificationPreferences = {
  blocked: true,
  finished: true,
  stalled: true,
  includeSessionName: false,
  quiet: false,
  browser: true,
};

function loadNotificationPreferences(): ClientNotificationPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(NOTIFICATION_SETTINGS_KEY) ?? "null") as Partial<ClientNotificationPreferences> | null;
    if (!value || typeof value !== "object") return DEFAULT_NOTIFICATION_PREFERENCES;
    return {
      blocked: typeof value.blocked === "boolean" ? value.blocked : DEFAULT_NOTIFICATION_PREFERENCES.blocked,
      finished: typeof value.finished === "boolean" ? value.finished : DEFAULT_NOTIFICATION_PREFERENCES.finished,
      stalled: typeof value.stalled === "boolean" ? value.stalled : DEFAULT_NOTIFICATION_PREFERENCES.stalled,
      includeSessionName: typeof value.includeSessionName === "boolean" ? value.includeSessionName : DEFAULT_NOTIFICATION_PREFERENCES.includeSessionName,
      quiet: typeof value.quiet === "boolean" ? value.quiet : DEFAULT_NOTIFICATION_PREFERENCES.quiet,
      browser: typeof value.browser === "boolean" ? value.browser : DEFAULT_NOTIFICATION_PREFERENCES.browser,
    };
  } catch {
    return DEFAULT_NOTIFICATION_PREFERENCES;
  }
}

export function notificationAwaySince(visibility: DocumentVisibilityState, now: number): number | null {
  return visibility === "hidden" ? now : null;
}

/** A draft has no provider activity, and the runtime still needs a thread. */
const EMPTY_ACTIVITY_ITEMS: readonly ActivityItem[] = [];

/** Under the endpoint's ten-reads-a-minute budget, and bounded to two minutes. */
const SETUP_REPROBE_MS = 8_000;
const SETUP_REPROBE_LIMIT = 15;

export type CockpitContentMode = "board" | "empty" | "first-run";

export function cockpitContentMode(sessionCount: number, workspaceCount: number): CockpitContentMode {
  if (sessionCount > 0) return "board";
  return workspaceCount > 0 ? "empty" : "first-run";
}

export function boardScrollBehavior(prefersReducedMotion: boolean): ScrollBehavior {
  return prefersReducedMotion ? "auto" : "smooth";
}

/*
  Radix hands focus back to a `DialogTrigger`. Both cockpit dialogs are opened
  from the command palette instead, so there is no trigger to hand it back to:
  each remembers the control that was focused when it opened and restores that.
*/
function rememberOpener(openerRef: { current: HTMLElement | null }) {
  return {
    onOpenAutoFocus: () => { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true });
    },
  };
}

export function NotificationSettings({ preferences, onChange, onClose }: { preferences: ClientNotificationPreferences; onChange: (next: ClientNotificationPreferences) => void; onClose: () => void }) {
  const permission = typeof Notification === "undefined" ? "unavailable" : Notification.permission;
  const openerRef = useRef<HTMLElement | null>(null);
  function toggle(key: keyof ClientNotificationPreferences) { onChange({ ...preferences, [key]: !preferences[key] }); }
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent {...rememberOpener(openerRef)} showCloseButton={false} className="max-w-[520px]">
        <header className="flex items-center">
          <DialogTitle className="pr-0">Notifications</DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" data-compact-control className="ml-auto size-10" aria-label="Close notification settings"><X size={16} /></Button>
          </DialogClose>
        </header>
        <div className="flex items-center gap-[11px] bg-[var(--surface-raised-hover)] px-[13px] py-[11px]">
          <BellOff size={15} strokeWidth={1.75} className="shrink-0 text-[var(--text-muted)]" />
          <DialogDescription className="min-w-0 flex-1 text-meta-sm text-[var(--text-secondary)]">Local browser notifications only. There is no push service: alerts arrive only while Agent Manager is open and running. Lock-screen content is generic unless you opt in to session names.</DialogDescription>
        </div>
        {/* Frame 12b states each class as a sentence with its rule underneath and the current delivery on the right. */}
        <div>
          {([
            ["browser", "This browser", "Use the page Notification API", Laptop],
            ["blocked", "A question or approval", "The agent is stopped until you answer", AlertCircle],
            ["finished", "A session finished", "Only after five continuous minutes away", Check],
            ["stalled", "A todo stalled", "An observed todo has not moved for nine minutes", ListTodo],
            ["quiet", "Quiet delivery", "Questions still light the board, they just do not ring", BellOff],
            ["includeSessionName", "Include session name", "Off by default for lock-screen privacy", Tag],
          ] as const).map(([key, label, detail, Icon]) => <label key={key} className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-[var(--rule)] py-[11px]"><Icon size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--text-muted)]" /><Checkbox checked={preferences[key]} onCheckedChange={() => toggle(key)} /><span className="min-w-0 flex-1"><span className="block text-[13.5px] leading-[1.4]">{label}</span><span className="block font-mono text-code-sm text-[var(--text-muted)]">{detail}</span></span><span aria-hidden="true" className={`shrink-0 px-2.5 py-[5px] text-meta-sm leading-none ${preferences[key] ? "bg-[var(--menu)] text-[var(--text)]" : "bg-transparent text-[var(--text-muted)]"}`}>{preferences[key] ? "Always" : "Never"}</span></label>)}
        </div>
        <div className="flex items-center justify-between gap-3"><span className="font-mono text-code-xs text-[var(--text-muted)]">permission: {permission}</span>{permission === "default" && <Button variant="primary" data-compact-control onClick={() => void Notification.requestPermission()}>Allow notifications</Button>}</div>
      </DialogContent>
    </Dialog>
  );
}

export type SetupFactsState =
  | { state: "loading"; value: null; error: null }
  | { state: "loaded"; value: SetupReadModel; error: null }
  | { state: "error"; value: null; error: string }
  | null;

/** The standalone surface for reviewing and installing local integrations. */
export function SetupDialog({ setup, onApplyHook, onAddHost, onRemoveHost, onRetry, onClose }: {
  setup: SetupFactsState;
  onApplyHook?: (provider: "claude" | "codex", previewId: string) => Promise<void>;
  onAddHost: (label: string, target: string) => Promise<void>;
  onRemoveHost: (hostId: string) => Promise<void>;
  onRetry: () => void;
  onClose: () => void;
}) {
  const openerRef = useRef<HTMLElement | null>(null);
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent {...rememberOpener(openerRef)} showCloseButton={false} data-setup-dialog className="flex max-h-[min(760px,calc(100dvh-88px))] max-w-[880px] flex-col gap-0 p-0">
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--rule)] px-5 py-3">
          <div className="min-w-0">
            <DialogTitle className="pr-0">Setup and integrations</DialogTitle>
            <DialogDescription className="mt-0.5 text-meta-sm text-[var(--text-muted)]">Install optional provider integrations and manage remote hosts without leaving the web app.</DialogDescription>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" data-compact-control className="ml-auto size-10 shrink-0" aria-label="Close setup and integrations"><X size={16} /></Button>
          </DialogClose>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {setup?.state === "loaded"
            ? <><HookSetupStep hooks={setup.value.hooks} {...(onApplyHook ? { onApply: onApplyHook } : {})} onRefresh={onRetry} standalone /><HostSetupStep hosts={setup.value.hosts} onAddHost={onAddHost} onRemoveHost={onRemoveHost} standalone /></>
            : setup?.state === "error"
              ? <section className="grid place-items-center p-10 text-center"><AlertCircle className="text-[var(--warning)]" /><h3 className="mt-3 text-title-sm">Setup facts are unavailable</h3><p className="mt-1 text-meta-sm text-[var(--text-muted)]">{setup.error}</p><Button variant="primary" size="touch" className="mt-4" onClick={onRetry}>Try again</Button></section>
              : <ConnectingState sources={["provider hook settings", "configured remote hosts"]} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CockpitToast({
  actionError,
  notice,
  canTakeOver,
  onTakeOver,
  onDismiss,
}: {
  actionError: string | null;
  notice: string | null;
  canTakeOver: boolean;
  onTakeOver: () => void;
  onDismiss: () => void;
}) {
  const message = actionError ?? notice;
  if (!message) return null;
  return (
    <aside className="fixed bottom-4 right-4 z-[80] flex max-w-[min(440px,calc(100%-32px))] items-start gap-2 border border-[var(--border-frame)] bg-[var(--menu)] p-3 text-meta-sm shadow-[var(--shadow-toast)]">
      <span className="min-w-0 flex-1">{message}</span>
      {actionError && canTakeOver && <Button variant="ghost" size="sm" data-compact-control className="px-2 [color:var(--accent)]" onClick={onTakeOver}>Use here</Button>}
      <Button variant="ghost" size="icon" data-compact-control className="size-6" aria-label="Dismiss" onClick={onDismiss}><X size={14} /></Button>
    </aside>
  );
}

function LoadingScreen() {
  return <main className="grid min-h-dvh place-content-center bg-[var(--app)]"><ConnectingState sources={["tmux panes", "Codex thread registry", "Claude agents", "bounded provider transcripts"]} /></main>;
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="grid min-h-dvh place-content-center px-5 text-center">
      <AlertCircle className="mx-auto text-[var(--danger)]" /><h1 className="mt-3 text-title-md">Agent Manager could not open</h1><p className="mt-1 max-w-md text-meta text-[var(--text-muted)]">{message}</p>
      <Button variant="primary" size="touch" className="mx-auto mt-4" onClick={onRetry}><RefreshCw size={14} />Try again</Button>
    </main>
  );
}

export function hostSelectionSummary(hostIds: readonly string[], hostFilter: ReadonlySet<string>): string {
  const knownHostIds = new Set(hostIds);
  const selectedHostCount = hostFilter.size === 0
    ? hostIds.length
    : [...hostFilter].filter((hostId) => knownHostIds.has(hostId)).length;
  if (hostIds.length === 0) return "No hosts available";
  if (selectedHostCount === hostIds.length) return "All hosts selected";
  if (selectedHostCount === 0) return "No hosts selected";
  return `${selectedHostCount} of ${hostIds.length} hosts selected`;
}

export function Header({
  counts,
  scope,
  hosts,
  hostFilter,
  connection,
  diagnostics,
  onScope,
  onToggleHost,
  onPalette,
  onHelp,
  onNew,
}: {
  counts: Record<"all" | "wants-you" | "working" | "failed" | "idle" | "archived", number>;
  scope: "all" | "wants-you" | "working" | "idle" | "archived";
  hosts: readonly { id: string; label: string; kind: "local" | "ssh"; status: string; count: number }[];
  hostFilter: ReadonlySet<string>;
  connection: string;
  diagnostics: number;
  onScope: (scope: "all" | "wants-you" | "working" | "idle" | "archived") => void;
  onToggleHost: (hostId: string) => void;
  onPalette: () => void;
  onHelp: () => void;
  onNew: () => void;
}) {
  const hostSelectionLabel = hostSelectionSummary(hosts.map((host) => host.id), hostFilter);
  const connectionLabel = `${connection}${diagnostics ? ` · ${diagnostics} diagnostics` : ""}`;
  return (
    <header className="safe-area-top z-30 shrink-0 bg-[var(--app)]">
      <div className="safe-area-inline">
        <div className="flex h-[46px] items-center gap-3 px-4 min-[901px]:gap-3.5 min-[901px]:px-6" data-header-primary>
          {/* Frame 7a: a live connection is lime. */}
          <span className={`size-[9px] shrink-0 rounded-full ${connection === "open" ? "bg-[var(--accent)]" : "bg-[var(--warning)]"}`} data-connection-indicator={connection} aria-hidden="true" title={connectionLabel} />
          <h1 className="truncate font-mono text-[11px] font-medium uppercase leading-none tracking-[0.14em] text-[var(--text-muted)]">Agent Manager</h1>
          <span className="sr-only" role="status">Connection {connectionLabel}</span>
          <span className="flex-1" />
          <Button variant="secondary" size="sm" data-compact-control className="h-7 gap-2 px-[11px] font-mono text-code-sm leading-none [color:var(--text-muted)]" aria-label="Search sessions and commands" onClick={onPalette}><Search size={13} aria-hidden="true" /><span className="hidden min-[520px]:inline">Search</span><kbd className="hidden text-[var(--text-faint)] min-[901px]:inline">⌘K</kbd></Button>
          <Button variant="secondary" size="icon" data-compact-control className="size-7 font-mono text-meta-sm leading-none [color:var(--text-muted)]" aria-label="Open help and keyboard shortcuts" onClick={onHelp}>?</Button>
          <Button variant="primary" size="sm" data-compact-control className="h-8 gap-2 px-2.5 text-meta font-semibold leading-none min-[520px]:px-3.5" aria-label="New thread" onClick={onNew}><Plus size={15} aria-hidden="true" /><span className="hidden min-[520px]:inline">New thread</span></Button>
        </div>
        <div className="flex min-w-0 items-center gap-5 overflow-x-auto px-4 pb-3 pt-0.5 min-[901px]:gap-[22px] min-[901px]:px-6 min-[901px]:pb-[18px]" data-header-filters>
          <nav className="flex shrink-0 items-baseline gap-[17px]" aria-label="Session filters">
            {FILTERS.map(([value, label]) => {
              const active = scope === value;
              const wantsYou = value === "wants-you";
              // Wants you stays lime whether or not it is the active scope
              // (spec 05 R1); frame 7a quietens the inactive lime rather than
              // dropping it to grey.
              return <button key={value} type="button" data-compact-control="height" aria-current={active ? "page" : undefined} aria-label={`${label}, ${counts[value]} ${counts[value] === 1 ? "session" : "sessions"}`} className={`shrink-0 border-0 bg-transparent p-0 text-[13.5px] leading-none ${active ? "font-semibold" : "font-normal"} ${wantsYou ? (active ? "text-[var(--accent)]" : "text-[var(--accent-quiet)]") : active ? "text-[var(--text)]" : "text-[var(--text-muted)]"}`} onClick={() => onScope(value)}><span>{label}</span><span className={`ml-[5px] font-mono text-[11.5px] font-normal ${wantsYou ? "text-[var(--accent)]" : "text-[var(--text-faint)]"}`}>{counts[value]}</span></button>;
            })}
          </nav>
          <span className="h-4 w-px shrink-0 bg-[var(--border-hairline)]" aria-hidden="true" />
          <nav className="flex shrink-0 items-center gap-4 font-mono text-[12px] leading-none" aria-label={`Host filters: ${hostSelectionLabel}`}>
            {hosts.map((host) => {
              const selected = hostFilter.size === 0 || hostFilter.has(host.id);
              const tone = selected
                ? host.kind === "ssh" ? "text-[var(--remote)]" : "text-[var(--text)]"
                : host.kind === "ssh" ? "text-[var(--remote-dim)] opacity-50" : "text-[var(--text-faint)] opacity-50";
              const HostIcon = host.kind === "ssh" ? Server : Laptop;
              return <button key={host.id} type="button" data-compact-control="height" aria-pressed={selected} aria-label={`${host.label}, ${host.count} ${host.count === 1 ? "session" : "sessions"}`} title={`${host.label} · ${host.status}`} className={`flex shrink-0 items-center gap-1.5 border-0 bg-transparent p-0 ${tone}`} onClick={() => onToggleHost(host.id)}><HostIcon size={13} strokeWidth={1.75} aria-hidden="true" /><span>{host.label}</span><span className={host.kind === "ssh" ? "text-[var(--remote-dim)]" : "text-[var(--text-faint)]"}>{host.count}</span></button>;
            })}
            {hosts.length === 0 && <span className="text-[var(--text-muted)]">No hosts</span>}
          </nav>
          <span className="flex-1" />
          <span className="hidden shrink-0 font-mono text-[11.5px] leading-none text-[var(--text-muted)] min-[1180px]:inline">click a card · shift-click to select · ? for keys</span>
        </div>
      </div>
    </header>
  );
}

function ArchivedCatalogBar({
  query,
  shown,
  total,
  status,
  error,
  hasMore,
  onSearch,
  onLoadMore,
}: {
  query: string;
  shown: number;
  total: number;
  status: "idle" | "loading" | "loaded" | "error";
  error: string | null;
  hasMore: boolean;
  onSearch: (query: string) => Promise<void>;
  onLoadMore: () => Promise<void>;
}) {
  const [value, setValue] = useState(query);
  useEffect(() => setValue(query), [query]);
  const loading = status === "loading";
  return (
    <section className="shrink-0 border-b border-[var(--rule)] bg-[var(--app)] px-4 py-3 min-[901px]:px-6" aria-label="Archived session catalog">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void onSearch(value); }}>
        <label className="sr-only" htmlFor="archived-session-search">Search archived sessions</label>
        <input id="archived-session-search" type="search" value={value} onChange={(event) => setValue(event.target.value)} maxLength={200} placeholder="Search title, provider ID, or workspace" className="min-h-9 min-w-0 flex-1 border border-[var(--border)] bg-[var(--surface-raised)] px-3 text-body-sm outline-none focus:border-[var(--border-strong)]" />
        <Button variant="secondary" size="sm" disabled={loading} type="submit"><Search size={13} />{loading && shown === 0 ? "Searching…" : "Search"}</Button>
        <span className="font-mono text-code-xs text-[var(--text-muted)]">{shown} of {total}</span>
        {hasMore && <Button variant="ghost" size="sm" disabled={loading} type="button" onClick={() => void onLoadMore()}>{loading ? "Loading…" : "Load more"}</Button>}
      </form>
      {error && <p className="mt-2 text-code-sm text-[var(--warning)]" role="status">{error}</p>}
    </section>
  );
}

function ArchivedCatalogEmpty({ status, error, query, onRetry }: {
  status: "idle" | "loading" | "loaded" | "error";
  error: string | null;
  query: string;
  onRetry: () => void;
}) {
  if (status === "error") {
    return (
      <section className="grid min-h-0 flex-1 place-content-center p-6 text-center" role="status">
        <AlertCircle className="mx-auto text-[var(--warning)]" />
        <h2 className="mt-3 text-title-sm">Archived sessions unavailable</h2>
        <p className="mt-1 max-w-md text-meta-sm text-[var(--text-muted)]">{error ?? "Agent Manager could not load the archived-session catalog."}</p>
        <Button variant="secondary" size="sm" className="mx-auto mt-3 gap-1.5" onClick={onRetry}><RefreshCw size={13} aria-hidden="true" />Try again</Button>
      </section>
    );
  }
  if (status === "loading" || status === "idle") {
    return <section className="grid min-h-0 flex-1 place-content-center p-6 text-center" role="status"><LoaderCircle className="mx-auto motion-safe:animate-spin text-[var(--text-muted)]" /><h2 className="mt-3 text-title-sm">Loading archived sessions</h2><p className="mt-1 text-meta-sm text-[var(--text-muted)]">Reading the searchable archive catalog.</p></section>;
  }
  const searching = query.trim().length > 0;
  return <section className="grid min-h-0 flex-1 place-content-center p-6 text-center"><Archive className="mx-auto text-[var(--text-muted)]" /><h2 className="mt-3 text-title-sm">{searching ? "No archived sessions match" : "No archived sessions yet"}</h2><p className="mt-1 text-meta-sm text-[var(--text-muted)]">{searching ? "Search by title, provider ID, or workspace." : "Archived Codex sessions will remain searchable and read-only here."}</p></section>;
}

export default function App() {
  const cockpit = useCockpit();
  const [activityRetryGeneration, setActivityRetryGeneration] = useState(0);
  const activity = useSessionActivity(cockpit.selectedId, activityRetryGeneration);
  const [draft, setDraft] = useState<DraftSession | null>(() => new URLSearchParams(window.location.search).get("draft") === "1" ? newDraftSession() : null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [transcriptMatches, setTranscriptMatches] = useState<readonly TranscriptSearchMatch[]>([]);
  const [settingsOptions, setSettingsOptions] = useState<
    | { sessionId: string; state: "loading"; response: null }
    | { sessionId: string; state: "error"; response: null }
    | { sessionId: string; state: "loaded"; response: SessionSettingsOptionsResponse | ProviderSettingsOptionsResponse }
    | null
  >(null);
  const [draftSettingsOptions, setDraftSettingsOptions] = useState<{
    provider: DraftSession["provider"];
    hostId: string;
    state: "loading" | "loaded" | "error";
    response: ProviderSettingsOptionsResponse | null;
  } | null>(null);
  const draftSettingsRequest = useRef(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);
  const [notificationPreferences, setNotificationPreferences] = useState<ClientNotificationPreferences>(loadNotificationPreferences);
  const [firstRunStep, setFirstRunStep] = useState<"folder" | "hooks" | "ssh">("folder");
  const [pendingFirstWorkspace, setPendingFirstWorkspace] = useState<DraftWorkspaceInput | null>(null);
  const [setupFacts, setSetupFacts] = useState<SetupFactsState>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const setupLoadStarted = useRef(false);
  const setupRequest = useRef(0);
  const setupProbes = useRef(0);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [readKeys, setReadKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [restoredDraft, setRestoredDraft] = useState<{ sessionId: string; key: string; text: string } | null>(null);
  const [privacyCovered, setPrivacyCovered] = useState(document.visibilityState === "hidden");
  const notificationState = useRef<NotificationReducerState>(EMPTY_NOTIFICATION_STATE);
  const awaySince = useRef<number | null>(notificationAwaySince(document.visibilityState, Date.now()));
  const [notificationWake, setNotificationWake] = useState(0);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("draft")) return;
    url.searchParams.delete("draft");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(NOTIFICATION_SETTINGS_KEY, JSON.stringify(notificationPreferences)); } catch { /* ephemeral preference fallback */ }
  }, [notificationPreferences]);

  const refreshSetup = useCallback(() => {
    const request = ++setupRequest.current;
    setupLoadStarted.current = true;
    setSetupFacts({ state: "loading", value: null, error: null });
    void cockpit.loadSetup().then((value) => {
      if (setupRequest.current === request) setSetupFacts({ state: "loaded", value, error: null });
    }).catch((error: unknown) => {
      if (setupRequest.current === request) setSetupFacts({ state: "error", value: null, error: errorText(error) });
    });
  }, [cockpit.loadSetup]);
  const applySetupHook = useCallback(async (provider: "claude" | "codex", previewId: string): Promise<void> => {
    await cockpit.applySetupHook(provider, previewId);
    setupProbes.current = 0;
    refreshSetup();
  }, [cockpit.applySetupHook, refreshSetup]);
  const addSetupHost = useCallback(async (label: string, target: string): Promise<void> => {
    await cockpit.addHost(label, target);
    setupProbes.current = 0;
    refreshSetup();
  }, [cockpit.addHost, refreshSetup]);
  const removeSetupHost = useCallback(async (hostId: string): Promise<void> => {
    const closeRemoteDrawer = cockpit.selectedSession?.hostId === hostId;
    const resetFirstWorkspace = pendingFirstWorkspace?.hostId === hostId;
    await cockpit.removeHost(hostId);
    if (closeRemoteDrawer) {
      setReviewOpen(false);
      await cockpit.closeSelected();
    }
    setDraft((current) => current?.workspace?.hostId === hostId ? null : current);
    if (resetFirstWorkspace) {
      setPendingFirstWorkspace(null);
      setFirstRunStep("folder");
    }
    setupProbes.current = 0;
    refreshSetup();
  }, [cockpit.closeSelected, cockpit.removeHost, cockpit.selectedSession?.hostId, pendingFirstWorkspace?.hostId, refreshSetup]);
  // Hook and host facts change outside this browser, so every explicit open
  // re-reads them instead of trusting a first-run snapshot.
  const openSetup = useCallback(() => { setupProbes.current = 0; setSetupOpen(true); refreshSetup(); }, [refreshSetup]);

  useEffect(() => {
    if (!cockpit.ready || !cockpit.mutationsReady || cockpitContentMode(cockpit.sessions.length, cockpit.workspaces.length) !== "first-run" || setupLoadStarted.current) return;
    refreshSetup();
  }, [cockpit.mutationsReady, cockpit.ready, cockpit.sessions.length, cockpit.workspaces.length, refreshSetup]);


  /*
    A hook settings edit emits no provider event, including when another browser
    or process makes it. While the dialog is open on an unfinished hook, re-read
    the facts so the state moves without a restart. A successful in-app install
    also refreshes immediately above.
  */
  useEffect(() => {
    if (!setupOpen || setupFacts?.state !== "loaded") return;
    const unfinished = ([setupFacts.value.hooks.claude, setupFacts.value.hooks.codex] as const)
      .some((hook) => hook.state !== "active");
    if (!unfinished || setupProbes.current >= SETUP_REPROBE_LIMIT) return;
    const timer = setTimeout(() => { setupProbes.current += 1; refreshSetup(); }, SETUP_REPROBE_MS);
    return () => clearTimeout(timer);
  }, [refreshSetup, setupFacts, setupOpen]);

  const phoneAttentionLabels = usePhoneAttentionLabels(
    cockpit.sessions,
    cockpit.mutationsReady,
    cockpit.loadAttentionDetails,
  );
  const todoDetails = useTodoDetails(
    cockpit.sessions,
    cockpit.mutationsReady,
    cockpit.loadTodoDetail,
  );
  const selectedActivityTodo = useMemo(() => sessionTodoProgress(activity), [activity]);

  const dispatchDraft = useCallback((action: DraftAction) => setDraft((current) => current ? draftReducer(current, action) : current), []);
  const remoteHostIds = useMemo(() => new Set(cockpit.hosts.filter((host) => host.kind === "ssh").map((host) => host.id)), [cockpit.hosts]);
  const draftProvider = draft?.provider ?? null;
  const draftHostId = effectiveDraftHostId(draft, cockpit.hosts);
  const headerHosts = useMemo(() => cockpit.hosts.map((host) => ({
    ...host,
    count: cockpit.sessions.filter((session) => session.hostId === host.id).length,
  })), [cockpit.hosts, cockpit.sessions]);
  const sessions = useMemo(() => cockpit.displaySessions.map((session) => {
    const projected = toCockpitSessionView(session, {
      remote: remoteHostIds.has(session.hostId),
      ...(todoDetails.has(session.id) ? { todo: todoDetails.get(session.id)! } : {}),
      ...(phoneAttentionLabels.has(session.id) ? { attentionLabels: phoneAttentionLabels.get(session.id)! } : {}),
    });
    // The selected activity stream is the freshest exact content edge. A
    // provider may rewrite todo text without changing counts/statuses, which
    // intentionally does not churn the metadata-only global generation.
    return session.id === activity.sessionId && selectedActivityTodo
      ? { ...projected, todo: selectedActivityTodo }
      : projected;
  }), [activity.sessionId, cockpit.displaySessions, phoneAttentionLabels, remoteHostIds, selectedActivityTodo, todoDetails]);
  const board = useBoardModel(sessions, {
    scope: cockpit.scope === "archived" ? "all" : cockpit.scope,
    hostIds: cockpit.hostFilter,
  });

  const selected = cockpit.selectedSession;

  const selectedPresentation = selected ? sessions.find((session) => session.id === selected.id) ?? null : null;
  const selectedPlanSessionId = selected?.id ?? null;
  const loadSelectedPlanFile = useCallback((itemId: string) => {
    if (!selectedPlanSessionId) return Promise.reject(new Error("No session is selected."));
    return cockpit.loadPlanFile(selectedPlanSessionId, itemId);
  }, [cockpit.loadPlanFile, selectedPlanSessionId]);
  const selectedRemote = selected ? remoteHostIds.has(selected.hostId) : false;
  const selectedSessionsOnHost = selected && cockpit.connection === "open" && !cockpit.snapshot.stale
    ? cockpit.sessions.filter((session) => session.id !== selected.id
      && session.hostId === selected.hostId
      && (session.status === "running" || session.status === "waiting")).length
    : null;
  const selectedBusy = selected ? Boolean(cockpit.busy[`action:${selected.id}`] || cockpit.busy[`writer:${selected.id}`]) : false;
  useEffect(() => {
    const request = ++draftSettingsRequest.current;
    if (draftProvider === null || draftHostId === null) {
      setDraftSettingsOptions(null);
      return;
    }
    setDraftSettingsOptions({ provider: draftProvider, hostId: draftHostId, state: "loading", response: null });
    void cockpit.loadProviderSettingsOptions(draftProvider, draftHostId).then((response) => {
      if (draftSettingsRequest.current === request) {
        setDraftSettingsOptions({ provider: draftProvider, hostId: draftHostId, state: "loaded", response });
      }
    }).catch(() => {
      if (draftSettingsRequest.current === request) {
        setDraftSettingsOptions({ provider: draftProvider, hostId: draftHostId, state: "error", response: null });
      }
    });
    return () => {
      if (draftSettingsRequest.current === request) draftSettingsRequest.current += 1;
    };
  }, [cockpit.loadProviderSettingsOptions, draftHostId, draftProvider]);

  /*
    Reading a catalog is not writing to it, so nothing here waits on
    `set-model`. Gating the read on the write left the model control dead for
    exactly the sessions worth inspecting — a Codex thread for the whole of
    every turn — greyed out with the reason unfetched and therefore unsayable.
    A manager-owned session reads its own catalog; a local session someone
    else owns falls back to the provider's, which is the same list without a
    claim about that thread. Either way the menu opens, and whether the answer
    may be applied is the harness's own withheld reason to state.
  */
  useEffect(() => {
    if (!selected) {
      setSettingsOptions(null);
      return;
    }
    const sessionId = selected.id;
    let cancelled = false;
    setSettingsOptions({ sessionId, state: "loading", response: null });
    const lookup = selected.control.authority === "manager"
      ? cockpit.loadSettingsOptions(sessionId)
      : selected.hostId === "local"
        ? cockpit.loadProviderSettingsOptions(selected.provider, selected.hostId)
        : null;
    if (lookup === null) {
      setSettingsOptions(null);
      return;
    }
    void lookup.then((response) => {
      if (!cancelled) setSettingsOptions({ sessionId, state: "loaded", response });
    }).catch(() => {
      if (!cancelled) setSettingsOptions({ sessionId, state: "error", response: null });
    });
    return () => { cancelled = true; };
  }, [
    cockpit.loadProviderSettingsOptions,
    cockpit.loadSettingsOptions,
    selected?.control.authority,
    selected?.control.recovery?.state,
    selected?.hostId,
    selected?.id,
    selected?.provider,
  ]);

  /*
    The lookup above runs once per selection, so a transient failure would
    otherwise stand for the whole selection. `settingsOptions` rides a ref
    here because the effect writes it: listing it as a dependency would
    cancel the very request the retry starts.
  */
  const settingsLookupRef = useRef(settingsOptions);
  useEffect(() => {
    settingsLookupRef.current = settingsOptions;
  }, [settingsOptions]);
  const settingsStatusEdge = useRef<{ sessionId: string; status: string } | null>(null);
  useEffect(() => {
    const previous = settingsStatusEdge.current;
    settingsStatusEdge.current = selected ? { sessionId: selected.id, status: selected.status } : null;
    if (!selected || selected.control.authority !== "manager") return;
    const sessionId = selected.id;
    const previousStatus = previous?.sessionId === sessionId ? previous.status : null;
    const lookup = settingsLookupRef.current?.sessionId === sessionId ? settingsLookupRef.current : null;
    if (!shouldRetrySettingsLookup(previousStatus, selected.status, lookup)) return;
    let cancelled = false;
    setSettingsOptions({ sessionId, state: "loading", response: null });
    void cockpit.loadSettingsOptions(sessionId).then((response) => {
      if (!cancelled) setSettingsOptions({ sessionId, state: "loaded", response });
    }).catch(() => {
      if (!cancelled) setSettingsOptions({ sessionId, state: "error", response: null });
    });
    return () => { cancelled = true; };
  }, [cockpit.loadSettingsOptions, selected?.control.authority, selected?.id, selected?.status]);

  const selectedModelCatalog = useMemo(() => {
    if (!settingsOptions || settingsOptions.sessionId !== selected?.id) return { models: [], status: null, effortOptions: undefined };
    if (settingsOptions.state === "loading") return { models: [], status: "Loading the provider model catalog…", effortOptions: undefined };
    if (settingsOptions.state === "error") return { models: [], status: "The provider model catalog could not be loaded.", effortOptions: undefined };
    const response = settingsOptions.response;
    // A settled lookup that produced nothing is a failed lookup, not a licence
    // to read `available` off `undefined`. The draft catalog below has always
    // guarded this; this one only ever ran behind a capability check that made
    // the case unreachable.
    if (!response) return { models: [], status: "The provider model catalog could not be loaded.", effortOptions: undefined };
    return response.available
      ? { models: response.models, status: null, effortOptions: modelCatalogEfforts(selected.model.value, response) }
      : { models: [], status: settingsUnavailableMessage(response.reason), effortOptions: undefined };
  }, [selected?.id, selected?.model.value, selected?.provider, settingsOptions]);
  const draftModelCatalog = useMemo(() => {
    if (draftProvider === null) return { models: [], status: null, effortOptions: undefined };
    if (draftHostId === null) {
      return { models: [], status: "Choose a host to load its provider model catalog.", effortOptions: undefined };
    }
    if (!draftSettingsOptions
      || draftSettingsOptions.provider !== draftProvider
      || draftSettingsOptions.hostId !== draftHostId) {
      return { models: [], status: "Loading the provider model catalog…", effortOptions: undefined };
    }
    if (draftSettingsOptions.state === "loading") return { models: [], status: "Loading the provider model catalog…", effortOptions: undefined };
    if (draftSettingsOptions.state === "error") return { models: [], status: "The provider model catalog could not be loaded.", effortOptions: undefined };
    const response = draftSettingsOptions.response;
    if (!response) return { models: [], status: "The provider model catalog could not be loaded.", effortOptions: undefined };
    return response.available
      ? { models: response.models, status: null, effortOptions: modelCatalogEfforts(draft?.model ?? null, response) }
      : { models: [], status: settingsUnavailableMessage(response.reason), effortOptions: undefined };
  }, [draft?.model, draftHostId, draftProvider, draftSettingsOptions]);

  useEffect(() => {
    const query = paletteQuery.trimStart();
    const literal = query.startsWith("#") ? query.slice(1).trim() : "";
    if (!paletteOpen || !selected || literal.length < 2) {
      setTranscriptMatches([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void cockpit.searchTranscript(selected.id, literal, 20).then((result) => {
        if (!cancelled) setTranscriptMatches(result.matches);
      }).catch(() => {
        if (!cancelled) setTranscriptMatches([]);
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [cockpit.searchTranscript, paletteOpen, paletteQuery, selected]);

  const changedFiles = useMemo<FileChangeView[]>(() => {
    if (!selected) return [];
    const fileItems = preferredFileChangeItems(activity.items);
    const turnId = selected.providerTurnId ?? [...fileItems].reverse().find((item) => item.turnId)?.turnId ?? null;
    return fileItems.filter((item) => turnId === null || item.turnId === turnId).flatMap((item) => item.kind === "file-change" ? item.changes.map((change) => ({
      path: change.path,
      previousPath: change.previousPath,
      operation: change.operation,
      diff: change.diff,
      truncated: item.truncated,
      readKey: diffIdentityKey(selected.id, item.turnId ?? "unassociated", change.path, change.operation, change.diff),
      upserting: fileChangeIsUpserting(item, activity.items),
    })) : []);
  }, [activity.items, selected]);

  const openSession = useCallback((session: BoardSession) => {
    setDraft(null);
    cockpit.setSelectedId(session.id);
  }, [cockpit]);
  const openDraft = useCallback((workspace?: DraftWorkspaceInput) => {
    void cockpit.closeSelected();
    setDraft(newDraftSession(workspace ? { workspace } : {}));
  }, [cockpit]);
  const closeDrawer = useCallback(() => {
    setDraft(null);
    setReviewOpen(false);
    void cockpit.closeSelected();
  }, [cockpit]);
  const changeScope = useCallback((next: SessionScope) => {
    const crossesArchiveBoundary = (cockpit.scope === "archived") !== (next === "archived");
    if (crossesArchiveBoundary) {
      // Archived and active drawers are different trust surfaces. Clear the
      // old selection synchronously (and release its browser lease) before the
      // new board can render, so a writable drawer never overlays Archives.
      setDraft(null);
      setReviewOpen(false);
      setSelectedIds(new Set());
      void cockpit.closeSelected();
    }
    cockpit.setScope(next);
  }, [cockpit]);

  const firstSend = useCallback(async () => {
    if (!draft || !canAttemptDraftCreation(draft) || !draft.workspace) return;
    const current = draft;
    let workspace = draft.workspace;
    dispatchDraft({ type: "creating" });
    try {
      if (workspace.worktree.kind === "new") {
        // Creating the worktree is its own step: one that succeeds before a
        // failed session create leaves a worktree the retry reuses.
        const created = await cockpit.createWorktree({
          hostId: workspace.hostId,
          repoRoot: workspace.worktree.repoRoot,
          name: workspace.worktree.name,
        });
        const worktree = { kind: "existing" as const, path: created.path, branch: workspace.worktree.name };
        dispatchDraft({ type: "worktree-created", path: created.path, branch: workspace.worktree.name });
        workspace = { ...workspace, worktree };
      }
      await cockpit.createSession({
        hostId: workspace.hostId,
        workspacePath: draftLaunchPath(workspace),
        provider: current.provider,
        initialMessage: current.text.trim(),
        profile: current.profile,
        // The sandbox is a Codex containment setting; Claude has none to send.
        sandbox: current.provider === "codex" ? current.sandbox : null,
        model: current.model,
        effort: current.effort,
        idempotencyKey: draftIdempotencyKey(current),
      });
      setDraft(null);
    } catch (error) {
      dispatchDraft({ type: "create-failed", message: errorText(error), outcomeUnknown: errorCode(error) === "CREATE_OUTCOME_UNKNOWN" });
    }
  }, [cockpit, dispatchDraft, draft]);

  useEffect(() => {
    setSelectedIds((current) => new Set([...current].filter((id) => cockpit.sessions.some((session) => session.id === id))));
  }, [cockpit.sessions]);

  useEffect(() => {
    function visibility() {
      const hidden = document.visibilityState === "hidden";
      setPrivacyCovered(hidden);
      awaySince.current = notificationAwaySince(document.visibilityState, Date.now());
      setNotificationWake((value) => value + 1);
    }
    function pagehide() {
      setPrivacyCovered(true);
      awaySince.current = Date.now();
      setNotificationWake((value) => value + 1);
    }
    function meaningfulPresence() {
      if (document.visibilityState === "hidden") return;
      awaySince.current = null;
      setNotificationWake((value) => value + 1);
    }
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pointerdown", meaningfulPresence, { passive: true });
    window.addEventListener("keydown", meaningfulPresence);
    window.addEventListener("focus", meaningfulPresence);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("pageshow", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pointerdown", meaningfulPresence);
      window.removeEventListener("keydown", meaningfulPresence);
      window.removeEventListener("focus", meaningfulPresence);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("pageshow", visibility);
    };
  }, []);

  const notificationSessions = useMemo(() => cockpit.sessions.map((session) => ({
    id: session.id,
    name: session.name ?? session.providerThreadId,
    status: session.status,
    updatedAt: session.updatedAt,
    requestIds: session.attention.flatMap((request) => request.id
      && request.confidence === "exact"
      && request.details?.respondable
      && (request.source === "provider-api" || request.source === "hook")
      ? [request.id]
      : []),
    todo: session.todoProgress ? {
      active: session.todoProgress.active,
      hasMoved: session.todoProgress.hasMoved,
      lastTransitionAt: session.todoProgress.lastTransitionAt,
    } : null,
  })), [cockpit.sessions]);
  const exactWantsYouCount = exactWantsYouSessionCount(notificationSessions);

  useEffect(() => {
    const result = reduceNotifications({
      state: notificationState.current,
      sessions: notificationSessions,
      preferences: notificationPreferences,
      now: Date.now(),
      awaySince: awaySince.current,
      collectionFresh: cockpit.connection === "open" && !cockpit.snapshot.stale,
    });
    notificationState.current = result.state;
    const delay = result.nextDeadline === null ? null : Math.max(0, result.nextDeadline - Date.now());
    const timer = delay === null ? null : window.setTimeout(() => setNotificationWake((value) => value + 1), delay + 25);
    if (notificationPreferences.browser && typeof Notification !== "undefined" && Notification.permission === "granted") {
      for (const notice of result.notifications) {
        const notification = new Notification(notice.title, { body: notice.body, silent: notice.silent, tag: `${notice.kind}:${notice.sessionId}` });
        notification.onclick = () => { window.focus(); cockpit.setSelectedId(notice.sessionId); notification.close(); };
      }
    }
    return () => { if (timer !== null) window.clearTimeout(timer); };
  }, [cockpit.connection, cockpit.setSelectedId, cockpit.snapshot.stale, notificationPreferences, notificationSessions, notificationWake]);

  useEffect(() => {
    document.title = exactWantsYouCount ? `(${exactWantsYouCount}) Agent Manager` : "Agent Manager";
    const badge = navigator as Navigator & { setAppBadge?: (value?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    void (exactWantsYouCount ? badge.setAppBadge?.(exactWantsYouCount) : badge.clearAppBadge?.())?.catch(() => undefined);
  }, [exactWantsYouCount]);

  const canonicalPaletteSessions = useMemo(() => sessions.map(toBoardSession), [sessions]);
  const paletteSources = useMemo<PaletteSources>(() => ({
    sessions: sessionPaletteEntries(canonicalPaletteSessions),
    commands: [
      { id: "command:new", kind: "command" as const, label: "New thread", detail: null, keywords: ["create", "launch"], payload: { type: "new" } },
      { id: "command:refresh", kind: "command" as const, label: "Refresh state", detail: null, keywords: ["reload"], payload: { type: "refresh" } },
      { id: "command:review", kind: "command" as const, label: "Review this turn's changes", detail: changedFiles.length ? `${changedFiles.length} files` : null, keywords: ["diff", "files"], disabledReason: changedFiles.length ? null : "No file changes in the selected turn", payload: { type: "review" } },
      { id: "command:shortcuts", kind: "command" as const, label: "Keyboard shortcuts", detail: "?", keywords: ["help"], payload: { type: "shortcuts" } },
      { id: "command:notifications", kind: "command" as const, label: "Notification settings", detail: "local only", keywords: ["alerts", "privacy", "quiet"], payload: { type: "notification-settings" } },
      { id: "command:setup", kind: "command" as const, label: "Setup and integrations", detail: "hooks · hosts", keywords: ["hook", "hooks", "install", "ssh", "host", "terminal", "read-only", "observe"], payload: { type: "setup" } },
    ],
    transcripts: selected ? transcriptMatches.map((match) => ({ id: `transcript:${match.messageId}:${match.matchStart}`, kind: "transcript" as const, label: match.snippet, detail: match.role, keywords: [match.snippet], payload: { type: "session", id: selected.id } })) : [],
    // No bounded workspace file index or harness command catalog exists yet.
    // Prefixes with unavailable sources intentionally return no guessed rows.
    files: [],
    slash: [],
    hosts: cockpit.hosts.map((host) => ({ id: `host:${host.id}`, kind: "host" as const, label: host.label, detail: host.kind, keywords: [host.id, host.status], payload: { type: "host", id: host.id } })),
    worktrees: worktreePaletteEntries(canonicalPaletteSessions),
  }), [canonicalPaletteSessions, changedFiles, cockpit.hosts, selected, transcriptMatches]);

  const choosePalette = useCallback((entry: PaletteEntry) => {
    const payload = entry.payload as { type?: string; id?: string } | undefined;
    if (payload?.type === "session" && payload.id) { setDraft(null); cockpit.setSelectedId(payload.id); }
    else if (payload?.type === "new") openDraft();
    else if (payload?.type === "refresh") void cockpit.refresh().catch(() => undefined);
    else if (payload?.type === "review") setReviewOpen(true);
    else if (payload?.type === "shortcuts") setShortcutsOpen(true);
    else if (payload?.type === "notification-settings") setNotificationSettingsOpen(true);
    else if (payload?.type === "setup") openSetup();
    else if (payload?.type === "host" && payload.id) cockpit.setHostFilter(new Set([payload.id]));
  }, [cockpit, openDraft, openSetup]);

  // Escape is owned per layer by Radix's DismissableLayer: only the topmost
  // open surface sees it, and closing one never reaches the one beneath. This
  // listener therefore carries the application shortcuts and nothing else.
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen((open) => !open); return; }
      if (isTypingTarget(event.target)) return;
      if (event.key === "?" && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); setShortcutsOpen((open) => !open); return; }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "d" && selected && changedFiles.length) { event.preventDefault(); setReviewOpen(true); return; }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !paletteOpen && !shortcutsOpen && (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k")) {
        const ordered = board.columns.flatMap((column) => column.worktrees.flatMap((group) => group.sessions));
        if (ordered.length > 0) {
          event.preventDefault();
          const current = selected ? ordered.findIndex((session) => session.id === selected.id) : -1;
          const delta = event.key.toLowerCase() === "j" ? 1 : -1;
          openSession(ordered[(current + delta + ordered.length) % ordered.length]!);
        }
        return;
      }
      if (!draft && !selected && !paletteOpen && !shortcutsOpen && /^[1-9]$/u.test(event.key)) {
        const column = board.columns[Number(event.key) - 1];
        if (column) {
          event.preventDefault();
          const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
          document.querySelector<HTMLElement>(`[data-board-column="${CSS.escape(column.key)}"]`)?.scrollIntoView({ behavior: boardScrollBehavior(reduceMotion), inline: "start" });
        }
      }
    }
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [board.columns, changedFiles.length, draft, openSession, paletteOpen, selected, shortcutsOpen]);

  const toggleHost = useCallback((hostId: string) => {
    const next = new Set(cockpit.hostFilter.size === 0 ? cockpit.hosts.map((host) => host.id) : cockpit.hostFilter);
    if (next.has(hostId)) next.delete(hostId); else next.add(hostId);
    cockpit.setHostFilter(next.size === cockpit.hosts.length ? new Set() : next);
  }, [cockpit]);
  const toggleSelection = useCallback((session: BoardSession) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(session.id)) next.delete(session.id); else next.add(session.id);
    return next;
  }), []);
  const selectedBoardSessions = sessions.flatMap((session) => {
    const boardSession = board.columns.flatMap((column) => column.worktrees.flatMap((group) => group.sessions)).find((item) => item.id === session.id);
    return boardSession && selectedIds.has(session.id) ? [boardSession] : [];
  });
  const selectionAction = useCallback(async (action: SelectionAction, applicable: readonly BoardSession[]): Promise<SelectionOutcome> => {
    if (action === "delete" && !window.confirm(`Delete ${applicable.length} selected ${applicable.length === 1 ? "thread" : "threads"}?`)) return { succeeded: 0, unsupported: 0, failed: 0, cancelled: true };
    let cursor = 0;
    const outcomes: Array<"succeeded" | "failed"> = [];
    const workers = Array.from({ length: Math.min(3, applicable.length) }, async () => {
      while (cursor < applicable.length) {
        const view = applicable[cursor++]!;
        const session = cockpit.sessions.find((item) => item.id === view.id);
        if (!session) { outcomes.push("failed"); continue; }
        try { await cockpit.lifecycleAction(session, action); outcomes.push("succeeded"); }
        catch { outcomes.push("failed"); }
      }
    });
    await Promise.all(workers);
    const succeeded = outcomes.filter((outcome) => outcome === "succeeded").length;
    const unsupported = selectedBoardSessions.length - applicable.length;
    setSelectedIds(new Set());
    return { succeeded, unsupported, failed: outcomes.length - succeeded };
  }, [cockpit, selectedBoardSessions.length]);

  if (cockpit.authError) return <ErrorScreen message={cockpit.authError} onRetry={() => void cockpit.retryConnection()} />;
  if (!cockpit.ready) return cockpit.availability === "offline"
    ? <ErrorScreen message="This device cannot reach the private Agent Manager service." onRetry={() => void cockpit.retryConnection()} />
    : <LoadingScreen />;

  const drawerOpen = Boolean(selected || draft);
  const contentMode = cockpit.scope === "archived"
    ? "board"
    : cockpitContentMode(cockpit.sessions.length, cockpit.workspaces.length);
  const draftWorkspace = draft?.workspace;
  const drawerTitle = selected ? selected.name ?? selected.providerThreadId : draftWorkspace ? draftWorkspace.path.split("/").filter(Boolean).at(-1) ?? "New thread" : "New thread";
  const drawerInfo = selected ? drawerFacts(selected, selectedRemote) : draftWorkspace ? [{ label: draftWorkspace.path }] : [];

  return (
    <main className="relative flex h-dvh min-h-0 flex-col overflow-hidden bg-[var(--app)] text-[var(--text)]">
      <Header
        counts={{ ...board.counts, archived: cockpit.archivedCatalog.total }}
        scope={cockpit.scope}
        hosts={headerHosts}
        hostFilter={cockpit.hostFilter}
        connection={cockpit.connection}
        diagnostics={cockpit.snapshot.diagnostics.length}
        onScope={changeScope}
        onToggleHost={toggleHost}
        onPalette={() => setPaletteOpen(true)}
        onHelp={() => setShortcutsOpen(true)}
        onNew={() => openDraft()}
      />

      {cockpit.scope !== "archived" && <SelectionBar sessions={selectedBoardSessions} onClear={() => setSelectedIds(new Set())} onAction={selectionAction} />}

      {(cockpit.snapshot.stale || cockpit.connection !== "open") && <div className="z-20 shrink-0"><OfflineState generatedAt={cockpit.snapshot.generatedAt} /></div>}
      {cockpit.snapshot.diagnostics.length > 0 && (
        <Collapsible className="z-20 shrink-0 border-b border-[var(--rule)] bg-[var(--warning-field)] px-4 py-2 text-code-sm text-[var(--warning)]">
          <CollapsibleTrigger data-compact-control className="cursor-pointer text-left">{cockpit.snapshot.diagnostics.length} discovery {cockpit.snapshot.diagnostics.length === 1 ? "diagnostic" : "diagnostics"}</CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 grid gap-1 text-[var(--text-muted)]">{cockpit.snapshot.diagnostics.slice(-8).map((diagnostic, index) => <li key={`${diagnostic.message}:${index}`}>{diagnostic.provider}: {diagnostic.message}</li>)}</ul>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/*
        The drawer overlays the board region only. It must never become a
        sibling of the header: `absolute inset-y-0` would then resolve against
        the whole page and swallow every header control (spec 05 R7).
      */}
      <div className="relative flex min-h-0 flex-1 flex-col" data-board-region>
        {cockpit.scope === "archived" && <ArchivedCatalogBar
          query={cockpit.archivedCatalog.query}
          shown={cockpit.archivedCatalog.items.length}
          total={cockpit.archivedCatalog.total}
          status={cockpit.archivedCatalog.status}
          error={cockpit.archivedCatalog.error}
          hasMore={cockpit.archivedCatalog.nextCursor !== null}
          onSearch={cockpit.searchArchived}
          onLoadMore={cockpit.loadMoreArchived}
        />}
        {contentMode === "empty" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <EmptyState repositories={cockpit.workspaces.map((workspace) => ({ id: workspace.id, name: workspace.label, path: workspace.path }))} onOpen={(workspaceId) => { const workspace = cockpit.workspaces.find((item) => item.id === workspaceId); if (workspace) openDraft({ hostId: workspace.hostId, path: workspace.path }); }} />
          </div>
        ) : contentMode === "first-run" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {setupFacts?.state === "loaded"
              ? firstRunStep === "folder"
                ? <FirstRun nearby={setupFacts.value.nearby} hosts={setupFacts.value.hosts} onChooseFolder={(workspace) => { setPendingFirstWorkspace({ hostId: workspace.hostId, path: workspace.path }); setFirstRunStep("hooks"); }} onBrowse={cockpit.completeWorkspacePath} />
                : firstRunStep === "hooks"
                  ? <HookSetupStep hooks={setupFacts.value.hooks} onApply={applySetupHook} onRefresh={refreshSetup} onContinue={() => setFirstRunStep("ssh")} />
                  : <HostSetupStep hosts={setupFacts.value.hosts} onAddHost={addSetupHost} onRemoveHost={removeSetupHost} onContinue={() => { openDraft(pendingFirstWorkspace ?? undefined); setFirstRunStep("folder"); }} />
              : setupFacts?.state === "error"
                ? <section className="mx-auto grid max-w-lg place-items-center p-10 text-center"><AlertCircle className="text-[var(--warning)]" /><h2 className="mt-3 text-title-md">Setup facts are unavailable</h2><p className="mt-1 text-meta-sm text-[var(--text-muted)]">{setupFacts.error}</p><Button variant="primary" size="touch" className="mt-4" onClick={refreshSetup}>Try again</Button></section>
                : <ConnectingState sources={["discovered repositories", "provider hook settings", "configured remote hosts"]} />}
          </div>
        ) : board.columns.length === 0 && board.bands.length === 0 ? (
          cockpit.scope === "archived"
            ? <ArchivedCatalogEmpty status={cockpit.archivedCatalog.status} error={cockpit.archivedCatalog.error} query={cockpit.archivedCatalog.query} onRetry={() => void cockpit.searchArchived(cockpit.archivedCatalog.query)} />
            : <section className="grid min-h-0 flex-1 place-content-center p-6 text-center"><Search className="mx-auto text-[var(--text-muted)]" /><h2 className="mt-3 text-title-sm">No sessions match these filters</h2><Button variant="ghost" size="sm" data-compact-control className="mx-auto mt-3 underline [color:var(--accent)]" onClick={() => { cockpit.setScope("all"); cockpit.setHostFilter(new Set()); }}>Clear filters</Button></section>
        ) : (
          <>
            <DesktopBoard columns={board.columns} selectedSessionIds={cockpit.scope === "archived" ? new Set() : selectedIds} onOpenSession={openSession} {...(cockpit.scope === "archived" ? { showNewThread: false } : { onToggleSelection: toggleSelection, onNewThread: (column: BoardColumn) => openDraft(workspaceForColumn(column)) })} />
            <PhoneBoardBands bands={board.bands} onOpenSession={openSession} />
          </>
        )}

        {/*
          The thread runtime wraps the drawer rather than sitting inside it. The
          drawer owns the only scroll container the thread has, so a viewport
          created below it would nest a second scroller inside the first; and
          the composer is a sibling prop, which kept it outside the runtime
          entirely. Neither provider renders an element, so the drawer is still
          a direct child of `[data-board-region]`.
        */}
        <SessionRuntimeProvider
          items={selected ? activity.items : EMPTY_ACTIVITY_ITEMS}
          {...(selected ? { queue: {
            messages: currentQueue(activity),
            canRemove: cockpit.mutationsReady && selected.control.capabilities.includes("remove-queued"),
            onRemove: (messageId: string) => void cockpit.removeQueued(selected, messageId),
          } } : {})}
        >{(viewportRef) => (
        <ThreadDrawer
          viewportRef={viewportRef}
          open={drawerOpen}
          title={drawerTitle}
          facts={drawerInfo}
          todo={selected ? selectedPresentation?.todo ?? null : null}
          onClose={closeDrawer}
          composer={selected && !selected.archived ? <SessionThreadComposer
            session={selected}
            activity={activity}
            busy={selectedBusy}
            mutationsReady={cockpit.mutationsReady}
            onSend={(text, delivery) => cockpit.sendMessage(selected, text, delivery)}
            onInterrupt={() => cockpit.interrupt(selected)}
            onSetProfile={(profile) => cockpit.setProfile(selected, profile)}
            onSetSandbox={(sandbox) => cockpit.setSandbox(selected, sandbox)}
            onSetModel={(model) => cockpit.setModel(selected, model)}
            onSetEffort={(effort) => cockpit.setEffort(selected, effort)}
            modelOptions={selectedModelCatalog.models}
            modelOptionsStatus={selectedModelCatalog.status}
            onOpenSetup={openSetup}
            onTakeControl={(method, takeoverId) => cockpit.takeCliControl(selected, method, takeoverId)}
            onCancelTakeControl={(takeoverId) => cockpit.cancelCliTakeover(selected, takeoverId)}
            onRetryControl={() => cockpit.retryControl(selected)}
            onResumeInWeb={() => cockpit.resumeInWeb(selected)}
            {...(selectedRemote || selected.archived ? {} : { onSearchFiles: (query: string) => cockpit.loadWorkspaceFiles(selected.id, query) })}
            {...(selectedModelCatalog.effortOptions !== undefined ? { effortOptions: selectedModelCatalog.effortOptions } : {})}
            {...(restoredDraft?.sessionId === selected.id ? { restoredDraft: { key: restoredDraft.key, text: restoredDraft.text } } : {})}
          /> : undefined}
        >
          {selected ? <SessionThread
            key={selected.id}
            session={selected}
            activity={activity}
            remote={selectedRemote}
            busy={selectedBusy}
            mutationsReady={cockpit.mutationsReady}
            onRespond={(requestId, response) => cockpit.respond(selected, requestId, response)}
            onRemoveQueued={(id) => cockpit.removeQueued(selected, id)}
            onOpenEditor={(path) => cockpit.openEditor(selected, path)}
            onResumeInWeb={() => cockpit.resumeInWeb(selected)}
            readKeys={readKeys}
            onReadChange={(key, read) => setReadKeys((current) => { const next = new Set(current); if (read) next.add(key); else next.delete(key); return next; })}
            loadAttach={() => cockpit.loadAttach(selected)}
            loadSessionFacts={cockpit.loadSessionFacts}
            loadPlanFile={loadSelectedPlanFile}
            sessionsOnHost={selectedSessionsOnHost}
            onContinueInWorkspace={() => openDraft({ hostId: selected.hostId, path: selected.workspaceIdentity?.worktreePath ?? selected.cwd ?? "" })}
            onRetryActivity={() => setActivityRetryGeneration((generation) => generation + 1)}
          /> : draft ? <DraftThread draft={draft} hosts={cockpit.hosts} workspaces={cockpit.workspaces} busy={Boolean(cockpit.busy.create)} mutationsReady={cockpit.mutationsReady} modelOptions={draftModelCatalog.models} modelOptionsStatus={draftModelCatalog.status} {...(draftModelCatalog.effortOptions !== undefined ? { effortOptions: draftModelCatalog.effortOptions } : {})} dispatch={dispatchDraft} onFirstSend={firstSend} onCompletePath={cockpit.completeWorkspacePath} onLoadGitContext={cockpit.loadGitContext} /> : null}
        </ThreadDrawer>
        )}</SessionRuntimeProvider>
      </div>

      {reviewOpen && selected && <DiffReview changes={changedFiles} branch={selected.workspaceIdentity?.branch ?? null} uncommitted={selected.workspaceIdentity?.dirtyCount === null ? null : (selected.workspaceIdentity?.dirtyCount ?? 0) > 0} readKeys={readKeys} onReadChange={(key, read) => setReadKeys((current) => { const next = new Set(current); if (read) next.add(key); else next.delete(key); return next; })} {...(selected.control.capabilities.includes("open-editor") ? { onOpenEditor: (relativePath: string) => void cockpit.openEditor(selected, relativePath), resolveEditorPath: (path: string) => relativeEditorPath(selected.workspaceIdentity?.worktreePath ?? selected.cwd, path) } : {})} onClose={() => setReviewOpen(false)} />}
      <CommandPalette open={paletteOpen} sources={paletteSources} onOpenChange={setPaletteOpen} onChoose={choosePalette} onQueryChange={setPaletteQuery} />
      <ShortcutSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {notificationSettingsOpen && <NotificationSettings preferences={notificationPreferences} onChange={setNotificationPreferences} onClose={() => setNotificationSettingsOpen(false)} />}
      {setupOpen && <SetupDialog setup={setupFacts} onApplyHook={applySetupHook} onAddHost={addSetupHost} onRemoveHost={removeSetupHost} onRetry={refreshSetup} onClose={() => setSetupOpen(false)} />}

      <CockpitToast
        actionError={cockpit.actionError}
        notice={cockpit.notice}
        canTakeOver={Boolean(selected && cockpit.controlConflict !== undefined)}
        onTakeOver={() => { if (selected) void cockpit.takeOverControl(selected).catch(() => undefined); }}
        onDismiss={() => { cockpit.clearActionError(); cockpit.clearNotice(); }}
      />
      {cockpit.outbox.length > 0 && <aside className="fixed bottom-4 left-4 z-[70] border border-[var(--border)] bg-[var(--menu)] px-3 py-2 text-code-sm text-[var(--warning)]"><WifiOff size={13} className="mr-2 inline" />{cockpit.outbox.length} message{cockpit.outbox.length === 1 ? "" : "s"} held offline</aside>}
      {cockpit.offlineReview[0] && <aside className="fixed bottom-16 left-4 z-[75] max-w-[min(440px,calc(100%-32px))] border-l-2 border-[var(--warning)] bg-[var(--menu)] p-3 text-meta-sm"><p className="flex gap-2 text-[var(--warning)]"><TriangleAlert size={14} />Message needs review</p><p className="mt-1 text-[var(--text-muted)]">{cockpit.offlineReview[0].reason}</p><div className="mt-2 flex gap-3"><Button variant="ghost" size="sm" data-compact-control className="px-0 underline [color:var(--accent)]" onClick={() => { const item = cockpit.offlineReview[0]!; if (cockpit.sessions.some((session) => session.id === item.sessionId)) { setDraft(null); cockpit.setSelectedId(item.sessionId); setRestoredDraft({ sessionId: item.sessionId, key: item.id, text: item.text }); } cockpit.dismissOfflineReview(item.id); }}>Restore draft</Button><Button variant="ghost" size="sm" data-compact-control className="px-0 underline [color:var(--text-muted)]" onClick={() => cockpit.dismissOfflineReview(cockpit.offlineReview[0]!.id)}>Discard</Button></div></aside>}
      {privacyCovered && <div className="app-privacy-cover"><span className="app-privacy-cover__mark"><Command size={20} /></span></div>}
    </main>
  );
}
