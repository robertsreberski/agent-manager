import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderCodexHookCommand, renderCodexHookShim } from "./codex-hook-shim.ts";

const TOKEN = "codex-shim-token-with-at-least-thirty-two-characters";

test("generated Codex shim posts bounded stdin but always prints no-decision JSON", async () => {
  let received: { authorization: string | undefined; body: string } | null = null;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "agent manager codex shim "));
  const path = join(directory, "codex-hook.mjs");
  const payload = JSON.stringify({ hook_event_name: "SessionStart", session_id: "thread" });
  try {
    await writeFile(path, renderCodexHookShim({
      endpoint: `http://127.0.0.1:${String(address.port)}/api/v1/hooks/codex`,
      bearerToken: TOKEN,
      nodeExecutable: process.execPath,
    }), { mode: 0o700 });
    await chmod(path, 0o700);
    const child = spawn("/bin/sh", ["-lc", renderCodexHookCommand(path)], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stdin.end(payload);
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exit, 0);
    assert.equal(Buffer.concat(stdout).toString("utf8"), "{}");
    assert.deepEqual(received, { authorization: `Bearer ${TOKEN}`, body: payload });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
