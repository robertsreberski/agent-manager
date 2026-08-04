import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { SessionView } from "../shared/session.ts";

export interface EditorLocation {
  relativePath: string;
  line?: number | undefined;
  column?: number | undefined;
}

export interface EditorLauncher {
  open(session: SessionView, location: EditorLocation): Promise<void>;
}

function confined(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder !== ""
    && remainder !== ".."
    && !remainder.startsWith(`..${sep}`)
    && !isAbsolute(remainder);
}

/**
 * Resolve one provider-reported relative file inside the exact selected worktree.
 * Every component, including the leaf, must be a real uid-owned path and the leaf
 * is re-verified through O_NOFOLLOW before it is handed to the pinned launcher.
 */
export function resolveEditorTarget(
  session: Pick<SessionView, "hostId" | "workspaceIdentity">,
  relativePath: string,
  uid = process.getuid?.() ?? -1,
): string {
  if (
    session.hostId !== "local"
    || !session.workspaceIdentity
    || !relativePath
    || relativePath.includes("\0")
    || isAbsolute(relativePath)
  ) {
    throw new Error("Editor target is unavailable for this session");
  }
  const root = realpathSync(session.workspaceIdentity.worktreePath);
  const rootStat = statSync(root);
  if (!rootStat.isDirectory() || rootStat.uid !== uid) {
    throw new Error("Editor worktree is not a private owned directory");
  }
  const candidate = resolve(root, relativePath);
  if (!confined(root, candidate)) throw new Error("Editor target escapes the session worktree");

  let cursor = root;
  for (const component of relative(root, candidate).split(sep)) {
    cursor = resolve(cursor, component);
    const lexical = lstatSync(cursor);
    if (lexical.isSymbolicLink() || lexical.uid !== uid) {
      throw new Error("Editor target contains an unsafe path component");
    }
  }

  const before = statSync(candidate);
  if (!before.isFile() || before.uid !== uid) throw new Error("Editor target is not an owned file");
  const descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = fstatSync(descriptor);
    if (
      !after.isFile()
      || after.uid !== uid
      || after.dev !== before.dev
      || after.ino !== before.ino
    ) throw new Error("Editor target changed while it was validated");
  } finally {
    closeSync(descriptor);
  }
  return candidate;
}

export class MacEditorLauncher implements EditorLauncher {
  readonly executable = "/usr/bin/open";

  async open(session: SessionView, location: EditorLocation): Promise<void> {
    const target = resolveEditorTarget(session, location.relativePath);
    await new Promise<void>((resolveOpen, reject) => {
      const child = spawn(this.executable, [target], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) reject(new Error(`Editor launcher terminated by ${signal}`));
        else if (code !== 0) reject(new Error(`Editor launcher exited with status ${String(code)}`));
        else resolveOpen();
      });
    });
  }
}
