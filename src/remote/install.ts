import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isSafeSshTarget } from "../ops/config.ts";

const execFileAsync = promisify(execFile);

export interface RemoteNodeInstallResult {
  target: string;
  packageName: string;
  serviceLabel: string;
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Package the exact built checkout, install it through the remote user's npm,
 * and load its per-user launchd service. No remote sudo or listening socket is
 * used; the node remains loopback-only and is reached through SSH.
 */
export async function installRemoteNode(options: {
  target: string;
  packageRoot?: string;
  npmExecutable?: string;
  sshExecutable?: string;
  scpExecutable?: string;
}): Promise<RemoteNodeInstallResult> {
  if (!isSafeSshTarget(options.target)) throw new Error("Invalid SSH target");
  const packageRoot = resolve(options.packageRoot ?? fileURLToPath(new URL("../../", import.meta.url)));
  if (!existsSync(join(packageRoot, "dist", "cli", "index.js"))) {
    throw new Error("Build Agent Manager before installing a remote node (`pnpm build`)");
  }
  const temporary = mkdtempSync(join(tmpdir(), "agent-manager-node-install-"));
  const remotePackage = `/tmp/agent-manager-node-${randomUUID()}.tgz`;
  try {
    const packed = await execFileAsync(options.npmExecutable ?? "npm", [
      "pack",
      "--json",
      "--pack-destination",
      temporary,
    ], { cwd: packageRoot, maxBuffer: 2 * 1_024 * 1_024 });
    const report = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>;
    const filename = typeof report[0]?.filename === "string" ? report[0].filename : null;
    if (!filename || basename(filename) !== filename) throw new Error("npm pack did not return a safe package filename");
    const localPackage = join(temporary, filename);
    await execFileAsync(options.scpExecutable ?? "/usr/bin/scp", [
      "-q",
      "--",
      localPackage,
      `${options.target}:${remotePackage}`,
    ], { maxBuffer: 2 * 1_024 * 1_024 });

    const script = [
      "set -euo pipefail",
      `package=${shellLiteral(remotePackage)}`,
      "cleanup() { rm -f \"$package\"; }",
      "trap cleanup EXIT",
      "node_major=$(node -p 'process.versions.node.split(`.`)[0]')",
      "if [ \"$node_major\" -lt 24 ]; then echo 'Agent Manager requires Node 24' >&2; exit 1; fi",
      "npm install --global --ignore-scripts \"$package\"",
      "agent-manager service install >/dev/null",
      "uid=$(id -u)",
      "plist=\"$HOME/Library/LaunchAgents/local.agent-manager.cockpit.plist\"",
      "launchctl bootout \"gui/$uid/local.agent-manager.cockpit\" >/dev/null 2>&1 || true",
      "launchctl bootstrap \"gui/$uid\" \"$plist\"",
      "launchctl kickstart -k \"gui/$uid/local.agent-manager.cockpit\"",
    ].join("; ");
    const remoteCommand = `/bin/zsh -lc ${shellLiteral(script)}`;
    await execFileAsync(options.sshExecutable ?? "/usr/bin/ssh", [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=15",
      "--",
      options.target,
      remoteCommand,
    ], { maxBuffer: 4 * 1_024 * 1_024 });
    return {
      target: options.target,
      packageName: filename,
      serviceLabel: "local.agent-manager.cockpit",
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
