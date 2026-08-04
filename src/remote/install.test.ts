import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { installRemoteNode, resolveAgentManagerPackageRoot } from "./install.ts";
import { REQUIRED_PACKED_FILES } from "./package-policy.ts";

const CURRENT_HASHED_FILES = [
  "dist/chunk-AAAAAAAA.js",
  "dist/chunk-BBBBBBBB.js",
  "dist/chunk-CCCCCCCC.js",
  "dist/web/assets/index-AbCd1234.css",
  "dist/web/assets/index-EfGh5678.js",
  "dist/web/assets/workbox-window.prod.es5-IjKl9012.js",
] as const;

function packReport(extraFiles: readonly string[] = []): unknown[] {
  return [{
    filename: "agent-manager-fixture.tgz",
    size: 100_000,
    files: [
      ...REQUIRED_PACKED_FILES,
      ...CURRENT_HASHED_FILES,
      "README.md",
      "SECURITY.md",
      "package.json",
      ...extraFiles,
    ].map((path) => ({ path })),
  }];
}

test("package-root discovery works from built root chunks and nested entrypoints", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-package-root-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-manager" }));

  assert.equal(
    resolveAgentManagerPackageRoot(pathToFileURL(join(root, "dist", "chunk-AAAAAAAA.js")).href),
    root,
  );
  assert.equal(
    resolveAgentManagerPackageRoot(pathToFileURL(join(root, "dist", "cli", "index.js")).href),
    root,
  );
});

test("remote node install transfers one package and runs one quoted login-shell command", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-install-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "cli"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "cli", "index.js"), "// fixture\n");
  const scpLog = join(root, "scp.json");
  const sshLog = join(root, "ssh.json");
  const npmLog = join(root, "npm.json");

  const fakeNpm = join(root, "npm.cjs");
  writeFileSync(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(npmLog)}, JSON.stringify(args));
const destination = args[args.indexOf("--pack-destination") + 1];
fs.writeFileSync(path.join(destination, "agent-manager-fixture.tgz"), "fixture");
process.stdout.write(${JSON.stringify(JSON.stringify(packReport()))});
`, { mode: 0o700 });

  const fakeScp = join(root, "scp.cjs");
  writeFileSync(fakeScp, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(scpLog)}, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o700 });

  const fakeSsh = join(root, "ssh.cjs");
  writeFileSync(fakeSsh, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(sshLog)}, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o700 });

  const result = await installRemoteNode({
    target: "dev@build-mac",
    packageRoot,
    npmExecutable: fakeNpm,
    scpExecutable: fakeScp,
    sshExecutable: fakeSsh,
  });
  assert.deepEqual(result, {
    target: "dev@build-mac",
    packageName: "agent-manager-fixture.tgz",
    serviceLabel: "local.agent-manager.cockpit",
  });

  const npmArgs = JSON.parse(readFileSync(npmLog, "utf8")) as string[];
  assert.deepEqual(npmArgs.slice(0, 3), ["pack", "--json", "--ignore-scripts"]);
  const scpArgs = JSON.parse(readFileSync(scpLog, "utf8")) as string[];
  assert.equal(scpArgs.at(-1)?.startsWith("dev@build-mac:/tmp/agent-manager-node-"), true);
  const sshArgs = JSON.parse(readFileSync(sshLog, "utf8")) as string[];
  assert.equal(sshArgs.at(-2), "dev@build-mac");
  const remoteCommand = sshArgs.at(-1) ?? "";
  assert.match(remoteCommand, /^\/bin\/zsh -lc '/);
  assert.match(remoteCommand, /npm install --global --ignore-scripts/);
  assert.match(remoteCommand, /agent-manager service install/);
  assert.doesNotMatch(remoteCommand, /launchctl/);
});

test("remote node install rejects a non-runtime package before transfer", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-install-policy-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "cli"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "cli", "index.js"), "// fixture\n");
  const transferLog = join(root, "transfer-ran");

  const fakeNpm = join(root, "npm.cjs");
  writeFileSync(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const destination = args[args.indexOf("--pack-destination") + 1];
fs.writeFileSync(path.join(destination, "agent-manager-fixture.tgz"), "fixture");
process.stdout.write(${JSON.stringify(JSON.stringify(packReport(["dist/arbitrary-stale.bin"])))});
`, { mode: 0o700 });

  const fakeTransfer = join(root, "transfer.cjs");
  writeFileSync(fakeTransfer, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(transferLog)}, "called");
`, { mode: 0o700 });

  await assert.rejects(
    installRemoteNode({
      target: "dev@build-mac",
      packageRoot,
      npmExecutable: fakeNpm,
      scpExecutable: fakeTransfer,
      sshExecutable: fakeTransfer,
    }),
    /Refusing remote install of invalid package:.*arbitrary-stale/u,
  );
  assert.equal(existsSync(transferLog), false);
});
