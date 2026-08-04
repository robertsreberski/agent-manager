import { useCallback, useEffect, useMemo, useState } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  Activity,
  AlertCircle,
  CircleUserRound,
  Code2,
  Download,
  ExternalLink,
  ListTree,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  UserRoundCog,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "./ui/sheet";
import {
  countSessionScopes,
  navigationSessions,
  searchWithSessionScope,
  sessionScopeFromSearch,
  type NavigationSession,
  type SessionScope,
  type SessionScopeCounts,
} from "../lib/session-navigation";
import { cn, formatRelativeTime } from "../lib/utils";
import type { ConnectionState, SessionView } from "../types";

const SCOPE_ITEMS: Array<{
  value: SessionScope;
  label: string;
  icon: LucideIcon;
}> = [
  { value: "needs-you", label: "Needs you", icon: AlertCircle },
  { value: "working", label: "Working", icon: Activity },
  { value: "all", label: "All", icon: ListTree },
  { value: "managed", label: "Managed", icon: UserRoundCog },
  { value: "external", label: "External", icon: ExternalLink },
  { value: "codex", label: "Codex", icon: Code2 },
  { value: "claude", label: "Claude", icon: Sparkles },
];

export interface SessionSidebarProps {
  sessions: SessionView[];
  selectedId: string | null;
  connection: ConnectionState;
  actor: string | null;
  onSelect: (id: string) => void;
  onLaunch: () => void;
  onRefresh: () => void;
  canLaunch?: boolean;
  installAvailable?: boolean;
  onInstall?: () => void;
}

function countLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function connectionLabel(connection: ConnectionState): string {
  switch (connection) {
    case "open":
      return "Live";
    case "retrying":
      return "Reconnecting";
    case "connecting":
      return "Connecting";
    case "offline":
      return "Offline";
  }
}

function ScopeButton({
  item,
  active,
  count,
  expanded,
  onSelect,
}: {
  item: (typeof SCOPE_ITEMS)[number];
  active: boolean;
  count: number;
  expanded: boolean;
  onSelect: () => void;
}) {
  const Icon = item.icon;
  const button = (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`${item.label}, ${count} session${count === 1 ? "" : "s"}`}
      aria-pressed={active}
      className={cn(
        "group relative flex h-10 w-full items-center rounded-lg text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--rail)]",
        expanded ? "gap-2.5 px-3" : "justify-center px-2",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-[var(--rail-muted)] hover:bg-[var(--rail-hover)] hover:text-[var(--rail-foreground)]",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {expanded ? (
        <>
          <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
          <span
            className={cn(
              "min-w-5 rounded-full px-1.5 py-0.5 text-center text-[10px] tabular-nums",
              active ? "bg-primary-foreground/15" : "bg-white/8 text-[var(--rail-foreground)]",
            )}
            aria-hidden="true"
          >
            {countLabel(count)}
          </span>
        </>
      ) : (
        <span
          className={cn(
            "absolute right-0.5 top-0.5 min-w-4 rounded-full px-1 text-center text-[9px] leading-4 tabular-nums",
            active ? "bg-primary-foreground text-primary" : "bg-[var(--rail-hover)] text-[var(--rail-foreground)]",
          )}
          aria-hidden="true"
        >
          {countLabel(count)}
        </span>
      )}
    </button>
  );

  if (expanded) return button;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{button}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side="right"
          sideOffset={8}
          className="z-[70] rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-lg"
        >
          {item.label} · {count}
          <TooltipPrimitive.Arrow className="fill-foreground" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

function ScopeRail({
  scope,
  counts,
  expanded,
  onScopeChange,
  onExpandedChange,
}: {
  scope: SessionScope;
  counts: SessionScopeCounts;
  expanded: boolean;
  onScopeChange: (scope: SessionScope) => void;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const ToggleIcon = expanded ? PanelLeftClose : PanelLeftOpen;
  const toggleLabel = expanded ? "Collapse scope navigation" : "Expand scope navigation";
  return (
    <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={150}>
      <div
        data-scope-rail
        data-expanded={expanded || undefined}
        className={cn(
          "flex h-full shrink-0 flex-col overflow-visible bg-[var(--rail)] text-[var(--rail-foreground)] transition-[width] duration-200 motion-reduce:transition-none",
          expanded ? "w-[var(--scope-rail-expanded)]" : "w-[var(--scope-rail-collapsed)]",
        )}
      >
        <div className={cn("flex h-14 shrink-0 items-center border-b border-white/10", expanded ? "gap-2.5 px-3" : "justify-center")}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Activity className="size-4" aria-hidden="true" />
          </span>
          {expanded && <span className="truncate text-sm font-semibold">Agent Manager</span>}
        </div>

        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-visible px-2 py-3" aria-label="Session scopes">
          {SCOPE_ITEMS.map((item) => (
            <ScopeButton
              key={item.value}
              item={item}
              active={scope === item.value}
              count={counts[item.value]}
              expanded={expanded}
              onSelect={() => onScopeChange(item.value)}
            />
          ))}
        </nav>

        <div className="shrink-0 border-t border-white/10 p-2">
          <TooltipPrimitive.Root>
            <TooltipPrimitive.Trigger asChild>
              <button
                type="button"
                onClick={() => onExpandedChange(!expanded)}
                aria-label={toggleLabel}
                aria-expanded={expanded}
                className={cn(
                  "flex h-10 w-full items-center rounded-lg text-[var(--rail-muted)] outline-none transition-colors hover:bg-[var(--rail-hover)] hover:text-[var(--rail-foreground)] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--rail)]",
                  expanded ? "gap-2.5 px-3" : "justify-center px-2",
                )}
              >
                <ToggleIcon className="size-4 shrink-0" aria-hidden="true" />
                {expanded && <span className="truncate text-xs font-medium">Collapse</span>}
              </button>
            </TooltipPrimitive.Trigger>
            {!expanded && (
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content
                  side="right"
                  sideOffset={8}
                  className="z-[70] rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-lg"
                >
                  {toggleLabel}
                  <TooltipPrimitive.Arrow className="fill-foreground" />
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            )}
          </TooltipPrimitive.Root>
        </div>
      </div>
    </TooltipPrimitive.Provider>
  );
}

function activityMeta(session: SessionView): { label: string; dot: string } {
  if (session.attention.length > 0) {
    return { label: "Needs you", dot: "bg-amber-500" };
  }
  switch (session.activity) {
    case "running":
      return { label: "Working", dot: "bg-emerald-500" };
    case "waiting":
      return { label: "Waiting", dot: "bg-amber-500" };
    case "failed":
      return { label: "Failed", dot: "bg-red-500" };
    case "completed":
      return { label: "Completed", dot: "bg-muted-foreground/55" };
    case "interrupted":
      return { label: "Interrupted", dot: "bg-muted-foreground/55" };
    case "idle":
      return { label: "Idle", dot: "bg-muted-foreground/55" };
    case "unknown":
      return { label: "Unknown", dot: "bg-muted-foreground/40" };
  }
}

function SessionRow({
  item,
  selected,
  onSelect,
}: {
  item: NavigationSession;
  selected: boolean;
  onSelect: () => void;
}) {
  const { session } = item;
  const displayName = session.name || session.cwd?.split("/").filter(Boolean).at(-1) || `${session.provider} session`;
  const meta = activityMeta(session);
  const ProviderIcon = session.provider === "codex" ? Code2 : Sparkles;
  const depth = Math.min(Math.max(item.depth, 0), 5);
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={depth + 1}
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
      data-session-row
      data-compact-control
      data-ancestor-only={item.ancestorOnly || undefined}
      className={cn(
        "group relative flex h-[52px] w-full items-center gap-2 rounded-md border border-transparent pr-2 text-left outline-none transition-colors [@media(pointer:coarse)]:h-14",
        "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-sidebar-border bg-sidebar-accent shadow-sm",
        item.ancestorOnly && "text-muted-foreground",
      )}
      style={{ paddingInlineStart: `${8 + depth * 12}px` }}
    >
      {depth > 0 && (
        <span
          className="absolute bottom-1.5 top-1.5 w-px bg-sidebar-border"
          style={{ insetInlineStart: `${5 + (depth - 1) * 12}px` }}
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border bg-background",
          session.provider === "codex" ? "text-emerald-600" : "text-orange-600",
        )}
        title={session.provider === "codex" ? "Codex" : "Claude"}
      >
        <ProviderIcon className="size-3.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">{displayName}</span>
          <time className="shrink-0 text-[10px] text-muted-foreground" dateTime={session.updatedAt ?? undefined}>
            {formatRelativeTime(session.updatedAt)}
          </time>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[10px] leading-4 text-muted-foreground">
          <span className={cn("size-1.5 shrink-0 rounded-full", meta.dot, session.activity === "running" && "animate-pulse motion-reduce:animate-none")} aria-hidden="true" />
          <span className="shrink-0">{meta.label}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate font-mono" title={session.cwd ?? session.id}>{session.cwd ?? session.id}</span>
          {session.attention.length > 0 && (
            <span className="ml-auto shrink-0 rounded-full bg-amber-500/15 px-1.5 font-medium text-amber-700 dark:text-amber-300">
              {session.attention.length}
              <span className="sr-only"> request{session.attention.length === 1 ? "" : "s"}</span>
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function SessionList({
  sessions,
  selectedId,
  scope,
  query,
  onSelect,
}: {
  sessions: NavigationSession[];
  selectedId: string | null;
  scope: SessionScope;
  query: string;
  onSelect: (id: string) => void;
}) {
  const activeScope = SCOPE_ITEMS.find((item) => item.value === scope)?.label ?? "All";
  return (
    <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label={`${activeScope} sessions`} role="tree">
      {sessions.length > 0 ? (
        <div className="space-y-0.5">
          {sessions.map((item) => (
            <SessionRow
              key={item.session.id}
              item={item}
              selected={item.session.id === selectedId}
              onSelect={() => onSelect(item.session.id)}
            />
          ))}
        </div>
      ) : (
        <div className="m-2 rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          <AlertCircle className="mx-auto mb-2 size-5" aria-hidden="true" />
          {query.trim() ? "No sessions match your search." : `No ${activeScope.toLocaleLowerCase()} sessions.`}
        </div>
      )}
    </nav>
  );
}

function ConnectionFooter({
  connection,
  actor,
  onRefresh,
  installAvailable,
  onInstall,
}: {
  connection: ConnectionState;
  actor: string | null;
  onRefresh: () => void;
  installAvailable: boolean;
  onInstall: (() => void) | undefined;
}) {
  const live = connection === "open";
  return (
    <footer className="flex h-11 shrink-0 items-center justify-between gap-2 border-t border-sidebar-border px-3 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        {live ? <Wifi className="size-3.5 shrink-0 text-emerald-500" aria-hidden="true" /> : <WifiOff className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />}
        <span className="shrink-0 font-medium text-sidebar-foreground">{connectionLabel(connection)}</span>
        <span aria-hidden="true">·</span>
        <CircleUserRound className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate" title={actor ?? "Local browser"}>{actor || "Local browser"}</span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {installAvailable && onInstall && (
          <Button variant="ghost" size="icon" onClick={onInstall} aria-label="Install Agent Manager" className="size-8">
            <Download />
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={onRefresh} aria-label="Refresh sessions" className="size-8">
          <RefreshCw />
        </Button>
      </div>
    </footer>
  );
}

function SearchField({ query, onQueryChange }: { query: string; onQueryChange: (query: string) => void }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search sessions"
        aria-label="Search sessions"
        className="h-8 bg-background pl-8 text-xs"
      />
    </div>
  );
}

function NewSessionButton({ canLaunch, onLaunch }: { canLaunch: boolean; onLaunch: () => void }) {
  const unavailable = "New session unavailable while the manager is reconnecting";
  return (
    <Button
      size="sm"
      onClick={onLaunch}
      disabled={!canLaunch}
      aria-label={canLaunch ? "New session" : unavailable}
      title={canLaunch ? undefined : unavailable}
      className="h-8"
    >
      <Plus /> New session
    </Button>
  );
}

type NavigationPaneProps = Omit<SessionSidebarProps, "sessions" | "canLaunch"> & {
  sessions: NavigationSession[];
  scope: SessionScope;
  query: string;
  canLaunch: boolean;
  installAvailable: boolean;
};

function DesktopSessionPane({
  sessions,
  selectedId,
  scope,
  query,
  connection,
  actor,
  canLaunch,
  onQueryChange,
  onSelect,
  onLaunch,
  onRefresh,
  installAvailable,
  onInstall,
}: NavigationPaneProps & {
  onQueryChange: (query: string) => void;
}) {
  return (
    <div data-session-pane className="flex h-full min-h-0 w-[var(--session-list-width)] shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <header className="shrink-0 border-b border-sidebar-border p-3">
        <div className="mb-2 flex h-8 items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Sessions</h2>
          <NewSessionButton canLaunch={canLaunch} onLaunch={onLaunch} />
        </div>
        <SearchField query={query} onQueryChange={onQueryChange} />
      </header>
      <SessionList sessions={sessions} selectedId={selectedId} scope={scope} query={query} onSelect={onSelect} />
      <ConnectionFooter
        connection={connection}
        actor={actor}
        onRefresh={onRefresh}
        installAvailable={installAvailable}
        onInstall={onInstall}
      />
    </div>
  );
}

function MobileScopeTabs({
  scope,
  counts,
  onScopeChange,
}: {
  scope: SessionScope;
  counts: SessionScopeCounts;
  onScopeChange: (scope: SessionScope) => void;
}) {
  return (
    <nav className="overflow-x-auto px-3 pb-2 [scrollbar-width:none]" aria-label="Session scopes">
      <div className="flex min-w-max gap-1">
        {SCOPE_ITEMS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => onScopeChange(item.value)}
            aria-pressed={scope === item.value}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              scope === item.value ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
            )}
          >
            {item.label}
            <span className="text-[10px] tabular-nums opacity-75">{countLabel(counts[item.value])}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function MobileSidebarContents({
  sessions,
  selectedId,
  scope,
  counts,
  query,
  connection,
  actor,
  canLaunch,
  onScopeChange,
  onQueryChange,
  onSelect,
  onLaunch,
  onRefresh,
  installAvailable,
  onInstall,
}: NavigationPaneProps & {
  counts: SessionScopeCounts;
  onScopeChange: (scope: SessionScope) => void;
  onQueryChange: (query: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <header className="shrink-0 border-b border-sidebar-border px-3 pb-3 pt-3 pr-14">
        <div className="mb-3 flex h-9 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Activity className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Agent Manager</p>
            <p className="text-[10px] text-muted-foreground">{connectionLabel(connection)}</p>
          </div>
          <NewSessionButton canLaunch={canLaunch} onLaunch={onLaunch} />
        </div>
        <SearchField query={query} onQueryChange={onQueryChange} />
      </header>
      <MobileScopeTabs scope={scope} counts={counts} onScopeChange={onScopeChange} />
      <SessionList sessions={sessions} selectedId={selectedId} scope={scope} query={query} onSelect={onSelect} />
      <ConnectionFooter
        connection={connection}
        actor={actor}
        onRefresh={onRefresh}
        installAvailable={installAvailable}
        onInstall={onInstall}
      />
    </div>
  );
}

function currentScope(): SessionScope {
  return typeof window === "undefined" ? "all" : sessionScopeFromSearch(window.location.search);
}

export function SessionSidebar({ canLaunch = true, installAvailable = false, ...props }: SessionSidebarProps) {
  const [scope, setScopeState] = useState<SessionScope>(currentScope);
  const [query, setQuery] = useState("");
  const [railExpanded, setRailExpanded] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const counts = useMemo(() => countSessionScopes(props.sessions), [props.sessions]);
  const visibleSessions = useMemo(
    () => navigationSessions(props.sessions, scope, query),
    [props.sessions, query, scope],
  );

  useEffect(() => {
    const syncScope = () => setScopeState(currentScope());
    window.addEventListener("popstate", syncScope);
    return () => window.removeEventListener("popstate", syncScope);
  }, []);

  const setScope = useCallback((next: SessionScope) => {
    setScopeState(next);
    const search = searchWithSessionScope(window.location.search, next);
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${search}${window.location.hash}`,
    );
  }, []);

  const selectAndClose = (id: string) => {
    props.onSelect(id);
    setMobileOpen(false);
  };
  const launchAndClose = () => {
    if (!canLaunch) return;
    setMobileOpen(false);
    props.onLaunch();
  };

  return (
    <>
      <aside className="hidden h-dvh shrink-0 border-r border-sidebar-border min-[901px]:flex" aria-label="Agent navigation">
        <ScopeRail
          scope={scope}
          counts={counts}
          expanded={railExpanded}
          onScopeChange={setScope}
          onExpandedChange={setRailExpanded}
        />
        <DesktopSessionPane
          {...props}
          sessions={visibleSessions}
          scope={scope}
          query={query}
          canLaunch={canLaunch}
          installAvailable={installAvailable}
          onQueryChange={setQuery}
        />
      </aside>

      <div className="fixed left-3 top-3 z-40 min-[901px]:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button size="icon" variant="outline" aria-label="Open navigation">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[min(100vw,23rem)] max-w-none gap-0 p-0">
            <SheetTitle className="sr-only">Agent navigation</SheetTitle>
            <MobileSidebarContents
              {...props}
              sessions={visibleSessions}
              scope={scope}
              counts={counts}
              query={query}
              canLaunch={canLaunch}
              installAvailable={installAvailable}
              onScopeChange={setScope}
              onQueryChange={setQuery}
              onSelect={selectAndClose}
              onLaunch={launchAndClose}
            />
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}
