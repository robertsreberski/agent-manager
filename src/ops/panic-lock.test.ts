import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultPaths } from "./config.ts";
import {
  assertPanicUnlocked,
  engagePanicLock,
  panicLockPath,
  releasePanicLock,
} from "./panic-lock.ts";

function fixture(t: { after(callback: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-panic-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return defaultPaths(root, typeof process.getuid === "function" ? process.getuid() : 0);
}

test("persistent panic sentinel blocks startup until explicitly released", (t) => {
  const paths = fixture(t);
  assert.doesNotThrow(() => assertPanicUnlocked(paths));
  assert.equal(engagePanicLock(paths), true);
  assert.equal(engagePanicLock(paths), false);
  assert.equal(lstatSync(panicLockPath(paths)).mode & 0o777, 0o600);
  assert.throws(() => assertPanicUnlocked(paths), /panic lock is engaged/);
  assert.equal(releasePanicLock(paths), true);
  assert.equal(releasePanicLock(paths), false);
  assert.doesNotThrow(() => assertPanicUnlocked(paths));
});

test("panic sentinel rejects symlinks and unsafe permissions", (t) => {
  const paths = fixture(t);
  assert.equal(engagePanicLock(paths), true);
  chmodSync(panicLockPath(paths), 0o644);
  assert.throws(() => engagePanicLock(paths), /mode 0600/);
  assert.throws(() => releasePanicLock(paths), /mode 0600/);

  rmSync(panicLockPath(paths));
  const outside = join(paths.dataDirectory, "outside");
  writeFileSync(outside, "outside", { mode: 0o600 });
  symlinkSync(outside, panicLockPath(paths));
  assert.throws(() => engagePanicLock(paths), /regular file/);
});
