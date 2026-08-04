import type { BoardState } from "../board/model";

export type PaletteKind = "session" | "command" | "transcript" | "file" | "slash" | "host" | "worktree";

export interface PaletteEntry {
  id: string;
  kind: PaletteKind;
  label: string;
  detail: string | null;
  keywords: readonly string[];
  boardState?: BoardState;
  progress?: { completed: number; total: number };
  disabledReason?: string | null;
  payload?: unknown;
}

export interface PaletteSources {
  sessions: readonly PaletteEntry[];
  commands: readonly PaletteEntry[];
  transcripts: readonly PaletteEntry[];
  files: readonly PaletteEntry[];
  slash: readonly PaletteEntry[];
  hosts: readonly PaletteEntry[];
  worktrees: readonly PaletteEntry[];
}

export const EMPTY_PALETTE_SOURCES: PaletteSources = {
  sessions: [], commands: [], transcripts: [], files: [], slash: [], hosts: [], worktrees: [],
};

const PREFIX: Readonly<Record<string, PaletteKind | "location">> = {
  ">": "command",
  "@": "file",
  "/": "slash",
  "#": "transcript",
  "~": "location",
};

const KIND_ORDER: Record<PaletteKind, number> = {
  session: 0, command: 1, host: 2, worktree: 3, slash: 4, file: 5, transcript: 6,
};

const STATE_ORDER: Record<BoardState, number> = {
  "wants-you": 0, working: 1, failed: 2, idle: 3,
};

function haystack(entry: PaletteEntry): string {
  return [entry.label, entry.detail, ...entry.keywords].filter(Boolean).join(" ").toLocaleLowerCase();
}

function score(entry: PaletteEntry, query: string): number {
  if (!query) return 0;
  const normalized = query.toLocaleLowerCase();
  const label = entry.label.toLocaleLowerCase();
  if (label === normalized) return 0;
  if (label.startsWith(normalized)) return 1;
  if (label.includes(normalized)) return 2;
  const words = normalized.split(/\s+/u).filter(Boolean);
  return words.every((word) => haystack(entry).includes(word)) ? 3 : Number.POSITIVE_INFINITY;
}

export function paletteResults(sources: PaletteSources, input: string, limit = 60): PaletteEntry[] {
  const trimmed = input.trimStart();
  const prefix = PREFIX[trimmed[0] ?? ""];
  const query = prefix ? trimmed.slice(1).trim() : trimmed.trim();
  const candidates = prefix
    ? prefix === "command"
      ? sources.commands
      : prefix === "location"
        ? [...sources.hosts, ...sources.worktrees]
        : sources[prefix === "file" ? "files" : prefix === "slash" ? "slash" : "transcripts"]
    : [...sources.sessions, ...sources.commands];
  return candidates
    .map((entry) => ({ entry, score: score(entry, query) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => left.score - right.score
      || (left.entry.kind === "session" && right.entry.kind === "session"
        ? STATE_ORDER[left.entry.boardState ?? "idle"] - STATE_ORDER[right.entry.boardState ?? "idle"]
        : KIND_ORDER[left.entry.kind] - KIND_ORDER[right.entry.kind])
      || left.entry.label.localeCompare(right.entry.label)
      || left.entry.id.localeCompare(right.entry.id))
    .slice(0, Math.max(0, limit))
    .map((item) => item.entry);
}

export function groupPaletteResults(entries: readonly PaletteEntry[]): Array<{ kind: PaletteKind; entries: PaletteEntry[] }> {
  const map = new Map<PaletteKind, PaletteEntry[]>();
  for (const entry of entries) {
    const group = map.get(entry.kind) ?? [];
    group.push(entry);
    map.set(entry.kind, group);
  }
  return [...map].map(([kind, grouped]) => ({ kind, entries: grouped }));
}
