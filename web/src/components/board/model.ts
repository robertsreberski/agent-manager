import type { CockpitSessionView, WorkspaceIdentityView } from "../../lib/cockpit-view";

export type BoardState = "wants-you" | "working" | "failed" | "idle";
export type BoardScope = "all" | "wants-you" | "working" | "idle";

export interface BoardSession extends CockpitSessionView {
  boardState: BoardState;
  attentionExact: boolean;
  harnessLabel: "Claude" | "Codex";
  projectName: string;
  stateLine: string;
}

export interface BoardWorktree {
  key: string;
  identity: WorkspaceIdentityView | null;
  label: string;
  sessions: BoardSession[];
}

export interface BoardColumn {
  key: string;
  repoName: string;
  hostId: string;
  hostLabel: string;
  remote: boolean;
  latestAt: number;
  wantsYou: boolean;
  worktrees: BoardWorktree[];
}

export interface PhoneBoardBand {
  state: BoardState;
  label: string;
  sessions: BoardSession[];
}

export interface BoardModel {
  columns: BoardColumn[];
  bands: PhoneBoardBand[];
  counts: Record<BoardState | "all", number>;
  order: BoardOrderState;
}

export interface BoardStateOrder {
  state: BoardState;
  sessionIds: readonly string[];
}

export interface DesktopGroupOrder {
  columnKey: string;
  worktreeKey: string;
  states: readonly BoardStateOrder[];
}

/**
 * The last committed visible order. State buckets are retained independently so
 * an updated timestamp cannot move a card, while a real state transition can.
 */
export interface BoardOrderState {
  columns: {
    wantsYou: readonly string[];
    other: readonly string[];
  };
  desktopGroups: readonly DesktopGroupOrder[];
  phoneStates: readonly BoardStateOrder[];
}

export interface BuildBoardOptions {
  scope?: BoardScope;
  hostIds?: ReadonlySet<string>;
  previousOrder?: BoardOrderState;
  now?: number;
}

const STATE_ORDER: readonly BoardState[] = ["wants-you", "working", "failed", "idle"];

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function deriveBoardState(session: CockpitSessionView): BoardState {
  if (session.attention.length > 0) return "wants-you";
  if (session.activity === "running") return "working";
  if (session.activity === "failed") return "failed";
  return "idle";
}

export function isExactAttention(session: CockpitSessionView): boolean {
  return session.attention.some((item) => (
    item.requestId !== null && item.confidence === "exact" && item.respondable
  ));
}

function stateLine(session: CockpitSessionView, state: BoardState): string {
  if (session.todo?.current) return session.todo.current;
  if (state === "wants-you") {
    const exact = session.attention.find((item) => (
      item.requestId !== null && item.confidence === "exact" && item.respondable
    ));
    if (exact) return exact.summary ?? exact.label;
    return "Looks blocked — from transcript";
  }
  if (state === "working") return "Working";
  if (state === "failed") return "Failed";
  return session.activity === "completed" ? "Finished" : "Idle";
}

function projectName(session: CockpitSessionView): string {
  if (session.workspaceIdentity?.repoName) return session.workspaceIdentity.repoName;
  const path = session.cwd?.replace(/\/+$/u, "");
  return path?.split("/").filter(Boolean).at(-1) ?? "Unknown project";
}

export function toBoardSession(session: CockpitSessionView): BoardSession {
  const boardState = deriveBoardState(session);
  return {
    ...session,
    boardState,
    attentionExact: isExactAttention(session),
    harnessLabel: session.provider === "claude" ? "Claude" : "Codex",
    projectName: projectName(session),
    stateLine: stateLine(session, boardState),
  };
}

function fallbackRepoKey(session: CockpitSessionView): string {
  return `${session.hostId}:path:${session.cwd ?? "unknown"}`;
}

function repoColumnKey(session: CockpitSessionView): string | null {
  return session.workspaceIdentity
    ? `${session.hostId}:repo:${session.workspaceIdentity.repoRoot}`
    : null;
}

/**
 * Repository facts are resolved per source and can legitimately be missing for
 * one session in a workspace another session already identified (a slow or
 * budget-exhausted git probe). Indexing every identified path lets those
 * sessions join the existing column instead of opening a duplicate one for the
 * same repository. The index is built over the whole visible set first, so the
 * result never depends on session order.
 */
function identifiedColumnKeys(
  sessions: readonly CockpitSessionView[],
): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const session of sessions) {
    const key = repoColumnKey(session);
    const identity = session.workspaceIdentity;
    if (!key || !identity) continue;
    for (const path of [identity.repoRoot, identity.worktreePath]) {
      const existing = byPath.get(`${session.hostId}:${path}`);
      if (existing === undefined || key < existing) {
        byPath.set(`${session.hostId}:${path}`, key);
      }
    }
  }
  return byPath;
}

function columnKey(
  session: CockpitSessionView,
  identified: ReadonlyMap<string, string>,
): string {
  return repoColumnKey(session)
    ?? (session.cwd ? identified.get(`${session.hostId}:${session.cwd}`) : undefined)
    ?? fallbackRepoKey(session);
}

function worktreeKey(session: CockpitSessionView): string {
  return session.workspaceIdentity?.worktreePath ?? session.cwd ?? "unknown";
}

function fallbackName(session: CockpitSessionView): string {
  const path = session.cwd?.replace(/\/+$/u, "") ?? "Unknown workspace";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function worktreeLabel(session: CockpitSessionView): string {
  const identity = session.workspaceIdentity;
  return identity?.branch ?? (identity?.detached ? "detached" : fallbackName(session));
}

function sortSessionsWithinState(left: BoardSession, right: BoardSession): number {
  const timeDelta = timestamp(right.updatedAt) - timestamp(left.updatedAt);
  return timeDelta || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function reconcileOrder<T>(
  items: readonly T[],
  id: (item: T) => string,
  previousIds: readonly string[] | undefined,
  initialCompare: (left: T, right: T) => number,
): T[] {
  if (!previousIds) return [...items].sort(initialCompare);
  const itemsById = new Map(items.map((item) => [id(item), item]));
  const retained: T[] = [];
  const seen = new Set<string>();
  for (const previousId of previousIds) {
    const item = itemsById.get(previousId);
    if (!item || seen.has(previousId)) continue;
    seen.add(previousId);
    retained.push(item);
  }
  const added = items.filter((item) => !seen.has(id(item))).sort(initialCompare);
  return [...retained, ...added];
}

function stateIds(previous: readonly BoardStateOrder[] | undefined, state: BoardState): readonly string[] | undefined {
  return previous?.find((entry) => entry.state === state)?.sessionIds;
}

function reconcileSessionStates(
  sessions: readonly BoardSession[],
  previous: readonly BoardStateOrder[] | undefined,
): { sessions: BoardSession[]; states: BoardStateOrder[] } {
  const ordered: BoardSession[] = [];
  const states: BoardStateOrder[] = [];
  for (const state of STATE_ORDER) {
    const stateSessions = reconcileOrder(
      sessions.filter((session) => session.boardState === state),
      (session) => session.id,
      stateIds(previous, state),
      sortSessionsWithinState,
    );
    if (stateSessions.length === 0) continue;
    ordered.push(...stateSessions);
    states.push({ state, sessionIds: stateSessions.map((session) => session.id) });
  }
  return { sessions: ordered, states };
}

function previousDesktopGroup(
  previous: readonly DesktopGroupOrder[] | undefined,
  columnKey: string,
  worktreeKey: string,
): DesktopGroupOrder | undefined {
  return previous?.find((group) => group.columnKey === columnKey && group.worktreeKey === worktreeKey);
}

export function buildBoard(
  sessions: readonly CockpitSessionView[],
  options: BuildBoardOptions = {},
): BoardModel {
  const visibleByHost = sessions.filter((session) => (
    !options.hostIds || options.hostIds.size === 0 || options.hostIds.has(session.hostId)
  ));
  const enriched = visibleByHost.map(toBoardSession);
  const counts = enriched.reduce<Record<BoardState | "all", number>>((result, session) => {
    result.all += 1;
    result[session.boardState] += 1;
    return result;
  }, { all: 0, "wants-you": 0, working: 0, failed: 0, idle: 0 });
  // Failed has distinct card semantics but belongs to the operator's Idle
  // filter and phone band; there is deliberately no fifth filter.
  counts.idle += counts.failed;
  const scoped = options.scope && options.scope !== "all"
    ? enriched.filter((session) => options.scope === "idle"
      ? session.boardState === "idle" || session.boardState === "failed"
      : session.boardState === options.scope)
    : enriched;

  const columnMap = new Map<string, BoardColumn>();
  const groupMaps = new Map<string, Map<string, BoardWorktree>>();
  const identified = identifiedColumnKeys(scoped);
  for (const session of scoped) {
    const key = columnKey(session, identified);
    let column = columnMap.get(key);
    if (!column) {
      column = {
        key,
        repoName: session.workspaceIdentity?.repoName ?? fallbackName(session),
        hostId: session.hostId,
        hostLabel: session.hostLabel,
        remote: session.remote,
        latestAt: 0,
        wantsYou: false,
        worktrees: [],
      };
      columnMap.set(key, column);
      groupMaps.set(key, new Map());
    } else if (session.workspaceIdentity) {
      // A column opened by a session without git facts adopts them as soon as
      // any session in the same repository supplies them.
      column.repoName = session.workspaceIdentity.repoName;
    }
    column.latestAt = Math.max(column.latestAt, timestamp(session.updatedAt));
    column.wantsYou ||= session.boardState === "wants-you";
    const groups = groupMaps.get(key)!;
    const groupKey = worktreeKey(session);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        key: groupKey,
        identity: session.workspaceIdentity,
        sessions: [],
        label: worktreeLabel(session),
      };
      groups.set(groupKey, group);
      column.worktrees.push(group);
    } else if (!group.identity && session.workspaceIdentity) {
      group.identity = session.workspaceIdentity;
      group.label = worktreeLabel(session);
    }
    group.sessions.push(session);
  }

  const desktopGroups: DesktopGroupOrder[] = [];
  let columns = [...columnMap.values()];
  for (const column of columns) {
    const hasExactProjectName = column.worktrees.some((group) => group.identity !== null);
    column.worktrees.sort((left, right) => {
      const mainDelta = Number(Boolean(left.identity?.linked)) - Number(Boolean(right.identity?.linked));
      return mainDelta || left.label.localeCompare(right.label) || left.key.localeCompare(right.key);
    });
    for (const group of column.worktrees) {
      // An identity-less session can share a column with a session whose git
      // probe resolved the repository. Both card presentations use these same
      // objects, so adopting the column's exact name here keeps desktop and
      // phone labels aligned without deriving a second project identity.
      if (hasExactProjectName) {
        for (const session of group.sessions) session.projectName = column.repoName;
      }
      const reconciled = reconcileSessionStates(
        group.sessions,
        previousDesktopGroup(options.previousOrder?.desktopGroups, column.key, group.key)?.states,
      );
      group.sessions = reconciled.sessions;
      desktopGroups.push({ columnKey: column.key, worktreeKey: group.key, states: reconciled.states });
    }
  }
  const compareColumns = (left: BoardColumn, right: BoardColumn) => right.latestAt - left.latestAt
      || left.repoName.localeCompare(right.repoName)
      || left.key.localeCompare(right.key);
  const wantsYouColumns = reconcileOrder(
    columns.filter((column) => column.wantsYou),
    (column) => column.key,
    options.previousOrder?.columns.wantsYou,
    compareColumns,
  );
  const otherColumns = reconcileOrder(
    columns.filter((column) => !column.wantsYou),
    (column) => column.key,
    options.previousOrder?.columns.other,
    compareColumns,
  );
  columns = [...wantsYouColumns, ...otherColumns];

  // Phone is a second presentation of the same visible board, not a separate
  // unfiltered session list. Reconcile only the host- and scope-filtered set so
  // changing either filter cannot leave hidden sessions in a phone band.
  const phoneOrder = reconcileSessionStates(scoped, options.previousOrder?.phoneStates);
  const phoneBands: PhoneBoardBand[] = [
    { state: "wants-you", label: "Wants you", sessions: phoneOrder.sessions.filter((session) => session.boardState === "wants-you") },
    { state: "working", label: "Working", sessions: phoneOrder.sessions.filter((session) => session.boardState === "working") },
    { state: "idle", label: "Idle", sessions: phoneOrder.sessions.filter((session) => session.boardState === "failed" || session.boardState === "idle") },
  ];
  const bands = phoneBands.filter((band) => band.sessions.length > 0);
  return {
    columns,
    bands,
    counts,
    order: {
      columns: {
        wantsYou: wantsYouColumns.map((column) => column.key),
        other: otherColumns.map((column) => column.key),
      },
      desktopGroups,
      phoneStates: phoneOrder.states,
    },
  };
}
