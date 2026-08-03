import type { ActivityJsonValue } from "./types.ts";

export const REDACTED_ACTIVITY_VALUE = "[REDACTED]";

const SECRET_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|secret|client[-_]?secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key|private[-_]?key|credential|session[-_]?key)$/i;

const UNSAFE_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const TEXT_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/g,
  /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /((?:^|[\s,{;])(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|secret|client[-_]?secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key|private[-_]?key|credential|session[-_]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gim,
  /("(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|secret|client[-_]?secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key|private[-_]?key|credential|session[-_]?key)"\s*:\s*)"(?:\\.|[^"\\])*"/gim,
];

/** Removes invisible terminal controls and Unicode bidi overrides while retaining line breaks and tabs. */
export function stripUnsafeControlCharacters(value: string): string {
  return value.replace(UNSAFE_CONTROL_CHARACTERS, "");
}

/**
 * Applies defense-in-depth token scanning to display text. Structured values
 * should additionally pass through {@link redactActivityJson} so secret-shaped
 * object keys never depend on a token format being recognized.
 */
export function redactActivityText(value: string): string {
  let redacted = stripUnsafeControlCharacters(value);
  for (const pattern of TEXT_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match: string, prefix?: string) => {
      if (typeof prefix === "string" && prefix.length > 0) {
        const quoted = match.startsWith('"');
        return `${prefix}${quoted ? `"${REDACTED_ACTIVITY_VALUE}"` : REDACTED_ACTIVITY_VALUE}`;
      }
      return REDACTED_ACTIVITY_VALUE;
    });
  }
  return redacted;
}

/** Produces a fresh, JSON-safe value with secret keys and token-shaped strings redacted. */
export function redactActivityJson<T extends ActivityJsonValue>(value: T): T {
  return redactJsonValue(value) as T;
}

function redactJsonValue(value: ActivityJsonValue): ActivityJsonValue {
  if (typeof value === "string") return redactActivityText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => redactJsonValue(entry));

  const redacted: Record<string, ActivityJsonValue> = {};
  for (const [rawKey, entry] of Object.entries(value)) {
    const key = stripUnsafeControlCharacters(rawKey);
    redacted[key] = SECRET_KEY.test(key)
      ? REDACTED_ACTIVITY_VALUE
      : redactJsonValue(entry);
  }
  return redacted;
}
