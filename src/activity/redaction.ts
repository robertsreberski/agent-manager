import type { ActivityJsonValue } from "./types.ts";

export const REDACTED_ACTIVITY_VALUE = "[REDACTED]";

const SECRET_KEY_SUFFIXES = [
  "authorization",
  "proxy_authorization",
  "cookie",
  "set_cookie",
  "password",
  "passwd",
  "pwd",
  "secret",
  "client_secret",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "private_key",
  "credential",
  "credentials",
  "session_key",
  "secret_access_key",
] as const;

const UNSAFE_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const TEXT_SECRET_PATTERNS: readonly RegExp[] = [
  // Treat an unterminated PEM block as sensitive too. In a streaming field the
  // END marker can arrive much later than the key material.
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|$)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/g,
  /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
];

const ASSIGNMENT_START = /(^|[\s,{;])(?:"([^"\\\r\n]{1,128})"|([A-Za-z][A-Za-z0-9_.-]{0,127}))(\s*[=:]\s*)/gm;

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
    redacted = redacted.replace(pattern, REDACTED_ACTIVITY_VALUE);
  }
  return redactSecretAssignments(redacted);
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
    redacted[key] = isSecretActivityKey(key)
      ? REDACTED_ACTIVITY_VALUE
      : redactJsonValue(entry);
  }
  return redacted;
}

/**
 * Matches exact secret names and namespaced/environment-prefixed variants
 * without treating incidental substrings such as `token_count` as secrets.
 */
export function isSecretActivityKey(rawKey: string): boolean {
  const normalized = stripUnsafeControlCharacters(rawKey)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!normalized) return false;
  return SECRET_KEY_SUFFIXES.some((suffix) => (
    normalized === suffix || normalized.endsWith(`_${suffix}`)
  ));
}

function redactSecretAssignments(value: string): string {
  const candidates = [...value.matchAll(ASSIGNMENT_START)];
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  let coveredUntil = -1;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if ((candidate.index ?? 0) < coveredUntil) continue;
    const key = candidate[2] ?? candidate[3] ?? "";
    if (!isSecretActivityKey(key)) continue;

    const start = (candidate.index ?? 0) + candidate[0].length;
    const nextStart = candidates[index + 1]?.index ?? value.length;
    const { end, quoted } = assignmentValueEnd(value, start, nextStart);
    replacements.push({
      start,
      end,
      value: quoted ? `${quoted}${REDACTED_ACTIVITY_VALUE}${quoted}` : REDACTED_ACTIVITY_VALUE,
    });
    coveredUntil = end;
  }

  let redacted = value;
  for (const replacement of replacements.reverse()) {
    redacted = redacted.slice(0, replacement.start)
      + replacement.value
      + redacted.slice(replacement.end);
  }
  return redacted;
}

function assignmentValueEnd(
  value: string,
  start: number,
  nextAssignmentStart: number,
): { end: number; quoted: '"' | "'" | null } {
  const quote = value[start] === '"' || value[start] === "'" ? value[start] : null;
  if (quote) {
    let escaped = false;
    for (let index = start + 1; index < value.length; index += 1) {
      const character = value[index]!;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        return { end: index + 1, quoted: quote };
      } else if (character === "\r" || character === "\n") {
        return { end: index, quoted: quote };
      }
    }
    return { end: value.length, quoted: quote };
  }

  let end = Math.min(nextAssignmentStart, value.length);
  for (let index = start; index < end; index += 1) {
    if (/[\r\n,;}"']/.test(value[index]!)) {
      end = index;
      break;
    }
  }
  while (end > start && /[ \t]/.test(value[end - 1]!)) end -= 1;
  return { end, quoted: null };
}
