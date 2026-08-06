import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  objectProperty,
  parseJsonc,
  removeArrayElement,
  removeObjectProperty,
  scalarString,
  type JsoncArray,
  type JsoncObject,
  type JsoncProperty,
} from "./hooks-jsonc.ts";

/*
  Agent Manager once installed its own command hooks into Codex, to observe
  external CLI sessions. That plane could never gate anything — the shim
  discarded every response — and the App Server already reports exact events for
  managed threads, so it was retired.

  A retired integration still owes its users the removal of what it wrote. These
  hooks live in a file the operator also edits by hand, next to their own hooks,
  so removal is surgical: only handlers whose command is Agent Manager's own
  shim are taken, the surrounding JSONC (comments, ordering, unrelated events)
  is preserved byte-for-byte, and a file we do not recognise is left untouched.
*/

/** A command belonging to a generated Agent Manager Codex shim. */
const AGENT_MANAGER_CODEX_COMMAND = /agent-manager.+codex.+hook/iu;

export interface CodexHookCleanupTarget {
  settingsPath: string;
  shimPath: string;
  /** The exact recorded command, when a durable install record survives. */
  command?: string | undefined;
}

export interface CodexHookCleanupReport {
  settingsPath: string;
  /** Commands actually removed from this file. */
  removedCommands: readonly string[];
  removedShimPaths: readonly string[];
  /** Why this target was skipped, when it was. Never a thrown error. */
  error: string | null;
}

interface LocatedHandler {
  root: JsoncObject;
  hooksProperty: JsoncProperty;
  hooks: JsoncObject;
  eventProperty: JsoncProperty;
  eventArray: JsoncArray;
  matcher: JsoncObject;
  handlerArray: JsoncArray;
  handler: JsoncObject;
  command: string;
}

function locateHandlers(text: string): LocatedHandler[] {
  const root = parseJsonc(text);
  if (root.type !== "object") return [];
  const hooksProperty = objectProperty(root, "hooks");
  if (!hooksProperty || hooksProperty.value.type !== "object") return [];
  const hooks = hooksProperty.value;
  const result: LocatedHandler[] = [];
  for (const eventProperty of hooks.properties) {
    if (eventProperty.value.type !== "array") continue;
    for (const matcher of eventProperty.value.elements) {
      if (matcher.type !== "object") continue;
      const handlersProperty = objectProperty(matcher, "hooks");
      if (!handlersProperty || handlersProperty.value.type !== "array") continue;
      for (const handler of handlersProperty.value.elements) {
        if (handler.type !== "object") continue;
        const type = objectProperty(handler, "type");
        if (!type || scalarString(type.value) !== "command") continue;
        const commandProperty = objectProperty(handler, "command");
        const command = commandProperty ? scalarString(commandProperty.value) : null;
        if (!command) continue;
        result.push({
          root,
          hooksProperty,
          hooks,
          eventProperty,
          eventArray: eventProperty.value,
          matcher,
          handlerArray: handlersProperty.value,
          handler,
          command,
        });
      }
    }
  }
  return result;
}

/**
 * Remove one handler and every container it was the last member of, so a
 * removal never leaves an empty matcher, event array, or `hooks` object behind.
 */
function removeHandler(text: string, located: LocatedHandler): string {
  if (located.handlerArray.elements.length > 1) {
    return removeArrayElement(text, located.handlerArray, located.handler);
  }
  if (located.matcher.properties.length !== 1 || located.matcher.properties[0]?.key !== "hooks") {
    // The operator added fields to a matcher we created. Take only the handler
    // and leave their edit standing rather than guessing what it meant.
    return removeArrayElement(text, located.handlerArray, located.handler);
  }
  if (located.eventArray.elements.length > 1) {
    return removeArrayElement(text, located.eventArray, located.matcher);
  }
  return removeObjectProperty(text, located.hooks, located.eventProperty);
}

/**
 * Strip every Agent Manager handler from one settings document.
 *
 * `command`, when a durable install record supplied it, is removed by exact
 * match. Anything else matching the generated-shim shape is removed too: a lost
 * or reset database must not strand hooks that still fire on every Codex event.
 */
export function removeAgentManagerCodexHooks(
  settingsText: string,
  command?: string | undefined,
): { text: string; removed: readonly string[] } {
  if (settingsText.trim().length === 0) return { text: settingsText, removed: [] };
  const removed: string[] = [];
  let text = settingsText;
  while (true) {
    const located = locateHandlers(text).find((item) =>
      item.command === command || AGENT_MANAGER_CODEX_COMMAND.test(item.command)
    );
    if (!located) break;
    removed.push(located.command);
    text = removeHandler(text, located);
  }
  if (removed.length === 0) return { text: settingsText, removed: [] };
  // An emptied `hooks` object is ours to clean up; a populated one is not.
  const root = parseJsonc(text);
  if (root.type === "object") {
    const hooksProperty = objectProperty(root, "hooks");
    if (hooksProperty?.value.type === "object" && hooksProperty.value.properties.length === 0) {
      text = removeObjectProperty(text, root, hooksProperty);
    }
  }
  return { text, removed };
}

async function readRegularFile(path: string): Promise<{ text: string; mode: number } | null> {
  try {
    const stats = await lstat(path);
    // A symlink or device at this path is not something we wrote, and following
    // it would write through to a target we never inspected.
    if (stats.isSymbolicLink() || !stats.isFile()) return null;
    return { text: await readFile(path, "utf8"), mode: stats.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Remove one target's handlers and its generated shim. Never throws. */
export async function cleanCodexHookTarget(
  target: CodexHookCleanupTarget,
): Promise<CodexHookCleanupReport> {
  const report: CodexHookCleanupReport = {
    settingsPath: target.settingsPath,
    removedCommands: [],
    removedShimPaths: [],
    error: null,
  };
  try {
    const settings = await readRegularFile(target.settingsPath);
    let removedCommands: readonly string[] = [];
    if (settings) {
      const { text, removed } = removeAgentManagerCodexHooks(settings.text, target.command);
      if (removed.length > 0) {
        await writeFile(target.settingsPath, text, { encoding: "utf8", mode: settings.mode });
        removedCommands = removed;
      }
    }
    // The shim goes regardless: it is ours alone, and an orphaned copy left
    // behind is a script that answers a loopback endpoint no longer served.
    const removedShimPaths: string[] = [];
    if (target.shimPath) {
      const shim = await readRegularFile(target.shimPath);
      if (shim) {
        await rm(target.shimPath, { force: true });
        removedShimPaths.push(target.shimPath);
      }
    }
    return { ...report, removedCommands, removedShimPaths };
  } catch (error) {
    // Cleanup is best-effort and runs during startup. A permission error on one
    // operator-owned file must never stop the manager from starting.
    return { ...report, error: error instanceof Error ? error.message : String(error) };
  }
}

function absoluteDirectory(value: string, label: string): string {
  const path = resolve(value);
  if (!isAbsolute(value) || path !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return path;
}

/** The user-scope settings file and shim the retired installer wrote. */
export function defaultCodexHookCleanupTarget(homeDirectory: string): CodexHookCleanupTarget {
  const home = absoluteDirectory(homeDirectory, "Codex hook home directory");
  return {
    settingsPath: join(home, ".codex", "hooks.json"),
    shimPath: join(home, "Library", "Application Support", "agent-manager", "hooks", "codex-user-hook.mjs"),
  };
}

/**
 * Sweep every Codex hook Agent Manager installed.
 *
 * Recorded targets come first, because only the durable record names the
 * project-scoped files a home-directory scan cannot find. The user-scope path
 * is always swept as well, so an install whose record was lost still gets
 * cleaned. Idempotent: a second run finds nothing and writes nothing.
 */
export async function sweepRetiredCodexHooks(input: {
  homeDirectory: string;
  recorded?: readonly CodexHookCleanupTarget[];
}): Promise<readonly CodexHookCleanupReport[]> {
  const targets = new Map<string, CodexHookCleanupTarget>();
  for (const target of input.recorded ?? []) {
    targets.set(target.settingsPath, target);
  }
  try {
    const fallback = defaultCodexHookCleanupTarget(input.homeDirectory);
    if (!targets.has(fallback.settingsPath)) targets.set(fallback.settingsPath, fallback);
  } catch {
    // An unusable home directory leaves only the recorded targets to sweep.
  }
  const reports: CodexHookCleanupReport[] = [];
  for (const target of targets.values()) {
    reports.push(await cleanCodexHookTarget(target));
  }
  return reports;
}
