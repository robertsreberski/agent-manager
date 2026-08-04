# 04 — Workspace model: repositories and worktrees

**Status:** Draft · **Depends on:** nothing · **Blocks:** 05 · **Design frames:** `7a`

## Purpose

The board is organised by repository, then by worktree. Neither concept exists in the backend
today. This spec adds them.

`github.md` records the gap plainly: *"Worktrees. Not modelled upstream."*

## Background

A session's only spatial fact today is `workspace` / `cwd` (`src/core/types.ts:170-204`), plus
`hostId`. The sidebar groups by host (`web/src/components/session-sidebar.tsx`). The design
replaces that with columns per repository, each split into worktree groups, with hosts demoted
to a filter row.

Design `7a` needs, per group:

- Branch name, and whether this is a **linked worktree** or the main checkout (the branch glyph
  is lime for linked, `oklch(0.5 0 0)` for main, and a `worktree` tag appears only when linked).
- A dirty count (`3 uncommitted`), amber.
- The directory, shown relative and abbreviated (`../am-queue`).

## Requirements

### R1 — `src/core/worktree.ts`

One module, resolving a `cwd` to a workspace identity:

```ts
export interface WorkspaceIdentity {
  /** Absolute path of the main working tree — the repo's identity. */
  repoRoot: string;
  /** Display name for the board column. Basename of repoRoot unless overridden. */
  repoName: string;
  /** Absolute path of this working tree. Equals repoRoot for the main checkout. */
  worktreePath: string;
  /** true when this is a linked worktree rather than the main checkout. */
  linked: boolean;
  branch: string | null;      // null when detached
  detached: boolean;
  dirtyCount: number | null;  // null when not computed or the count is unavailable
  ahead: number | null;
  behind: number | null;
}
```

Resolution:

| Fact | Command |
| --- | --- |
| worktree root | `git rev-parse --show-toplevel` |
| main checkout | `git rev-parse --path-format=absolute --git-common-dir` → parent of `.git` |
| linked? | `--git-dir` differs from `--git-common-dir` |
| branch | `git rev-parse --abbrev-ref HEAD` (`HEAD` ⇒ detached) |
| siblings | `git worktree list --porcelain` |
| dirty | `git status --porcelain --untracked-files=normal` |
| ahead/behind | `git rev-list --left-right --count @{upstream}...HEAD` |

### R2 — It must never slow or break discovery

This runs against every discovered session on a 15s reconcile
(`src/discovery/reconciler.ts:59-116`, `scanTimeoutMs: 20_000`). A `git status` on a large repo
is not free.

- `spawn` with `shell: false`, argv only. A `cwd` is attacker-adjacent data — it comes from a
  process table. Never interpolate it into a shell string.
- Per-command timeout (≈2s) and a total budget for the pass. Timeout ⇒ `null` for that fact, not
  a failed scan.
- Cache per `repoRoot` with a short TTL. Cheap facts (`repoRoot`, `branch`, `linked`) may refresh
  every pass; `dirtyCount` and ahead/behind are expensive — refresh on a longer interval and on
  session selection.
- `dirtyCount: null` renders as *absent*, not as zero. A missing fact is not a clean tree.
- Never run git in a directory that is not a repo, and cache the negative. Sessions outside a
  repo group under a synthetic column keyed by the workspace path.
- Bound `git worktree list` output like every other external read in this codebase.

### R3 — Extend the session record

Add to `SessionRecord` / `SessionView` (`src/core/types.ts:170-215`), all optional so a
non-repo or remote session is representable:

```ts
workspaceIdentity?: WorkspaceIdentity | null;
```

A single nested object rather than six loose fields — it is one fact resolved atomically, and
partial mixtures (branch from one refresh, dirty from another) would be a lie.

Normalize defensively in `web/src/lib/normalize.ts`, matching how every other server field is
treated there.

### R4 — Remote hosts

SSH sessions (`src/remote/`) resolve their identity **on the remote host**, through the existing
node bridge, not by running git locally against a path that does not exist here.

If the remote cannot answer, `workspaceIdentity` is `null` and the session groups by workspace
path with no branch line. Do not synthesise a branch.

### R5 — Board grouping is derived on the client

`web/src/lib/session-navigation.ts` already builds the hierarchy forest and handles cycles. Add
a pure function beside it:

```ts
buildBoard(sessions, { scope, hostFilter }): BoardColumn[]
```

- Column key: `repoRoot` (host-qualified — the same path on two hosts is two repos).
- Column order: stable and predictable. Repos with a `wants` session first, then by most recent
  activity, then by name. Do not reorder on every tick; the operator is aiming at a card.
- Group key within a column: `worktreePath`. Main checkout first, then linked worktrees by branch.
- Sessions with no `workspaceIdentity` fall into a single group at the bottom of their column
  labelled by path.

Pure and unit-testable, like the rest of that module.

## Non-goals

- Creating, removing or switching worktrees. The design mentions a switcher (`github.md`); it is
  not in any frame and is not in this pass.
- Git operations of any kind that write. This module is read-only.
- Intercepting the harnesses' own worktree hooks (Claude's `WorktreeCreate`/`WorktreeRemove`).
  Reading git is simpler and works for sessions that predate the bridge.

## Acceptance criteria

1. A session in a linked worktree reports `linked: true`, the correct branch, and a `repoRoot`
   equal to the main checkout — so it columns with its siblings rather than forming its own.
2. A session in a non-repo directory produces `null` identity and still appears on the board.
3. A repo with 10k dirty files does not extend a reconcile pass beyond its budget; the count
   degrades to `null`.
4. A `cwd` containing spaces, quotes or a leading hyphen resolves correctly and spawns no shell.
5. Deleting a worktree between passes does not throw; the session regroups.
6. `buildBoard` has unit tests for ordering stability, host-qualified repo keys, and the
   no-identity fallback group.
7. Remote sessions resolve via the bridge or degrade to `null` — never by running local git.
