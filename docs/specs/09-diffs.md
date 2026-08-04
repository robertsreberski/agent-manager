# 09 — Diff viewer

**Status:** Draft · **Depends on:** 05 · **Design frames:** `10a` (inline), `10b` (review drawer),
`13a` (phone)

## Purpose

Make file changes readable. Today they render as an unstyled `<pre>` with no highlighting, no
line numbers and no folding (`web/src/components/session-activity.tsx:358-366`, `:504-520`) —
the weakest surface in the current cockpit.

## Background

`ActivityFileChangeItem` (`src/activity/types.ts:119-123`) carries
`changes: { path, operation, diff }[]` where `operation` is `add | update | delete | rename` and
`diff` is raw unified-diff text. Codex streams patch updates through
`item/fileChange/patchUpdated` and `turn/diff/updated`; the `diff` append channel already exists
(`ActivityAppendChannel` includes `"diff"`).

Everything this spec needs is already in the payload. **The parsing is client-side; no new
backend surface is required.**

## Requirements — inline (`10a`)

### R1 — Inside the tool disclosure

One collapsible block per file inside the `apply_patch` (or equivalent) disclosure, each with its
own `+n −m` counts and a copy button.

- Two gutters — old and new line numbers, 38px each, right-aligned, muted.
- A 16px sign column, then the line.
- Added: green tint on green text. Removed: red tint on red text. Exact values in spec 12.
- Hunk headers are raised strips at 11.5px/18px mono with an `expand` link.
- **A file already read stays shut.**
- Unified/split is a toggle, not a screen.

### R2 — Parse defensively

The diff is provider text. Treat it as untrusted input, not as something well-formed.

- A malformed or unparseable diff **falls back to the raw `<pre>`** rather than throwing or
  rendering a wrong line count. Losing the pretty view is fine; showing the wrong lines is not.
- Handle the operations honestly: `add` has no old gutter, `delete` has no new gutter, `rename`
  shows both paths.
- Binary and "file too large" markers render as what they are, not as an empty diff.
- The item may be `truncated: true` (`ActivityItemBase`) — say so at the boundary rather than
  presenting a partial patch as complete.
- Diffs arrive incrementally via the `diff` append channel. Re-parsing on every append at token
  frequency is wasteful — parse on a debounce or on completion, and keep the frame-coalescing
  guarantee (`use-session-activity.ts:100-117`) intact.

### R3 — `expand` only expands what the patch contains

The `expand` link on a hunk header suggests revealing surrounding context. **Unified diffs
contain only the context lines the generator included** (typically 3).

- Where the patch carries more context than is shown, `expand` reveals it.
- Where it does not, **the link is absent.** It does not appear-and-fail, and it does not trigger
  a file read.
- Reading the file from disk to synthesise context is out of scope and would be wrong anyway:
  the working tree has moved on since the patch was generated, so the "context" would be a
  different file's lines presented as this diff's surroundings.

If context expansion turns out to matter, it needs a real endpoint returning the *blob at the
patch's base revision*, with the same path hardening as spec 08 R5. Not in this pass.

## Requirements — review drawer (`10b`)

### R4 — Shape

A 268px file list with per-file counts and a read tick, then the diff. The header states branch,
file count, totals and whether the work is uncommitted — all available from `workspaceIdentity`
(spec 04) and the file-change items.

Split view is two 50% columns divided by a 1px rule, lined up hunk for hunk.

### R5 — Nothing here writes

**The escape hatch is `Open in editor`.** No staging, no reverting, no committing. The cockpit
observes and steers agents; it is not a git client, and a write surface here would be a second
way to change the working tree that the agent does not know about.

`Open in editor` is a local process spawn with an editor argv. Reuse the pinned-executable
discipline from `src/ops/attach.ts` (`assertPinnedExecutable`, absolute path only, no shell) —
this is the same class of operation as attach and deserves the same handling.

### R6 — Read state

Per-file `read` flags are client state, scoped to the session and the turn. A file that changes
again after being marked read becomes unread — the tick means "I have seen these lines", not "I
have seen this filename".

Not persisted server-side.

## Requirements — phone (`13a`)

### R7 — Unified only, and lines wrap

One 30px gutter, a 13px sign column, and lines that **wrap rather than scroll sideways**. The
file list moves to a bottom sheet; the footer offers `Mark read` and `Next file`.

Wrapping a diff line must not break the gutter alignment — the sign and gutter stay on the first
visual row, and continuation rows indent to the text column.

## Scope note

Syntax highlighting is **not** in this spec. The design specifies diff tinting (added/removed),
not language colouring, and a highlighter is a dependency, a bundle cost and a per-language
correctness problem. If it is wanted later it layers on top of the parsed lines.

## Acceptance criteria

1. A multi-file patch renders one collapsible block per file with correct `+n −m` counts.
2. Old and new gutters are correct across added, removed and context lines, verified against a
   patch with multiple hunks and uneven hunk sizes.
3. `add` / `delete` / `rename` operations each render their correct gutter and path treatment.
4. A malformed diff falls back to `<pre>` and logs nothing user-visible.
5. A truncated file-change item says so at the truncation boundary.
6. `expand` is absent where the patch carries no further context, and no code path reads a file
   from disk to produce context.
7. Split view aligns hunk for hunk; toggling preserves scroll position and read state.
8. On a 390px viewport, no diff scrolls the page horizontally.
9. `Open in editor` spawns with an absolute pinned executable and no shell.
10. Nothing in the review drawer mutates the working tree.
