import { useEffect, useRef, useState } from "react";

import type { WorkspaceGitContext } from "../../../../src/shared/workspace.ts";

export type GitContextState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; context: WorkspaceGitContext }
  | { status: "error"; message: string };

/** Only a rooted path can name a folder; a bare prefix is still being typed. */
function looksLikePath(path: string): boolean {
  const trimmed = path.trim();
  return trimmed.startsWith("/") || trimmed.startsWith("~");
}

/**
 * The repository facts for the folder currently in the draft.
 *
 * Server data rather than draft state: it describes what the machine has, not
 * what the operator chose. Answers for a path that is no longer on screen are
 * discarded, so a slow lookup can never describe the wrong folder.
 */
export function useGitContext(
  hostId: string,
  path: string,
  load: (hostId: string, path: string) => Promise<WorkspaceGitContext>,
  debounceMs = 300,
): GitContextState {
  const [state, setState] = useState<GitContextState>({ status: "idle" });
  const requestRef = useRef(0);

  useEffect(() => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    if (!looksLikePath(path)) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      void load(hostId, path.trim())
        .then((context) => {
          if (requestRef.current === request) setState({ status: "loaded", context });
        })
        .catch((error: unknown) => {
          if (requestRef.current !== request) return;
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "This folder could not be inspected.",
          });
        });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [debounceMs, hostId, load, path]);

  return state;
}
