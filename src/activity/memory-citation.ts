import type { ActivityMemoryCitation } from "./types.ts";

const MAX_ENTRIES = 128;
const MAX_ROLLOUT_IDS = 128;
const MAX_PATH_CHARS = 4_096;
const MAX_NOTE_CHARS = 8_192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) return null;
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ? null : value;
}

/** Parse the exact structured citation object emitted by Codex App Server. */
export function parseMemoryCitation(value: unknown): ActivityMemoryCitation | null {
  const object = record(value);
  if (!object || !Array.isArray(object.entries) || !Array.isArray(object.rolloutIds)) return null;
  if (object.entries.length > MAX_ENTRIES || object.rolloutIds.length > MAX_ROLLOUT_IDS) return null;

  const entries = object.entries.flatMap((raw) => {
    const entry = record(raw);
    const path = safeText(entry?.path, MAX_PATH_CHARS);
    const note = safeText(entry?.note, MAX_NOTE_CHARS);
    const lineStart = entry?.lineStart;
    const lineEnd = entry?.lineEnd;
    return path && note && Number.isInteger(lineStart) && Number.isInteger(lineEnd)
        && (lineStart as number) >= 1 && (lineEnd as number) >= (lineStart as number)
      ? [{ path, lineStart: lineStart as number, lineEnd: lineEnd as number, note }]
      : [];
  });
  if (entries.length !== object.entries.length) return null;

  const rolloutIds = object.rolloutIds.flatMap((raw) => (
    typeof raw === "string" && UUID.test(raw) ? [raw] : []
  ));
  if (rolloutIds.length !== object.rolloutIds.length) return null;
  return { entries, rolloutIds };
}

function parseCitationLine(line: string): ActivityMemoryCitation["entries"][number] | null {
  const match = line.match(/^(.+):(\d+)-(\d+)\|note=\[([\s\S]*)\]$/u);
  if (!match) return null;
  const path = safeText(match[1], MAX_PATH_CHARS);
  const note = safeText(match[4], MAX_NOTE_CHARS);
  const lineStart = Number(match[2]);
  const lineEnd = Number(match[3]);
  return path && note && Number.isSafeInteger(lineStart) && Number.isSafeInteger(lineEnd)
      && lineStart >= 1 && lineEnd >= lineStart
    ? { path, lineStart, lineEnd, note }
    : null;
}

function lines(value: string): string[] {
  if (value.length === 0) return [];
  return value.split(/\r?\n/u);
}

function sectionLines(value: string): string[] {
  return lines(value.replace(/\r?\n$/u, ""));
}

/**
 * Extract only a strict trailing machine block. A block in prose or a code
 * example remains visible, and any malformed field makes the whole suffix
 * ordinary text rather than silently discarding it.
 */
export function extractTrailingMemoryCitation(text: string): {
  text: string;
  memoryCitation: ActivityMemoryCitation | null;
} {
  const marker = "<oai-mem-citation>";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0 || (markerIndex > 0 && text[markerIndex - 1] !== "\n")) {
    return { text, memoryCitation: null };
  }
  const suffix = text.slice(markerIndex);
  const match = suffix.match(
    /^<oai-mem-citation>\r?\n<citation_entries>\r?\n([\s\S]*?)<\/citation_entries>\r?\n<rollout_ids>\r?\n([\s\S]*?)<\/rollout_ids>\r?\n<\/oai-mem-citation>\s*$/u,
  );
  if (!match) return { text, memoryCitation: null };

  const entryLines = sectionLines(match[1] ?? "");
  const entries = entryLines.flatMap((line) => {
    const entry = parseCitationLine(line);
    return entry ? [entry] : [];
  });
  const rolloutLines = sectionLines(match[2] ?? "");
  const rolloutIds = rolloutLines.filter((line) => UUID.test(line));
  if (entries.length !== entryLines.length || rolloutIds.length !== rolloutLines.length
      || entries.length > MAX_ENTRIES || rolloutIds.length > MAX_ROLLOUT_IDS) {
    return { text, memoryCitation: null };
  }
  return {
    text: text.slice(0, markerIndex).trimEnd(),
    memoryCitation: { entries, rolloutIds },
  };
}
