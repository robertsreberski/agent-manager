import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface HookAuthorizationRecord {
  id: string;
  provider: "claude";
  tokenDigest: string;
  createdAt: string;
  settingsPath: string;
}

const DIGEST_PREFIX = "sha256:";

export function generateHookBearerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function digestHookBearerToken(token: string): string {
  if (token.length < 32 || token.length > 512 || /\s/.test(token)) {
    throw new Error("Hook bearer token must be 32-512 non-whitespace characters");
  }
  return `${DIGEST_PREFIX}${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

export function createHookAuthorizationRecord(input: {
  id: string;
  token: string;
  createdAt: string;
  settingsPath: string;
}): HookAuthorizationRecord {
  if (!input.id.trim()) throw new Error("Hook install id must not be empty");
  if (!input.settingsPath.startsWith("/")) {
    throw new Error("Hook settings path must be absolute");
  }
  return {
    id: input.id,
    provider: "claude",
    tokenDigest: digestHookBearerToken(input.token),
    createdAt: input.createdAt,
    settingsPath: input.settingsPath,
  };
}

export function authorizeHookBearer(
  authorization: string | undefined,
  records: readonly HookAuthorizationRecord[],
): HookAuthorizationRecord | null {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  const token = match?.[1];
  if (!token) return null;
  const tokenValid = token.length >= 32 && token.length <= 512;
  // Hash even malformed-length candidates so all syntactically valid Bearer
  // requests take the same fixed-size comparison path.
  const candidate = createHash("sha256").update(token, "utf8").digest();

  let found: HookAuthorizationRecord | null = null;
  for (const record of records) {
    const digest = /^sha256:([a-f0-9]{64})$/.exec(record.tokenDigest)?.[1];
    const expected = digest ? Buffer.from(digest, "hex") : Buffer.alloc(32);
    const equal = timingSafeEqual(expected, candidate);
    if (tokenValid && equal && record.tokenDigest === `${DIGEST_PREFIX}${candidate.toString("hex")}`) {
      found = record;
    }
  }
  return found;
}
