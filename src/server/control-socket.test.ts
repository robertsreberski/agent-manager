import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthManager } from "./auth.ts";
import {
  requestAttachFromControlSocket,
  requestAttachStartedFromControlSocket,
  requestHooksReloadFromControlSocket,
  startOwnerControlSocket,
} from "./control-socket.ts";

function authManager(): AuthManager {
  return new AuthManager({
    allowedHosts: ["localhost:43127"],
    allowedOrigins: ["http://localhost:43127"],
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("attach preparation and identity proof may outlive the ordinary socket deadline", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "am-control-deadline-"));
  const socketPath = join(root, "runtime", "control.sock");
  let attachStarted = false;
  const server = await startOwnerControlSocket(socketPath, {
    auth: authManager(),
    bootstrapOrigin: "http://localhost:43127",
    async onAttach(sessionId) {
      assert.equal(sessionId, "claude:session-1");
      await delay(2_100);
      return {
        kind: "claude-resume",
        argv: ["claude", "--resume", "session-1"],
        cwd: "/tmp/project",
        warning: null,
      };
    },
    async onAttachStarted(sessionId, handoffId, spawnNonce, pid) {
      assert.deepEqual(
        [sessionId, handoffId, spawnNonce, pid],
        ["claude:session-1", "handoff-1", "spawn-nonce-00000001", 1234],
      );
      await delay(2_100);
      attachStarted = true;
    },
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const [prepared, started] = await Promise.all([
    requestAttachFromControlSocket(socketPath, "claude:session-1"),
    requestAttachStartedFromControlSocket(
      socketPath,
      "claude:session-1",
      "handoff-1",
      "spawn-nonce-00000001",
      1234,
    ),
  ]);

  assert.deepEqual(prepared.instruction.argv, ["claude", "--resume", "session-1"]);
  assert.deepEqual(started, { ok: true });
  assert.equal(attachStarted, true);
});

test("an ordinary control command that stalls is still bounded", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "am-control-deadline-"));
  const socketPath = join(root, "runtime", "control.sock");
  let invoked = false;
  const server = await startOwnerControlSocket(socketPath, {
    auth: authManager(),
    bootstrapOrigin: "http://localhost:43127",
    onReloadHooks() {
      invoked = true;
      return new Promise<void>(() => undefined);
    },
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const startedAt = Date.now();
  await assert.rejects(requestHooksReloadFromControlSocket(socketPath));
  const elapsedMs = Date.now() - startedAt;

  assert.equal(invoked, true);
  assert.ok(elapsedMs >= 1_800, `ordinary command timed out too early after ${elapsedMs}ms`);
  assert.ok(elapsedMs < 5_000, `ordinary command was not bounded: ${elapsedMs}ms`);
});
