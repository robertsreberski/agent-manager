import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

import {
  WorkspaceIdentityResolver,
  type WorkspaceIdentity,
} from "../core/worktree.ts";
import {
  workspaceResolutionResponseSchema,
  type WorkspaceResolutionResponse,
} from "../shared/workspace.ts";
import type { WorkspaceRecord } from "./persistence.ts";

function expandedPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return normalize(trimmed);
}

export function resolveLocalWorkspacePath(input: string): string {
  const expanded = expandedPath(input);
  if (!isAbsolute(expanded)) throw new Error("Workspace path must be absolute");
  const canonical = realpathSync(expanded);
  if (!statSync(canonical).isDirectory()) throw new Error("Workspace path must be a directory");
  return canonical;
}

export function localDirectoryCompletions(input: string, limit = 30): string[] {
  const expanded = expandedPath(input || homedir());
  if (!isAbsolute(expanded)) return [];

  let parent = dirname(expanded);
  let prefix = basename(expanded);
  try {
    if (statSync(expanded).isDirectory() && (input.endsWith("/") || input === "~" || input === "")) {
      parent = expanded;
      prefix = "";
    }
  } catch {
    // A partial final component is the normal autocomplete case.
  }

  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(parent);
    if (!statSync(canonicalParent).isDirectory()) return [];
  } catch {
    return [];
  }

  try {
    return readdirSync(canonicalParent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => join(parent, entry.name))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, Math.max(1, Math.min(50, limit)));
  } catch {
    return [];
  }
}

export function workspaceLabel(path: string): string {
  return basename(path) || path;
}

/** Directories a repository holds but nobody @-mentions. */
const UNMENTIONED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".venv",
  "__pycache__",
]);
const FILE_SCAN_MAX_ENTRIES = 20_000;
const FILE_SCAN_MAX_DEPTH = 12;

/**
 * Workspace-relative file paths matching a substring, for the composer's
 * `@mention`.
 *
 * Bounded on every axis a repository can be unbounded on: depth, total entries
 * visited, and results. Symlinks are not followed — a link out of the worktree
 * would otherwise make this a read of any file on the machine — and the
 * returned paths are relative, so nothing here discloses where the workspace
 * lives.
 */
export function workspaceFileCompletions(root: string, query: string, limit = 20): string[] {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
    if (!statSync(canonicalRoot).isDirectory()) return [];
  } catch {
    return [];
  }
  const needle = query.trim().toLowerCase();
  const bound = Math.max(1, Math.min(50, limit));
  const matches: string[] = [];
  let visited = 0;

  const walk = (directory: string, relative: string, depth: number): void => {
    if (matches.length >= bound || visited >= FILE_SCAN_MAX_ENTRIES || depth > FILE_SCAN_MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= bound || visited >= FILE_SCAN_MAX_ENTRIES) return;
      visited += 1;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      // `isDirectory`/`isFile` are false for a symlink, so this skips them.
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (UNMENTIONED_DIRECTORIES.has(entry.name)) continue;
        walk(join(directory, entry.name), path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (needle && !path.toLowerCase().includes(needle)) continue;
      matches.push(path);
    }
  };

  walk(canonicalRoot, "", 0);
  return matches.sort((left, right) => left.length - right.length || left.localeCompare(right));
}

export interface ResolvedWorkspace {
  path: string;
  label: string;
  remoteWorkspaceId: string | null;
  workspaceIdentity: WorkspaceIdentity | null;
}

export interface RemoteWorkspaceIdentityResolver {
  resolveWorkspace(hostId: string, path: string): Promise<{
    path: string;
    label: string;
    remoteWorkspaceId: string;
    workspaceIdentity: WorkspaceIdentity | null;
  }>;
}

/**
 * Resolves Git facts on the host that owns the path. The local resolver is
 * deliberately unreachable in the SSH branch so a remote cwd can never be
 * interpreted against the controller's parent filesystem.
 */
export async function resolveWorkspaceForHost(options: {
  hostId: string;
  hostKind: "local" | "ssh";
  path: string;
  localResolver: WorkspaceIdentityResolver;
  remote: RemoteWorkspaceIdentityResolver;
}): Promise<ResolvedWorkspace> {
  if (options.hostKind === "ssh") {
    const resolved = await options.remote.resolveWorkspace(options.hostId, options.path);
    return {
      path: resolved.path,
      label: resolved.label,
      remoteWorkspaceId: resolved.remoteWorkspaceId,
      workspaceIdentity: structuredClone(resolved.workspaceIdentity),
    };
  }
  const path = resolveLocalWorkspacePath(options.path);
  return {
    path,
    label: workspaceLabel(path),
    remoteWorkspaceId: null,
    workspaceIdentity: await options.localResolver.resolve(path, { selected: true }),
  };
}

/** Exact public workspace envelope shared by local and remote resolution. */
export function workspaceResolutionResponse(
  workspace: WorkspaceRecord,
  workspaceIdentity: WorkspaceIdentity | null,
): WorkspaceResolutionResponse {
  return workspaceResolutionResponseSchema.parse({
    workspace: {
      ...workspace,
      workspaceIdentity: structuredClone(workspaceIdentity),
    },
  });
}
