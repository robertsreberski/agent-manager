import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installRemoteNode } from "./install.ts";

test("remote node install transfers one package and runs one quoted login-shell command", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-manager-install-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "cli"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "cli", "index.js"), "// fixture\n");
  const scpLog = join(root, "scp.json");
  const sshLog = join(root, "ssh.json");

  const fakeNpm = join(root, "npm.cjs");
  writeFileSync(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const destination = args[args.indexOf("--pack-destination") + 1];
fs.writeFileSync(path.join(destination, "agent-manager-fixture.tgz"), "fixture");
process.stdout.write(JSON.stringify([{ filename: "agent-manager-fixture.tgz" }]));
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

  const scpArgs = JSON.parse(readFileSync(scpLog, "utf8")) as string[];
  assert.equal(scpArgs.at(-1)?.startsWith("dev@build-mac:/tmp/agent-manager-node-"), true);
  const sshArgs = JSON.parse(readFileSync(sshLog, "utf8")) as string[];
  assert.equal(sshArgs.at(-2), "dev@build-mac");
  const remoteCommand = sshArgs.at(-1) ?? "";
  assert.match(remoteCommand, /^\/bin\/zsh -lc '/);
  assert.match(remoteCommand, /npm install --global --ignore-scripts/);
  assert.match(remoteCommand, /agent-manager service install/);
  assert.match(remoteCommand, /launchctl kickstart/);
});
