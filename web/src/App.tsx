import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  BellOff,
  Check,
  Command,
  Laptop,
  ListTodo,
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
  draftReducer,
  newDraftSession,
  type DraftAction,
  type DraftSession,
  type DraftWorkspace,
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
import { preferredFileChangeItems, sessionTodoProgress } from "./components/session-activity";
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
import { toCockpitSessionView } from "./lib/cockpit-view";
import type { ProviderSettingsOptionsResponse, SessionSettingsOptionsResponse, SetupReadModel, TranscriptSearchMatch } from "./lib/api";
import { isTypingTarget } from "./lib/shortcuts";
import type { ActivityItem, HostOption, ReasoningEffort, SessionView } from "./types";

const FILTERS = [
  ["all", "All"],
  ["wants-you", "Wants you"],
  ["working", "Working"],
  ["idle", "Idle"],
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

function drawerFacts(session: SessionView, remote: boolean) {
  return [
    { label: session.provider },
    session.profile.value ? { label: session.profile.value, tone: session.profile.value === "full-access" ? "dirty" as const : "default" as const } : null,
    session.model.value ? { label: session.model.value } : null,
    session.workspaceIdentity?.branch ? { label: session.workspaceIdentity.branch } : null,
    session.workspaceIdentity?.dirtyCount ? { label: `${session.workspaceIdentity.dirtyCount} uncommitted`, tone: "dirty" as const } : null,
    remote ? { label: session.hostLabel, tone: "remote" as const } : null,
  ].filter((fact): fact is NonNullable<typeof fact> => fact !== null);
}

function workspaceForColumn(column: BoardColumn): DraftWorkspace | undefined {
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

/** Codex effort support is model-specific in the pinned provider catalog. */
export function codexCatalogEfforts(
  provider: SessionView["provider"],
  model: string | null,
  response: SessionSettingsOptionsResponse | ProviderSettingsOptionsResponse | null,
): readonly ReasoningEffort[] | undefined {
  if (provider !== "codex" || !response?.available) return undefined;
  const option = model
    ? response.models.find((candidate) => candidate.value === model)
    : response.models.find((candidate) => candidate.isDefault === true);
  // A live Codex catalog replaces the global guess. Missing metadata therefore
  // disables the choices instead of falling back to a fabricated superset.
  return option?.efforts ?? [];
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

/**
 * The one standalone surface for hook and host integration facts. It reads the
 * same bounded `/setup` model first run uses and, like first run, only ever
 * shows the exact CLI command and redacted diff for the operator to run.
 */
export function SetupDialog({ setup, onRetry, onClose }: { setup: SetupFactsState; onRetry: () => void; onClose: () => void }) {
  const openerRef = useRef<HTMLElement | null>(null);
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent {...rememberOpener(openerRef)} showCloseButton={false} data-setup-dialog className="flex max-h-[min(760px,calc(100dvh-88px))] max-w-[880px] flex-col gap-0 p-0">
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--rule)] px-5 py-3">
          <div className="min-w-0">
            <DialogTitle className="pr-0">Setup and integrations</DialogTitle>
            <DialogDescription className="mt-0.5 text-meta-sm text-[var(--text-muted)]">This browser never changes provider settings. Run the commands yourself.</DialogDescription>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" data-compact-control className="ml-auto size-10 shrink-0" aria-label="Close setup and integrations"><X size={16} /></Button>
          </DialogClose>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {setup?.state === "loaded"
            ? <><HookSetupStep hooks={setup.value.hooks} standalone /><HostSetupStep hosts={setup.value.hosts} standalone /></>
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
  counts: Record<"all" | "wants-you" | "working" | "failed" | "idle", number>;
  scope: "all" | "wants-you" | "working" | "idle";
  hosts: readonly { id: string; label: string; kind: "local" | "ssh"; status: string; count: number }[];
  hostFilter: ReadonlySet<string>;
  connection: string;
  diagnostics: number;
  onScope: (scope: "all" | "wants-you" | "working" | "idle") => void;
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

export default function App() {
  const cockpit = useCockpit();
  const activity = useSessionActivity(cockpit.selectedId);
  const [draft, setDraft] = useState<DraftSession | null>(() => new URLSearchParams(window.location.search).get("draft") === "1" ? newDraftSession() : null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [transcriptMatches, setTranscriptMatches] = useState<readonly TranscriptSearchMatch[]>([]);
  const [settingsOptions, setSettingsOptions] = useState<
    | { sessionId: string; state: "loading"; response: null }
    | { sessionId: string; state: "error"; response: null }
    | { sessionId: string; state: "loaded"; response: SessionSettingsOptionsResponse }
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
  const [pendingFirstWorkspace, setPendingFirstWorkspace] = useState<DraftWorkspace | null>(null);
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
  // Hook and host facts change outside this browser, so every explicit open
  // re-reads them instead of trusting a first-run snapshot.
  const openSetup = useCallback(() => { setupProbes.current = 0; setSetupOpen(true); refreshSetup(); }, [refreshSetup]);

  useEffect(() => {
    if (!cockpit.ready || !cockpit.mutationsReady || cockpitContentMode(cockpit.sessions.length, cockpit.workspaces.length) !== "first-run" || setupLoadStarted.current) return;
    refreshSetup();
  }, [cockpit.mutationsReady, cockpit.ready, cockpit.sessions.length, cockpit.workspaces.length, refreshSetup]);


  /*
    Adding a hook edits a settings file, and a settings edit emits no provider
    event — so a session stays "installed-unseen" until its next real event, and
    "absent" until the operator has actually run the command. Neither transition
    reaches this browser on its own. While the dialog is open on an unfinished
    hook, re-read the facts so the state moves without a restart. `/api/v1/setup`
    allows ten reads a minute; this stays under it and stops after two.
  */
  useEffect(() => {
    if (!setupOpen || setupFacts?.state !== "loaded") return;
    const unfinished = ([setupFacts.value.hooks.claude, setupFacts.value.hooks.codex] as const)
      .some((hook) => hook.state === "absent" || hook.state === "installed-unseen");
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
  const sessions = useMemo(() => cockpit.sessions.map((session) => {
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
  }), [activity.sessionId, cockpit.sessions, phoneAttentionLabels, remoteHostIds, selectedActivityTodo, todoDetails]);
  const board = useBoardModel(sessions, {
    scope: cockpit.scope,
    hostIds: cockpit.hostFilter,
  });

  const selected = cockpit.selectedSession;

  /*
    `cockpitContentMode` returns "board" as soon as one session exists, so an
    operator whose only sessions were discovered in a terminal never saw the
    first-run wizard and never learned that hooks are what make such a session
    answerable. Reading the facts once, when the first observation-only session
    is opened, is what lets the drawer say so. Still a read: this browser never
    writes provider settings.
  */
  useEffect(() => {
    if (!cockpit.ready || !cockpit.mutationsReady || setupLoadStarted.current) return;
    if (!selected || selected.control.plane !== "observe-only") return;
    refreshSetup();
  }, [cockpit.mutationsReady, cockpit.ready, refreshSetup, selected]);

  /** The hook state for the selected session's own provider, once it is known. */
  const selectedHookState = selected && setupFacts?.state === "loaded"
    ? setupFacts.value.hooks[selected.provider].state
    : null;
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
  const selectedCanSetModel = Boolean(selected?.control.capabilities.includes("set-model"));

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

  useEffect(() => {
    if (!selected || !selectedCanSetModel) {
      setSettingsOptions(null);
      return;
    }
    const sessionId = selected.id;
    let cancelled = false;
    setSettingsOptions({ sessionId, state: "loading", response: null });
    void cockpit.loadSettingsOptions(sessionId).then((response) => {
      if (!cancelled) setSettingsOptions({ sessionId, state: "loaded", response });
    }).catch(() => {
      if (!cancelled) setSettingsOptions({ sessionId, state: "error", response: null });
    });
    return () => { cancelled = true; };
  }, [cockpit.loadSettingsOptions, selected?.id, selectedCanSetModel]);

  const selectedModelCatalog = useMemo(() => {
    if (!settingsOptions || settingsOptions.sessionId !== selected?.id) return { models: [], status: null, effortOptions: undefined };
    if (settingsOptions.state === "loading") return { models: [], status: "Loading the provider model catalog…", effortOptions: undefined };
    if (settingsOptions.state === "error") return { models: [], status: "The provider model catalog could not be loaded.", effortOptions: undefined };
    const response = settingsOptions.response;
    return response.available
      ? { models: response.models, status: null, effortOptions: codexCatalogEfforts(selected.provider, selected.model.value, response) }
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
      ? { models: response.models, status: null, effortOptions: codexCatalogEfforts(draftProvider, draft?.model ?? null, response) }
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
  const openDraft = useCallback((workspace?: DraftWorkspace) => {
    void cockpit.closeSelected();
    setDraft(newDraftSession(workspace ? { workspace } : {}));
  }, [cockpit]);
  const closeDrawer = useCallback(() => {
    setDraft(null);
    setReviewOpen(false);
    void cockpit.closeSelected();
  }, [cockpit]);

  const firstSend = useCallback(async () => {
    if (!draft || !canAttemptDraftCreation(draft) || !draft.workspace) return;
    const current = draft;
    const workspace = draft.workspace;
    dispatchDraft({ type: "creating" });
    try {
      await cockpit.createSession({
        hostId: workspace.hostId,
        workspacePath: workspace.path,
        provider: current.provider,
        initialMessage: current.text.trim(),
        profile: current.profile,
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
  const contentMode = cockpitContentMode(cockpit.sessions.length, cockpit.workspaces.length);
  const draftWorkspace = draft?.workspace;
  const drawerTitle = selected ? selected.name ?? selected.providerThreadId : draftWorkspace ? draftWorkspace.path.split("/").filter(Boolean).at(-1) ?? "New thread" : "New thread";
  const drawerInfo = selected ? drawerFacts(selected, selectedRemote) : draftWorkspace ? [{ label: draftWorkspace.path }] : [];

  return (
    <main className="relative flex h-dvh min-h-0 flex-col overflow-hidden bg-[var(--app)] text-[var(--text)]">
      <Header
        counts={board.counts}
        scope={cockpit.scope}
        hosts={headerHosts}
        hostFilter={cockpit.hostFilter}
        connection={cockpit.connection}
        diagnostics={cockpit.snapshot.diagnostics.length}
        onScope={cockpit.setScope}
        onToggleHost={toggleHost}
        onPalette={() => setPaletteOpen(true)}
        onHelp={() => setShortcutsOpen(true)}
        onNew={() => openDraft()}
      />

      <SelectionBar sessions={selectedBoardSessions} onClear={() => setSelectedIds(new Set())} onAction={selectionAction} />

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
                  ? <HookSetupStep hooks={setupFacts.value.hooks} onContinue={() => setFirstRunStep("ssh")} />
                  : <HostSetupStep hosts={setupFacts.value.hosts} onContinue={() => { openDraft(pendingFirstWorkspace ?? undefined); setFirstRunStep("folder"); }} />
              : setupFacts?.state === "error"
                ? <section className="mx-auto grid max-w-lg place-items-center p-10 text-center"><AlertCircle className="text-[var(--warning)]" /><h2 className="mt-3 text-title-md">Setup facts are unavailable</h2><p className="mt-1 text-meta-sm text-[var(--text-muted)]">{setupFacts.error}</p><Button variant="primary" size="touch" className="mt-4" onClick={refreshSetup}>Try again</Button></section>
                : <ConnectingState sources={["discovered repositories", "provider hook settings", "configured remote hosts"]} />}
          </div>
        ) : board.columns.length === 0 && board.bands.length === 0 ? (
          <section className="grid min-h-0 flex-1 place-content-center p-6 text-center"><Search className="mx-auto text-[var(--text-muted)]" /><h2 className="mt-3 text-title-sm">No sessions match these filters</h2><Button variant="ghost" size="sm" data-compact-control className="mx-auto mt-3 underline [color:var(--accent)]" onClick={() => { cockpit.setScope("all"); cockpit.setHostFilter(new Set()); }}>Clear filters</Button></section>
        ) : (
          <>
            <DesktopBoard columns={board.columns} selectedSessionIds={selectedIds} onOpenSession={openSession} onToggleSelection={toggleSelection} onNewThread={(column) => openDraft(workspaceForColumn(column))} />
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
        <SessionRuntimeProvider items={selected ? activity.items : EMPTY_ACTIVITY_ITEMS}>{(viewportRef) => (
        <ThreadDrawer
          viewportRef={viewportRef}
          open={drawerOpen}
          title={drawerTitle}
          facts={drawerInfo}
          todo={selected ? selectedPresentation?.todo ?? null : null}
          onClose={closeDrawer}
          composer={selected ? <SessionThreadComposer
            session={selected}
            activity={activity}
            busy={selectedBusy}
            mutationsReady={cockpit.mutationsReady}
            onSend={(text, delivery) => cockpit.sendMessage(selected, text, delivery)}
            onInterrupt={() => cockpit.interrupt(selected)}
            onSetProfile={(profile) => cockpit.setProfile(selected, profile)}
            onSetModel={(model) => cockpit.setModel(selected, model)}
            onSetEffort={(effort) => cockpit.setEffort(selected, effort)}
            modelOptions={selectedModelCatalog.models}
            modelOptionsStatus={selectedModelCatalog.status}
            onOpenSetup={openSetup}
            {...(selectedHookState ? { hookState: selectedHookState } : {})}
            {...(selectedRemote ? {} : { onSearchFiles: (query: string) => cockpit.loadWorkspaceFiles(selected.id, query) })}
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
            readKeys={readKeys}
            onReadChange={(key, read) => setReadKeys((current) => { const next = new Set(current); if (read) next.add(key); else next.delete(key); return next; })}
            loadAttach={() => cockpit.loadAttach(selected)}
            loadSessionFacts={cockpit.loadSessionFacts}
            loadPlanFile={loadSelectedPlanFile}
            sessionsOnHost={selectedSessionsOnHost}
            onContinueInWorkspace={() => openDraft({ hostId: selected.hostId, path: selected.workspaceIdentity?.worktreePath ?? selected.cwd ?? "" })}
          /> : draft ? <DraftThread draft={draft} hosts={cockpit.hosts} workspaces={cockpit.workspaces} busy={Boolean(cockpit.busy.create)} mutationsReady={cockpit.mutationsReady} modelOptions={draftModelCatalog.models} modelOptionsStatus={draftModelCatalog.status} {...(draftModelCatalog.effortOptions !== undefined ? { effortOptions: draftModelCatalog.effortOptions } : {})} dispatch={dispatchDraft} onFirstSend={firstSend} /> : null}
        </ThreadDrawer>
        )}</SessionRuntimeProvider>
      </div>

      {reviewOpen && selected && <DiffReview changes={changedFiles} branch={selected.workspaceIdentity?.branch ?? null} uncommitted={selected.workspaceIdentity?.dirtyCount === null ? null : (selected.workspaceIdentity?.dirtyCount ?? 0) > 0} readKeys={readKeys} onReadChange={(key, read) => setReadKeys((current) => { const next = new Set(current); if (read) next.add(key); else next.delete(key); return next; })} {...(selected.control.capabilities.includes("open-editor") ? { onOpenEditor: (relativePath: string) => void cockpit.openEditor(selected, relativePath), resolveEditorPath: (path: string) => relativeEditorPath(selected.workspaceIdentity?.worktreePath ?? selected.cwd, path) } : {})} onClose={() => setReviewOpen(false)} />}
      <CommandPalette open={paletteOpen} sources={paletteSources} onOpenChange={setPaletteOpen} onChoose={choosePalette} onQueryChange={setPaletteQuery} />
      <ShortcutSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {notificationSettingsOpen && <NotificationSettings preferences={notificationPreferences} onChange={setNotificationPreferences} onClose={() => setNotificationSettingsOpen(false)} />}
      {setupOpen && <SetupDialog setup={setupFacts} onRetry={refreshSetup} onClose={() => setSetupOpen(false)} />}

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
