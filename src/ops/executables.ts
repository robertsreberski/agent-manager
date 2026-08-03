import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";

export interface AttachExecutables {
  codex: string;
  claude: string;
  tmux: string;
}

export interface ServiceExecutables extends AttachExecutables {
  node: string;
  tailscale: string;
}

export interface ResolveServiceExecutablesOptions {
  env?: NodeJS.ProcessEnv;
  nodeExecutable?: string;
  path?: string;
}

const SYSTEM_PATH_DIRECTORIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
] as const;

const MACOS_ADMIN_GROUP_ID = 80;
const MACOS_ADMIN_WRITABLE_PREFIXES = ["/opt/homebrew", "/usr/local"] as const;

function pathWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function allowsPrivilegedAdminWrite(path: string, groupId: number): boolean {
  return process.platform === "darwin"
    && groupId === MACOS_ADMIN_GROUP_ID
    && MACOS_ADMIN_WRITABLE_PREFIXES.some((root) => pathWithin(path, root));
}

/**
 * Verify every pathname component that can replace a canonical executable.
 * Root and the effective user are the only accepted owners. macOS Homebrew's
 * conventional admin-group-writable prefixes are an explicit exception;
 * unprivileged group write and all world write remain forbidden.
 */
export function assertCanonicalExecutableProvenance(
  command: string,
  canonical: string,
  currentUid = typeof process.getuid === "function" ? process.getuid() : null,
): void {
  let path = canonical;
  let target = true;
  while (true) {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      throw new Error(`${command} canonical path contains a symbolic link: ${path}`);
    }
    if (target ? !info.isFile() : !info.isDirectory()) {
      throw new Error(`${command} canonical ${target ? "target" : "ancestor"} has an unexpected type: ${path}`);
    }
    if (info.uid !== 0 && (currentUid === null || info.uid !== currentUid)) {
      throw new Error(`${command} canonical path is owned by an unrelated user: ${path}`);
    }
    if ((info.mode & 0o002) !== 0) {
      throw new Error(`${command} canonical path is world-writable: ${path}`);
    }
    if ((info.mode & 0o020) !== 0) {
      if (target || !allowsPrivilegedAdminWrite(path, info.gid)) {
        throw new Error(`${command} canonical path is writable by an unprivileged group: ${path}`);
      }
    }

    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
    target = false;
  }
}

function safeConfiguredValue(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  if (!value || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error(`Invalid configured ${label} executable`);
  }
  if (!isAbsolute(value)) {
    throw new Error(`Configured ${label} executable must be an absolute path`);
  }
  return value;
}

function findOnPath(command: string, pathValue: string): string {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue through the controlled search path.
    }
  }
  throw new Error(`Could not resolve ${command} on the controlled service PATH`);
}

export function canonicalExecutable(
  command: string,
  options: { configured?: string; path: string },
): string {
  if (!command || command.includes("/") || command.includes("\0")) {
    throw new Error("Executable command identity must be a plain filename");
  }
  const configured = safeConfiguredValue(options.configured, command);
  const candidate = configured ?? findOnPath(command, options.path);
  const canonical = realpathSync(candidate);
  if (!isAbsolute(canonical)) throw new Error(`${command} did not resolve to an absolute path`);
  assertCanonicalExecutableProvenance(command, canonical);
  accessSync(canonical, constants.X_OK);
  return canonical;
}

export function buildControlledServicePath(executables: ServiceExecutables): string {
  const directories = [
    dirname(executables.node),
    dirname(executables.codex),
    dirname(executables.claude),
    dirname(executables.tmux),
    dirname(executables.tailscale),
    ...SYSTEM_PATH_DIRECTORIES,
  ];
  return [...new Set(directories)].join(delimiter);
}

export function resolveServiceExecutables(
  options: ResolveServiceExecutablesOptions = {},
): ServiceExecutables {
  const env = options.env ?? process.env;
  const searchPath = options.path ?? env.PATH ?? SYSTEM_PATH_DIRECTORIES.join(delimiter);
  const nodeConfigured = safeConfiguredValue(
    options.nodeExecutable ?? process.execPath,
    "node",
  );
  return {
    node: canonicalExecutable("node", {
      ...(nodeConfigured ? { configured: nodeConfigured } : {}),
      path: searchPath,
    }),
    codex: canonicalExecutable("codex", {
      ...(env.AGENT_MANAGER_CODEX_EXECUTABLE
        ? { configured: env.AGENT_MANAGER_CODEX_EXECUTABLE }
        : {}),
      path: searchPath,
    }),
    claude: canonicalExecutable("claude", {
      ...(env.AGENT_MANAGER_CLAUDE_EXECUTABLE
        ? { configured: env.AGENT_MANAGER_CLAUDE_EXECUTABLE }
        : {}),
      path: searchPath,
    }),
    tmux: canonicalExecutable("tmux", {
      ...(env.AGENT_MANAGER_TMUX_EXECUTABLE
        ? { configured: env.AGENT_MANAGER_TMUX_EXECUTABLE }
        : {}),
      path: searchPath,
    }),
    tailscale: canonicalExecutable("tailscale", {
      ...(env.AGENT_MANAGER_TAILSCALE_EXECUTABLE
        ? { configured: env.AGENT_MANAGER_TAILSCALE_EXECUTABLE }
        : {}),
      path: searchPath,
    }),
  };
}
