export type DiffLineKind = "context" | "add" | "remove" | "meta";

export interface ParsedDiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface ParsedDiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedDiffLine[];
}

export interface ParsedUnifiedDiff {
  kind: "parsed";
  oldPath: string | null;
  newPath: string | null;
  hunks: ParsedDiffHunk[];
  additions: number;
  removals: number;
}

export interface DiffMarker {
  kind: "marker";
  text: string;
}

export interface RawDiffFallback {
  kind: "raw";
  raw: string;
  reason: "malformed" | "budget" | "no-hunks";
}

export type DiffParseResult = ParsedUnifiedDiff | DiffMarker | RawDiffFallback;

export interface DiffParseLimits {
  maxBytes: number;
  maxLines: number;
  maxLineBytes: number;
}

export const DEFAULT_DIFF_LIMITS: DiffParseLimits = {
  maxBytes: 1_048_576,
  maxLines: 20_000,
  maxLineBytes: 131_072,
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u;
const MARKER = /^(?:Binary files? .* differ|GIT binary patch|Binary file|File (?:too large|is too large)|Submodule )/imu;

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function headerPath(line: string): string | null {
  const value = line.slice(4).split("\t", 1)[0]?.trim() ?? "";
  if (!value || value === "/dev/null") return null;
  return value.replace(/^[ab]\//u, "");
}

function raw(raw: string, reason: RawDiffFallback["reason"]): RawDiffFallback {
  return { kind: "raw", raw, reason };
}

export function parseUnifiedDiff(
  input: string,
  limits: DiffParseLimits = DEFAULT_DIFF_LIMITS,
): DiffParseResult {
  if (bytes(input) > limits.maxBytes) return raw(input, "budget");
  if (MARKER.test(input.trim())) return { kind: "marker", text: input.trim() };
  const lines = input.replaceAll("\r\n", "\n").split("\n");
  if (lines.length > limits.maxLines || lines.some((line) => bytes(line) > limits.maxLineBytes)) {
    return raw(input, "budget");
  }
  let oldPath: string | null = null;
  let newPath: string | null = null;
  const hunks: ParsedDiffHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith("--- ")) {
      oldPath = headerPath(line);
      index++;
      if (index >= lines.length || !lines[index]!.startsWith("+++ ")) return raw(input, "malformed");
      newPath = headerPath(lines[index]!);
      index++;
      continue;
    }
    if (!line.startsWith("@@ ")) {
      index++;
      continue;
    }
    const match = HUNK.exec(line);
    if (!match) return raw(input, "malformed");
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] ?? "1");
    const newStart = Number(match[3]);
    const newCount = Number(match[4] ?? "1");
    if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) return raw(input, "malformed");
    const hunk: ParsedDiffHunk = { header: line, oldStart, oldCount, newStart, newCount, lines: [] };
    let oldLine = oldStart;
    let newLine = newStart;
    let seenOld = 0;
    let seenNew = 0;
    index++;
    while (index < lines.length) {
      const body = lines[index]!;
      if (body.startsWith("@@ ") || body.startsWith("diff --git ") || body.startsWith("--- ")) break;
      if (body === "") {
        // A blank context line arrives as "" whenever trailing whitespace has
        // been stripped from " ". Read it as context only while this hunk still
        // owes lines; otherwise it is the empty tail left by the final newline.
        if (seenOld >= oldCount && seenNew >= newCount) {
          index++;
          break;
        }
        hunk.lines.push({ kind: "context", text: "", oldLine, newLine });
        oldLine++; newLine++; seenOld++; seenNew++;
        index++;
        continue;
      }
      const prefix = body[0];
      if (prefix === " ") {
        hunk.lines.push({ kind: "context", text: body.slice(1), oldLine, newLine });
        oldLine++; newLine++; seenOld++; seenNew++;
      } else if (prefix === "+") {
        hunk.lines.push({ kind: "add", text: body.slice(1), oldLine: null, newLine });
        newLine++; seenNew++;
      } else if (prefix === "-") {
        hunk.lines.push({ kind: "remove", text: body.slice(1), oldLine, newLine: null });
        oldLine++; seenOld++;
      } else if (prefix === "\\") {
        hunk.lines.push({ kind: "meta", text: body, oldLine: null, newLine: null });
      } else {
        return raw(input, "malformed");
      }
      index++;
    }
    if (seenOld !== oldCount || seenNew !== newCount) return raw(input, "malformed");
    hunks.push(hunk);
  }
  if (hunks.length === 0) return raw(input, "no-hunks");
  return {
    kind: "parsed",
    oldPath,
    newPath,
    hunks,
    additions: hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.kind === "add").length, 0),
    removals: hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.kind === "remove").length, 0),
  };
}

export interface SplitDiffRow {
  left: ParsedDiffLine | null;
  right: ParsedDiffLine | null;
}

/** Align consecutive removal/addition runs without claiming semantic pairing. */
export function splitRows(hunk: ParsedDiffHunk): SplitDiffRow[] {
  const result: SplitDiffRow[] = [];
  for (let index = 0; index < hunk.lines.length;) {
    const line = hunk.lines[index]!;
    if (line.kind === "context" || line.kind === "meta") {
      result.push({ left: line, right: line });
      index++;
      continue;
    }
    const removed: ParsedDiffLine[] = [];
    const added: ParsedDiffLine[] = [];
    while (index < hunk.lines.length && hunk.lines[index]!.kind === "remove") removed.push(hunk.lines[index++]!);
    while (index < hunk.lines.length && hunk.lines[index]!.kind === "add") added.push(hunk.lines[index++]!);
    // A generator can emit additions before removals; keep those honest too.
    if (removed.length === 0 && added.length === 0) {
      while (index < hunk.lines.length && hunk.lines[index]!.kind === "add") added.push(hunk.lines[index++]!);
    }
    for (let offset = 0; offset < Math.max(removed.length, added.length); offset++) {
      result.push({ left: removed[offset] ?? null, right: added[offset] ?? null });
    }
  }
  return result;
}

export function diffIdentityKey(sessionId: string, turnId: string, path: string, operation: string, diff: string): string {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(`${operation}\0${path}\0${diff}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return `${sessionId}:${turnId}:${path}:${(hash >>> 0).toString(16)}`;
}
