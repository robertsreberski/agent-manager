import { isAbsolute, resolve } from "node:path";

const MAX_BODY_BYTES = 1_048_576;

export function assertCodexHookEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error("Codex hook endpoint must use loopback HTTP");
  }
  if (url.pathname !== "/api/v1/hooks/codex" || url.username || url.password || url.search || url.hash) {
    throw new Error("Codex hook endpoint must be exactly /api/v1/hooks/codex");
  }
  return url.toString();
}

function absoluteExecutable(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || /[\r\n]/u.test(path)) {
    throw new Error("Codex hook Node executable must be an absolute normalized path");
  }
  return path;
}

/** Renders one argv-free command string for Codex's pinned `shell -lc` runner. */
export function renderCodexHookCommand(shimPath: string): string {
  const path = absoluteExecutable(shimPath);
  return `'${path.replaceAll("'", `'"'"'`)}'`;
}

/** A self-contained, no-shell shim whose only secret is its mode-0700 file content. */
export function renderCodexHookShim(input: {
  endpoint: string;
  bearerToken: string;
  nodeExecutable: string;
  timeoutMs?: number;
}): string {
  const endpoint = assertCodexHookEndpoint(input.endpoint);
  const node = absoluteExecutable(input.nodeExecutable);
  const timeoutMs = input.timeoutMs ?? 4_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
    throw new Error("Codex hook shim timeout must be 250-30000 milliseconds");
  }
  return `#!${node}
import http from "node:http";

const endpoint = ${JSON.stringify(endpoint)};
const token = ${JSON.stringify(input.bearerToken)};
const maximum = ${String(MAX_BODY_BYTES)};
const chunks = [];
let bytes = 0;
let done = false;

function finish(value = {}) {
  if (done) return;
  done = true;
  process.stdout.write(JSON.stringify(value));
}

process.stdin.on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes > maximum) {
    process.stdin.destroy();
    finish();
    return;
  }
  chunks.push(chunk);
});
process.stdin.on("error", () => finish());
process.stdin.on("end", () => {
  if (done || bytes === 0) return finish();
  const body = Buffer.concat(chunks);
  const url = new URL(endpoint);
  const request = http.request(url, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
    },
  }, (response) => {
    const responseChunks = [];
    let responseBytes = 0;
    response.on("data", (chunk) => {
      responseBytes += chunk.length;
      if (responseBytes > maximum) {
        response.destroy();
        finish();
        return;
      }
      responseChunks.push(chunk);
    });
    response.on("error", () => finish());
    response.on("end", () => {
      if (done || response.statusCode !== 200) return finish();
      try {
        const value = JSON.parse(Buffer.concat(responseChunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) return finish();
      } catch {
        return finish();
      }
      // This integration is observation-only until Codex response authority is
      // proven live. Never relay a local response into the provider process.
      finish();
    });
  });
  request.setTimeout(${String(timeoutMs)}, () => {
    request.destroy();
    finish();
  });
  request.on("error", () => finish());
  request.end(body);
});
`;
}
