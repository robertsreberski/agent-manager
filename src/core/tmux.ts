import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

import type {
  Diagnostic,
  ProcessInfo,
  Runtime,
  SessionRecord,
  SessionTerminal,
} from "./types.ts";

const FIELD_SEPARATOR = "\u001f";
const MAX_CONFIGURED_SOCKET_NAMES = 16;
const MAX_DISCOVERED_SOCKET_PATHS = 32;
const MAX_TMUX_PROBES = 16;
const TMUX_PROBE_TIMEOUT_MS = 750;
const TMUX_DISCOVERY_BUDGET_MS = 3_000;
const TMUX_FORMAT = [
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_index}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_tty}",
  "#{session_attached}",
].join(FIELD_SEPARATOR);

interface SocketCandidate {
  socketName: string | null;
  socketPath: string | null;
  selector: string[];
  explicit: boolean;
}

function canonicalSocketPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

export interface TmuxPane {
  socketName: string | null;
  socketPath: string | null;
  session: string;
  window: string;
  windowIndex: number;
  paneIndex: number;
  paneId: string;
  panePid: number;
  tty: string | null;
  attachedClients: number;
}

export interface TmuxDiscoveryResult {
  panes: TmuxPane[];
  diagnostics: Diagnostic[];
}

function socketCandidates(runtime: Runtime): SocketCandidate[] {
  const candidates: SocketCandidate[] = [{
    socketName: "default",
    socketPath: null,
    selector: [],
    explicit: false,
  }];
  const seen = new Set<string>(["default"]);

  const currentSocket = runtime.env.TMUX?.split(",", 1)[0]?.trim();
  if (currentSocket && safeOwnedSocket(currentSocket)) {
    const socketPath = canonicalSocketPath(currentSocket);
    seen.add(`path:${socketPath}`);
    candidates.push({
      socketName: basename(socketPath),
      socketPath,
      selector: ["-S", socketPath],
      explicit: true,
    });
  }

  const configuredNames = runtime.env.AGENT_MANAGER_TMUX_SOCKETS
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 128 && !value.includes("/"))
    .slice(0, MAX_CONFIGURED_SOCKET_NAMES) ?? [];
  for (const name of configuredNames) {
    const key = `name:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      socketName: name,
      socketPath: null,
      selector: ["-L", name],
      explicit: true,
    });
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const directories = new Set<string>();
  if (runtime.env.TMUX_TMPDIR && uid !== null) {
    // TMUX_TMPDIR names the parent; tmux itself creates the private
    // per-account tmux-$UID directory below it. Never enumerate the broad
    // parent, which is commonly shared and attacker-writable.
    directories.add(join(runtime.env.TMUX_TMPDIR, `tmux-${uid}`));
  }
  if (uid !== null) {
    directories.add(`/private/tmp/tmux-${uid}`);
    directories.add(`/tmp/tmux-${uid}`);
  }

  for (const directory of directories) {
    if (!existsSync(directory) || !safePrivateDirectory(directory, uid)) continue;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    let accepted = 0;
    for (const entry of entries) {
      if (accepted >= MAX_DISCOVERED_SOCKET_PATHS) break;
      const candidatePath = join(directory, entry.name);
      if (!safeOwnedSocket(candidatePath, uid)) continue;
      const socketPath = canonicalSocketPath(candidatePath);
      const key = `path:${socketPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        socketName: entry.name,
        socketPath,
        selector: ["-S", socketPath],
        explicit: true,
      });
      accepted += 1;
    }
  }
  const pathNames = new Set(
    candidates
      .filter((candidate) => candidate.socketPath !== null)
      .map((candidate) => candidate.socketName),
  );
  return candidates.filter((candidate) => {
    if (candidate.socketPath !== null) return true;
    // A discovered path identifies the same server more precisely than the
    // implicit default or configured -L alias and avoids ambiguous duplicates.
    return !candidate.socketName || !pathNames.has(candidate.socketName);
  });
}

function safePrivateDirectory(path: string, uid: number | null): boolean {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink()
      && stat.isDirectory()
      && (uid === null || stat.uid === uid)
      && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function safeOwnedSocket(path: string, uid = typeof process.getuid === "function" ? process.getuid() : null): boolean {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink()
      && stat.isSocket()
      && (uid === null || stat.uid === uid);
  } catch {
    return false;
  }
}

export function parseTmuxPanes(
  output: string,
  socketName: string | null,
  socketPath: string | null,
): TmuxPane[] {
  const panes: TmuxPane[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const fields = line.split(FIELD_SEPARATOR);
    if (fields.length !== 8) continue;
    const [session, windowIndexValue, window, paneIndexValue, paneId, panePidValue, ttyValue, attachedValue] = fields;
    const windowIndex = Number(windowIndexValue);
    const paneIndex = Number(paneIndexValue);
    const panePid = Number(panePidValue);
    const attachedClients = Number(attachedValue);
    if (
      !session ||
      !window ||
      !paneId ||
      !Number.isSafeInteger(windowIndex) ||
      !Number.isSafeInteger(paneIndex) ||
      !Number.isSafeInteger(panePid) ||
      panePid <= 0
    ) {
      continue;
    }
    panes.push({
      socketName,
      socketPath,
      session,
      window,
      windowIndex,
      paneIndex,
      paneId,
      panePid,
      tty: normalizeTty(ttyValue ?? null),
      attachedClients: Number.isSafeInteger(attachedClients) && attachedClients >= 0
        ? attachedClients
        : 0,
    });
  }
  return panes;
}

export function discoverTmuxPanes(runtime: Runtime): TmuxDiscoveryResult {
  const diagnostics: Diagnostic[] = [];
  const panes: TmuxPane[] = [];
  const seen = new Set<string>();
  const deadline = runtime.now() + TMUX_DISCOVERY_BUDGET_MS;
  const candidates = socketCandidates(runtime)
    .sort((left, right) => {
      const priority = (candidate: SocketCandidate): number =>
        candidate.socketPath !== null ? 0 : candidate.selector[0] === "-L" ? 1 : 2;
      return priority(left) - priority(right);
    })
    .slice(0, MAX_TMUX_PROBES);
  const tmuxExecutable = runtime.env.AGENT_MANAGER_TMUX_EXECUTABLE?.trim() || "tmux";

  for (const candidate of candidates) {
    const remaining = deadline - runtime.now();
    if (remaining <= 0) {
      diagnostics.push({
        provider: "system",
        level: "warning",
        message: "Stopped tmux discovery after reaching its bounded probe budget",
      });
      break;
    }
    const result = runtime.run(
      tmuxExecutable,
      [...candidate.selector, "list-panes", "-a", "-F", TMUX_FORMAT],
      Math.min(TMUX_PROBE_TIMEOUT_MS, remaining),
    );
    if (result.status !== 0 || result.error) {
      if (candidate.explicit) {
        const message = result.error?.message ?? result.stderr.trim();
        diagnostics.push({
          provider: "system",
          level: "warning",
          message: `Could not inspect tmux socket ${candidate.socketPath ?? candidate.socketName ?? "unknown"}: ${message || "command failed"}`,
        });
      }
      continue;
    }
    for (const pane of parseTmuxPanes(result.stdout, candidate.socketName, candidate.socketPath)) {
      const key = `${pane.socketPath ?? pane.socketName ?? "default"}:${pane.paneId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      panes.push(pane);
    }
  }

  return { panes, diagnostics };
}

function normalizeTty(value: string | null): string | null {
  const normalized = value?.trim().replace(/^\/dev\//, "") ?? "";
  return normalized && normalized !== "?" && normalized !== "-" ? normalized : null;
}

function processDescendsFrom(
  pid: number,
  ancestorPid: number,
  processMap: Map<number, ProcessInfo>,
): boolean {
  let current = processMap.get(pid) ?? null;
  const visited = new Set<number>();
  while (current && current.pid > 1 && !visited.has(current.pid)) {
    if (current.pid === ancestorPid || current.ppid === ancestorPid) return true;
    visited.add(current.pid);
    current = processMap.get(current.ppid) ?? null;
  }
  return false;
}

function uniquePane(candidates: TmuxPane[]): TmuxPane | null {
  const byPane = new Map<string, TmuxPane>();
  for (const pane of candidates) {
    byPane.set(`${pane.socketPath ?? pane.socketName ?? "default"}:${pane.paneId}`, pane);
  }
  return byPane.size === 1 ? [...byPane.values()][0] ?? null : null;
}

export function matchSessionToTmuxPane(
  record: SessionRecord,
  panes: TmuxPane[],
  processes: ProcessInfo[],
  sharedPids: ReadonlySet<number> = new Set(),
): TmuxPane | null {
  const processMap = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  const candidatePids = [record.pid, record.runtimePid]
    .filter((pid): pid is number => pid !== null && !sharedPids.has(pid));

  for (const pid of candidatePids) {
    const exact = uniquePane(panes.filter((pane) => pane.panePid === pid));
    if (exact) return exact;
    if (panes.some((pane) => pane.panePid === pid)) return null;

    const processInfo = processMap.get(pid);
    const tty = normalizeTty(processInfo?.tty ?? null);
    if (tty) {
      const byTty = uniquePane(panes.filter((pane) => pane.tty === tty));
      if (byTty) return byTty;
      if (panes.some((pane) => pane.tty === tty)) return null;
    }

    const byAncestry = uniquePane(
      panes.filter((pane) => processDescendsFrom(pid, pane.panePid, processMap)),
    );
    if (byAncestry) return byAncestry;
    if (panes.some((pane) => processDescendsFrom(pid, pane.panePid, processMap))) return null;
  }
  return null;
}

function terminalFromPane(pane: TmuxPane): SessionTerminal {
  return {
    attachAvailable: true,
    socketName: pane.socketName,
    socketPath: pane.socketPath,
    session: pane.session,
    window: pane.window,
    windowIndex: pane.windowIndex,
    paneIndex: pane.paneIndex,
    paneId: pane.paneId,
    tty: pane.tty,
    attachedClients: pane.attachedClients,
  };
}

export function attachTmuxTerminals(
  records: SessionRecord[],
  panes: TmuxPane[],
  processes: ProcessInfo[],
): SessionRecord[] {
  const pidCounts = new Map<number, number>();
  for (const record of records) {
    if (record.hostId !== "local") continue;
    for (const pid of new Set([record.pid, record.runtimePid].filter((value): value is number => value !== null))) {
      pidCounts.set(pid, (pidCounts.get(pid) ?? 0) + 1);
    }
  }
  const sharedPids = new Set(
    [...pidCounts].filter(([, count]) => count > 1).map(([pid]) => pid),
  );

  return records.map((record) => {
    // This process table and these panes belong to the local discovery worker.
    // Remote terminals are projected by their remote host and must never be
    // correlated against local pid/tty/socket facts.
    if (record.hostId !== "local") return record;
    const pane = matchSessionToTmuxPane(record, panes, processes, sharedPids);
    if (!pane) return record;
    const control = record.control.plane === "observe-only"
      ? {
          plane: "tmux-attach" as const,
          authority: "foreign" as const,
          coordination: {
            mode: "observe-only" as const,
            nativeAttach: "none" as const,
            responseResolution: "single-controller" as const,
          },
          recovery: null,
          capabilities: ["preview", "attach"] as const,
          withheld: record.control.withheld,
          takeover: record.control.takeover,
        }
      : record.control;
    return {
      ...record,
      terminal: terminalFromPane(pane),
      control: {
        ...control,
        capabilities: [...control.capabilities],
      },
    };
  });
}
