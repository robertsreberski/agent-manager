import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface CodexHookAuthorizationRecord {
  id: string;
  provider: "codex";
  tokenDigest: string;
  createdAt: string;
  settingsPath: string;
  shimPath: string;
}

const DIGEST_PREFIX = "sha256:";

export function generateCodexHookToken(): string {
  return randomBytes(32).toString("base64url");
}

export function digestCodexHookToken(token: string): string {
  if (token.length < 32 || token.length > 512 || /\s/u.test(token)) {
    throw new Error("Codex hook bearer token must be 32-512 non-whitespace characters");
  }
  return `${DIGEST_PREFIX}${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

export function authorizeCodexHook(
  authorization: string | undefined,
  records: readonly CodexHookAuthorizationRecord[],
): CodexHookAuthorizationRecord | null {
  const token = /^Bearer ([^\s]+)$/u.exec(authorization ?? "")?.[1];
  if (!token) return null;
  let candidate: Buffer;
  try {
    candidate = Buffer.from(digestCodexHookToken(token).slice(DIGEST_PREFIX.length), "hex");
  } catch {
    return null;
  }
  let found: CodexHookAuthorizationRecord | null = null;
  for (const record of records) {
    const encoded = record.tokenDigest.startsWith(DIGEST_PREFIX)
      ? record.tokenDigest.slice(DIGEST_PREFIX.length)
      : "";
    const expected = Buffer.from(encoded.padEnd(64, "0").slice(0, 64), "hex");
    const equal = expected.length === candidate.length && timingSafeEqual(expected, candidate);
    if (equal && record.tokenDigest === `${DIGEST_PREFIX}${candidate.toString("hex")}`) {
      found = record;
    }
  }
  return found ? structuredClone(found) : null;
}
