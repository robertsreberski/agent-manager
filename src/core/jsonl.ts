import {
  closeSync,
  openSync,
  readSync,
  statSync,
  type Stats,
} from "node:fs";

export interface JsonlCursor {
  identity: string;
  offset: number;
  remainder: string;
}

export interface IncrementalJsonlResult<T> {
  records: T[];
  cursor: JsonlCursor;
  reset: boolean;
  truncatedHistory: boolean;
  caughtUp: boolean;
}

export interface IncrementalJsonlOptions<T> {
  /** Initial tail window for a pre-existing large transcript. */
  initialTailBytes?: number;
  /** Maximum bytes consumed per reconciliation tick. */
  maxReadBytes?: number;
  parse?: (value: unknown) => T | null;
}

function fileIdentity(stat: Stats): string {
  return `${String(stat.dev)}:${String(stat.ino)}`;
}

/**
 * Reads only bytes appended since the previous cursor. Rotation/truncation is
 * detected from inode and size. A first read of a large historical file starts
 * at a bounded tail and reports `truncatedHistory`, allowing callers to lower
 * confidence instead of pretending the snapshot was exhaustive.
 */
export function readJsonlIncrementally<T = unknown>(
  file: string,
  previous: JsonlCursor | null = null,
  options: IncrementalJsonlOptions<T> = {},
): IncrementalJsonlResult<T> {
  const stat = statSync(file);
  const identity = fileIdentity(stat);
  const initialTailBytes = Math.max(1, options.initialTailBytes ?? 2 * 1024 * 1024);
  const maxReadBytes = Math.max(1, options.maxReadBytes ?? 2 * 1024 * 1024);
  const reset = previous === null || previous.identity !== identity || stat.size < previous.offset;
  const requestedStart = reset
    ? Math.max(0, stat.size - initialTailBytes)
    : previous.offset;
  const length = Math.min(maxReadBytes, Math.max(0, stat.size - requestedStart));
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  if (length > 0) {
    const descriptor = openSync(file, "r");
    try {
      bytesRead = readSync(descriptor, buffer, 0, length, requestedStart);
    } finally {
      closeSync(descriptor);
    }
  }

  let text = `${reset ? "" : previous?.remainder ?? ""}${buffer.subarray(0, bytesRead).toString("utf8")}`;
  if (reset && requestedStart > 0) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  }

  const lines = text.split("\n");
  const remainder = text.endsWith("\n") ? "" : lines.pop() ?? "";
  const parse = options.parse ?? ((value: unknown) => value as T);
  const records: T[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parse(JSON.parse(trimmed));
      if (parsed !== null) records.push(parsed);
    } catch {
      // One malformed provider line must not poison the following append.
    }
  }

  const offset = requestedStart + bytesRead;
  return {
    records,
    cursor: { identity, offset, remainder },
    reset,
    truncatedHistory: reset && requestedStart > 0,
    caughtUp: offset >= stat.size,
  };
}
