import { readdirSync, realpathSync, statSync } from "node:fs";
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
