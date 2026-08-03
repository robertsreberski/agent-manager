import { useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  Bot,
  CircleUserRound,
  Menu,
  Plus,
  RefreshCw,
  Search,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "./ui/sheet";
import { ActivityBadge, AttentionBadge, ModeBadge, OwnershipBadge, ProviderBadge } from "./session-badges";
import { cn, formatRelativeTime } from "../lib/utils";
import type { ConnectionState, SessionFilter, SessionView } from "../types";

const FILTERS: Array<{ value: SessionFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs you" },
  { value: "running", label: "Running" },
  { value: "managed", label: "Managed" },
  { value: "external", label: "External" },
];

function matchesFilter(session: SessionView, filter: SessionFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "attention":
      return session.attention.length > 0;
    case "running":
      return session.activity === "running";
    case "managed":
      return session.ownership === "manager";
    case "external":
      return session.ownership === "external";
  }
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: SessionView;
  selected: boolean;
  onSelect: () => void;
}) {
  const displayName = session.name || session.cwd?.split("/").filter(Boolean).at(-1) || `${session.provider} session`;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "group w-full rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-sidebar-border bg-sidebar-accent shadow-sm",
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <div className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-background",
          session.provider === "codex" ? "text-emerald-600" : "text-orange-600",
        )}>
          <Bot className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium">{displayName}</p>
            <time className="shrink-0 text-[10px] text-muted-foreground" dateTime={session.updatedAt ?? undefined}>
              {formatRelativeTime(session.updatedAt)}
            </time>
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={session.cwd ?? session.id}>
            {session.cwd ?? session.id}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <ProviderBadge provider={session.provider} />
            <OwnershipBadge ownership={session.ownership} />
            <ActivityBadge activity={session.activity} compact />
            <ModeBadge mode={session.mode.value} />
            <AttentionBadge count={session.attention.length} />
          </div>
        </div>
      </div>
    </button>
  );
}

function SidebarContents({
  sessions,
  selectedId,
  connection,
  actor,
  onSelect,
  onLaunch,
  onRefresh,
  reserveCloseSpace = false,
}: {
  sessions: SessionView[];
  selectedId: string | null;
  connection: ConnectionState;
  actor: string | null;
  onSelect: (id: string) => void;
  onLaunch: () => void;
  onRefresh: () => void;
  reserveCloseSpace?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("all");
  const visibleSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (!matchesFilter(session, filter)) return false;
      if (!needle) return true;
      return [session.name, session.cwd, session.id, session.provider]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [filter, query, sessions]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <header className={cn(
        "border-b border-sidebar-border py-4 pl-4",
        reserveCloseSpace ? "pr-14" : "pr-4",
      )}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <Activity className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">Agent Manager</h1>
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                {connection === "open" ? <Wifi className="size-3 text-emerald-500" /> : <WifiOff className="size-3 text-amber-500" />}
                {connection === "open" ? "Live" : connection === "retrying" ? "Reconnecting" : connection}
              </p>
            </div>
          </div>
          <Button size="icon" onClick={onLaunch} aria-label="Launch managed session">
            <Plus />
          </Button>
        </div>

        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions"
            aria-label="Search sessions"
            className="bg-background pl-8"
          />
        </div>
        <div className="mt-2 flex gap-1 overflow-x-auto pb-1" role="group" aria-label="Session filters">
          {FILTERS.map((item) => (
            <Button
              key={item.value}
              size="sm"
              variant={filter === item.value ? "secondary" : "ghost"}
              onClick={() => setFilter(item.value)}
              aria-pressed={filter === item.value}
              className="h-7 px-2.5"
            >
              {item.label}
            </Button>
          ))}
        </div>
      </header>

      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Agent sessions">
        {visibleSessions.length > 0 ? (
          <div className="space-y-1">
            {visibleSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                selected={session.id === selectedId}
                onSelect={() => onSelect(session.id)}
              />
            ))}
          </div>
        ) : (
          <div className="m-2 rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            <AlertCircle className="mx-auto mb-2 size-5" />
            No matching sessions.
          </div>
        )}
      </nav>

      <footer className="flex items-center justify-between gap-2 border-t border-sidebar-border px-3 py-2.5 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5">
          <CircleUserRound className="size-3.5 shrink-0" />
          <span className="truncate">{actor || "Local browser"}</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onRefresh} aria-label="Refresh sessions" className="size-8">
          <RefreshCw />
        </Button>
      </footer>
    </div>
  );
}

export function SessionSidebar(props: React.ComponentProps<typeof SidebarContents>) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const selectAndClose = (id: string) => {
    props.onSelect(id);
    setMobileOpen(false);
  };
  return (
    <>
      <aside className="hidden h-dvh w-[22rem] shrink-0 border-r md:block">
        <SidebarContents {...props} />
      </aside>
      <div className="fixed left-3 top-3 z-40 md:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button size="icon" variant="outline" aria-label="Open sessions">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[min(92vw,22rem)] p-0">
            <SheetTitle className="sr-only">Agent sessions</SheetTitle>
            <SidebarContents {...props} onSelect={selectAndClose} reserveCloseSpace />
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}
