export const CREATE_ATTEMPT_STORAGE_KEY = "agent-manager:create-attempt:v1";

export interface PersistedCreateAttempt {
  fingerprint: string;
  key: string;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export async function createAttemptFingerprint(value: unknown): Promise<string> {
  const serialized = JSON.stringify(value);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Secure browser hashing is unavailable");
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

export function loadCreateAttempt(): PersistedCreateAttempt | null {
  try {
    const raw = storage()?.getItem(CREATE_ATTEMPT_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const attempt = value as Record<string, unknown>;
    return typeof attempt.fingerprint === "string" &&
        attempt.fingerprint.startsWith("sha256:") &&
        typeof attempt.key === "string" && attempt.key.length > 0
      ? { fingerprint: attempt.fingerprint, key: attempt.key }
      : null;
  } catch {
    return null;
  }
}

export function saveCreateAttempt(attempt: PersistedCreateAttempt): void {
  try {
    storage()?.setItem(CREATE_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
  } catch {
    // Storage can be disabled; the in-memory attempt still protects retries in
    // the current mount.
  }
}

export function clearCreateAttempt(expectedKey?: string): void {
  try {
    const target = storage();
    if (!target) return;
    if (expectedKey) {
      const current = loadCreateAttempt();
      if (current && current.key !== expectedKey) return;
    }
    target.removeItem(CREATE_ATTEMPT_STORAGE_KEY);
  } catch {
    // Best effort only. A mismatched fingerprint is never reused in memory.
  }
}
