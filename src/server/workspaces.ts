import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

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
