/**
 * Activity cursors are opaque to clients, but bind their replay position to
 * both the server stream epoch and the selected session. This prevents a
 * cursor from one session being interpreted as a valid offset in another.
 */
export function encodeActivityCursor(
  streamEpoch: string,
  sessionId: string,
  sequence: number,
): string {
  return `${streamEpoch}:${encodeURIComponent(sessionId)}:${sequence}`;
}

export function parseActivityCursor(
  cursor: string,
  streamEpoch: string,
  sessionId: string,
): number | null {
  const prefix = `${streamEpoch}:${encodeURIComponent(sessionId)}:`;
  if (!cursor.startsWith(prefix)) return null;
  const sequence = Number(cursor.slice(prefix.length));
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}
