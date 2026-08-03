import assert from "node:assert/strict";
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  buildControlledServicePath,
  assertCanonicalExecutableProvenance,
  canonicalExecutable,
  resolveServiceExecutables,
} from "./executables.ts";

function executableFixture(t: { after(callback: () => void): void }) {
  // A world-writable temporary ancestor is intentionally rejected by the
  // provenance policy, so fixtures live beneath the trusted checkout.
  const root = mkdtempSync(join(process.cwd(), ".agent-manager-executables-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const paths = Object.fromEntries(
    ["node", "codex", "claude", "tmux", "tailscale"].map((name) => {
      const path = join(bin, name);
      writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      return [name, path];
    }),
  ) as Record<"node" | "codex" | "claude" | "tmux" | "tailscale", string>;
  return { root, bin, paths };
}

test("resolves one canonical executable set for attach and service operations", (t) => {
  const fixture = executableFixture(t);
  const codexLink = join(fixture.root, "codex-link");
  symlinkSync(fixture.paths.codex, codexLink);
  const executables = resolveServiceExecutables({
    nodeExecutable: fixture.paths.node,
    path: fixture.bin,
    env: {
      PATH: fixture.bin,
      AGENT_MANAGER_CODEX_EXECUTABLE: codexLink,
      AGENT_MANAGER_CLAUDE_EXECUTABLE: fixture.paths.claude,
      AGENT_MANAGER_TMUX_EXECUTABLE: fixture.paths.tmux,
      AGENT_MANAGER_TAILSCALE_EXECUTABLE: fixture.paths.tailscale,
    },
  });

  assert.equal(executables.codex, realpathSync(fixture.paths.codex));
  assert.equal(executables.node, realpathSync(fixture.paths.node));
  assert.equal(
    buildControlledServicePath(executables).split(delimiter)[0],
    realpathSync(fixture.bin),
  );
});

test("rejects relative and writable executable targets", (t) => {
  const fixture = executableFixture(t);
  assert.throws(
    () => canonicalExecutable("codex", { configured: "relative/codex", path: fixture.bin }),
    /absolute path/,
  );
  chmodSync(fixture.paths.codex, 0o722);
  assert.throws(
    () => canonicalExecutable("codex", { configured: fixture.paths.codex, path: fixture.bin }),
    /world-writable|unprivileged group/,
  );
});

test("rejects a canonical executable owned by an unrelated user", (t) => {
  const fixture = executableFixture(t);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === 0) {
    chownSync(fixture.paths.codex, 65_534, 65_534);
    assert.throws(
      () => canonicalExecutable("codex", { configured: fixture.paths.codex, path: fixture.bin }),
      /owned by an unrelated user/,
    );
    return;
  }
  assert.notEqual(uid, null);
  assert.throws(
    () => assertCanonicalExecutableProvenance("codex", fixture.paths.codex, (uid ?? 0) + 1),
    /owned by an unrelated user/,
  );
});

test("rejects an executable beneath a replaceable ancestor", (t) => {
  const fixture = executableFixture(t);
  chmodSync(fixture.bin, 0o770);
  assert.throws(
    () => canonicalExecutable("codex", { configured: fixture.paths.codex, path: fixture.bin }),
    /writable by an unprivileged group/,
  );
});
