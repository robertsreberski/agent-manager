import type { SessionRecord } from "../../../src/shared/session.ts";
import type { WireStateSnapshot } from "../../../src/shared/wire.ts";
import {
  parseSessionRecord as parseSharedSessionRecord,
  parseStateSnapshot,
} from "../../../src/shared/wire.ts";

/** Parse one exact current-epoch session record. No aliases or defaults exist. */
export function parseSessionRecord(value: unknown): SessionRecord {
  return parseSharedSessionRecord(value);
}

/** Parse one exact current-epoch state snapshot. */
export function parseSnapshot(value: unknown): WireStateSnapshot {
  return parseStateSnapshot(value);
}
