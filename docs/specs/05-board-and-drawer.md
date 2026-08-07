# 05 — Board, thread drawer, and the assistant-ui thread

**Status:** Accepted · **Depends on:** 01, 04, 12 · **Blocks:** 06, 07, 08, 09, 10
**Design frames:** `7a` (board), `4a` `4b` (drawer + thread), `11b` (subagent expanded)
**Read from:** `docs/design/cockpit/Cockpit Prototype.dc.html` — turns 4 and 7 were truncated
out of the redesign file (see `docs/design/cockpit/NOTES.md`).

## Purpose

Replace the host-grouped session list with a repository → worktree board, and open a selected
session as an overlay drawer so the board stays visible underneath. This is the structural
change; every other web spec hangs off it.

## Requirements — board (`7a`)

### R1 — Layout

Column flex, full viewport height, **no page scroll** (`body { overflow: hidden }` already holds
in `web/src/styles.css`).

- **Header**, 46px tall, 24px horizontal padding: a 9px lime status dot; the wordmark in
  11px/1 mono, uppercase, `letter-spacing: 0.14em`, `--text-muted`; flex spacer; a ⌘K search
  button and a `?` button (both 28px tall, 1px `--border-hairline`, transparent fill); a
  **New thread** pill (32px, lime fill, ink text, fully round, 600 13px).
- **Filter row**, 24px horizontal / 18px bottom padding: four scope buttons
  (All / Wants you / Working / Idle) at 13.5px — active 600 and `--text`, inactive 400 and
  `--text-muted`. **Wants you is lime in both states.** Each carries a count in 11.5px mono.
  Then a 1px × 16px divider, then host buttons with a laptop (local) or server (remote) glyph;
  local is near-white, remote hosts violet. Clicking a host filters; inactive hosts dim.
  Right-aligned: a hint line in 11.5px mono.
- **Board**: horizontal flex, `gap: 1px` over a `--rule` background, so **the gap draws the
  column rules**. Columns are 302px wide, `padding: 0 20px`, `overflow-y: auto`, app background.

> **`box-sizing: border-box` on the column is mandatory.** The handoff calls this out as a bug
> they already hit and fixed (`github.md`). The global reset covers it; do not undo it locally.

- Each column ends with a dashed **New thread here** button, so a column reads as finished rather
  than trailing off. It seeds a draft session in that worktree (spec 06).

### R2 — Column and group heads

- Column head: repo name 600 12.5px `letter-spacing: -0.01em`, plus a count in 11px mono.
- Worktree head: a branch glyph — **lime when this is a linked worktree, muted when it is the
  main checkout** — the branch in 500 11.5px mono, and a `worktree` tag (uppercase, 9.5px mono,
  `letter-spacing: 0.06em`) only when linked. A second line, indented 19px, carries an amber
  dirty count with a 5px dot, and the directory in 10px mono.
- Every one of those facts comes from `workspaceIdentity` (spec 04). **A `null` fact renders as
  absent, never as a zero or a guess** — no `0 uncommitted`, no invented branch.

### R3 — Card states

Square (no radius), 12px/14px padding, 6px bottom margin, a 2px full-height tick on the left
edge, and a state-driven fill:

| State | Fill | Tick | Body text |
| --- | --- | --- | --- |
| Wants you | `oklch(0.185 0.022 118)` | lime | `oklch(0.9 0.14 118)` |
| Working | `oklch(0.15 0 0)` | `oklch(0.6 0 0)` | `oklch(0.7 0 0)` |
| Failed | `oklch(0.15 0.012 25)` | `oklch(0.62 0.16 25)` | `oklch(0.75 0.1 25)` |
| Idle | `oklch(0.145 0 0)` | `oklch(0.28 0 0)` | `oklch(0.48 0 0)` |

Title 600 13.5px truncating; time right-aligned in 10.5px mono; a state line in 12.5px/18px.
Two compact fact chips follow: `Harness · Codex|Claude` and `Project · <repo name>`. Project is
the repository name only — never a path, branch, or worktree. When git identity is absent, use the
last cwd segment; when cwd is absent too, state `Unknown project`. Desktop and phone consume these
same board-model facts, and the phone does not add a second `repo · branch` footer. The clickable
card and fact chips use the local shadcn `Button` and `Badge` components; assistant-ui remains the
thread renderer inside the drawer. An optional host row (server glyph, violet) follows for remote
sessions.

### R4 — State derivation

Derive the four states from what already exists — do not add a parallel status field.

| Board state | Condition |
| --- | --- |
| Wants you | `session.attention` is non-empty and unresolved |
| Working | activity is `running` |
| Failed | last lifecycle terminal event is `turn-failed`, or status is a failure |
| Idle | everything else |

`groupState` (`web/src/components/session-activity.tsx:81-97`) already prefers the last terminal
lifecycle event over child states, deliberately so a lingering running child cannot mask a failed
turn. Reuse that precedence rather than reimplementing it.

### R5 — Heuristic attention is visibly inferred

The design gives "wants you" one appearance. But an external session's attention can be a
transcript inference with `id: null`, `confidence: "heuristic"`
(`web/src/lib/normalize.ts:162-168`, `agent-sessions.ts:671-677`). Rendering it identically to
a provider-issued request would be the exact unearned confidence this project exists to avoid,
and would put a card in the lime "answer me" state that cannot be answered.

Heuristic attention stays in the Wants You scope, but uses a **hairline dashed lime** left edge,
muted body colour, and the exact state line `looks blocked — from transcript`. It never renders
answer controls and never triggers an operating-system notification. Exact provider-issued
attention retains the solid lime treatment.

### R6 — Ordering and interaction

- Column and card ordering come from `buildBoard` (spec 04 R5) and must be **stable**. The
  operator is aiming at a card; do not reorder on every SSE tick.
- Click a card → opens the drawer. Shift- or cmd-click → starts or extends a selection instead
  (spec 10). Checkboxes appear on cards **only once a selection exists** — the resting board
  stays quiet.
- `Esc` closes the drawer, palette, shortcut sheet, or any open menu.
- Scope and host filter are URL state, extending what `lib/session-navigation.ts` already does
  with `?scope=` / `?session=` and `history.replaceState`.

## Requirements — drawer (`4a`)

### R7 — Overlay, not a push layout

`position: absolute`, pinned right, full height, **760px wide**, background `oklch(0.115 0 0)`,
1px left border, `box-shadow: -50px 0 120px rgb(0 0 0 / 0.8)`, above the board.

**The board is not pushed aside.** That is the whole point of the drawer over a route change:
the operator keeps their place.

- Header, 16px/22px padding: session name 600 15px, then fact chips (host, branch, dirty) —
  raised fill, 4px/9px padding, 11.5px mono; the dirty chip amber. Close button right.
- Body: `overflow-y: auto`, 24px horizontal padding, **20px gap between turn parts**.
- Composer pinned at the bottom (spec 06).

### R8 — Honest retention boundary

The drawer scrolls the one selected-session materialisation, bounded to 400 semantic items or
1 MiB. The existing REST activity route pages that already-truncated buffer and therefore is
not real backscroll. Delete it and its tests. When older content has been evicted, render a
retention-boundary banner and offer native attach/provider history as the durable source.

Manager-owned, external, re-adopted, remote, unreadable, and not-found states all enter this
same selected-session SSE/activity store; no `session.messages` fallback is permitted.

## Requirements — thread

### R9 — Use assistant-ui's own grammar

`@assistant-ui/react@0.15.2` is already a dependency and `session-thread.tsx` already runs
`useExternalStoreRuntime`. Deepen it rather than hand-rolling around it.

`MessagePrimitive.GroupedParts` (`node_modules/@assistant-ui/react/dist/primitives/message/MessagePartsGrouped.d.ts`)
takes a `groupingFunction` and a `components.Group` slot, supports **adjacent grouping with
nested group paths**, and dispatches all rendering through one `switch (part.type)`. That is
precisely the design's tool-group disclosure and one-level subagent spine. Use it; the older
`Unstable_PartsGrouped` is deprecated in favour of it.

Map items to native part types wherever one exists, and keep `data` parts only for the kinds
assistant-ui has no concept of:

| Activity kind | assistant-ui part |
| --- | --- |
| `message` | `text`, on a user or assistant message |
| `reasoning` | `reasoning` |
| `tool` | `tool-call` |
| everything else | `data`, named `agent-manager.<kind>` |

Delete the `[System] ` / `[Tool: label] ` string prefixes currently injected into message text
(`session-activity.tsx:275-286`). A role is not a prefix; render it.

### R10 — Tool group

A disclosure reading **"N tool calls"** in 12px 500 with a chevron rotated `-90deg` when closed,
and a duration in 11px mono. Opened, each call indents 22px and reads
`status glyph · tool name (500 11.5px mono) · detail (truncating) · duration`. Arguments and
results render in raised `pre` blocks at 12px/19px mono.

Every group starts collapsed and remains operator-toggleable, including while work is active; a
long command must not occupy the drawer merely because it is still running. The trigger has three
semantic presentations:

- **active** — at least one call is running, or a complete trailing run is in the provider's quiet
  gap before its next call;
- **waiting for answer/approval** — an unresolved attention item names a call in the group as its
  parent; this is static, never a spinner;
- **settled** — a message, thought, todo marker, plan, or attention request has closed the run, or
  the turn ended.

Aggregate diff, usage, and lifecycle bookkeeping do not manufacture a work boundary. A resolved
question keeps the completed pre-question group settled; genuinely running parent work may become
active again, and a later tool starts a new active run.

### R11 — Subagents, one level

A 2px violet left spine, 15px inner padding, the brief in a raised block, its own steps in the
same grammar, and a footer rule stating what it returned (diff totals, tokens, cost) in 11px
mono violet-muted.

**Nesting stops at one level.** A subagent that spawns another shows a count, not a third indent.

`childItemIds` and `parentId` exist in the contract (`src/activity/types.ts:62-79`,
`:125-132`) and are currently dropped by the UI (`session-activity.tsx:528` renders only
`childItemIds.length`). Render the nesting.

### R12 — Turn marker

A hairline top border carrying end time, duration, subagent count, diff totals, tokens and cost
in 11px mono. Every one of those is a fact from `usage` and `file-change` items — **omit any the
provider did not supply** rather than showing a zero.

### R13 — Invariants that survive

Restated from `00-overview.md` because this spec is where they are most at risk:

- `exactCurrentActivityRequestIds` (`session-thread.tsx:126-145`) and
  `mergePendingAttentionRequests` (`:147-190`) keep their exactness gate. Do not relax it to make
  a design frame render.
- `isRunning: false` on the external store (`:601-604`) stays — assistant-ui must not invent an
  empty running message. The composer's send/stop state comes from session activity instead.
- Composer `onKeyDown` `preventDefault` for unsupported delivery (`:353-361`) stays, or the
  draft is lost.
- Frames stay coalesced to one React commit per animation frame
  (`use-session-activity.ts:100-117`). The board makes this more important, not less.

## Removals (spec 13)

`session-sidebar.tsx` · the duplicate `session.messages` timeline path and everything behind it
· `session-badges.tsx` · the sidebar layout tokens. Spec 13 owns the exact cutover list.

## Acceptance criteria

1. Board renders repo columns split by worktree, with column rules drawn by the 1px gap, and no
   horizontal overflow inside a column.
2. A linked worktree shows the lime glyph and `worktree` tag; the main checkout shows neither.
3. A `null` dirty count renders nothing — verified by test, not by looking.
4. Selecting a card opens the drawer with the board still visible and un-shifted.
5. A turn with 6 adjacent tool calls renders one "6 tool calls" disclosure, collapsed, expanding
   to the indented grammar. Active, waiting, and settled are distinguishable without forcing the
   body open.
6. A subagent renders its spine, brief, steps and return footer; a nested subagent shows a count.
7. An evicted prefix shows the retention boundary; no UI or route claims to load content no
   longer retained.
8. Every test guarding R13 passes unmodified.
9. Heuristic attention is visually distinct, non-actionable, and covered by a regression test.
10. One board domain model feeds two presentations: desktop columns and the spec 11 mobile
    bands. Session ordering/state derivation is shared; only layout components differ.
11. Every desktop and phone card labels its harness as Codex or Claude and its project with only
    the resolved repository name; neither card presentation exposes the project path or branch.
