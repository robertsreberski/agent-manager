import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isSafeSshTarget } from "../ops/config.ts";
import { inspectPackedPackage } from "./package-policy.ts";

const execFileAsync = promisify(execFile);

export interface RemoteNodeInstallResult {
  target: string;
  packageName: string;
  serviceLabel: string;
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function resolveAgentManagerPackageRoot(moduleUrl = import.meta.url): string {
  let directory = dirname(fileURLToPath(moduleUrl));
  while (true) {
    const manifestPath = join(directory, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      if (
        manifest
        && typeof manifest === "object"
        && !Array.isArray(manifest)
        && (manifest as Record<string, unknown>).name === "agent-manager"
      ) {
        return directory;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Could not locate the Agent Manager package root");
    }
    directory = parent;
  }
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
  const packageRoot = options.packageRoot
    ? resolve(options.packageRoot)
    : resolveAgentManagerPackageRoot();
  if (!existsSync(join(packageRoot, "dist", "cli", "index.js"))) {
    throw new Error("Build Agent Manager before installing a remote node (`pnpm build`)");
  }
  const temporary = mkdtempSync(join(tmpdir(), "agent-manager-node-install-"));
  const remotePackage = `/tmp/agent-manager-node-${randomUUID()}.tgz`;
  try {
    const packed = await execFileAsync(options.npmExecutable ?? "npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      temporary,
    ], { cwd: packageRoot, maxBuffer: 2 * 1_024 * 1_024 });
    const inspection = inspectPackedPackage(packed.stdout);
    if (inspection.violations.length > 0) {
      const detail = inspection.violations
        .map((violation) => `${violation.path}: ${violation.message}`)
        .join("; ");
      throw new Error(`Refusing remote install of invalid package: ${detail}`);
    }
    const filename = inspection.filename;
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
