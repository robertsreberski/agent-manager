# 08 — Plan artifact and todo list

**Status:** Draft · **Depends on:** 05 · **Design frames:** `14a` `14b` (plan), `15a` `15b` (todos)

## Purpose

Two objects that both look like lists, and the design is emphatic that they are not the same
thing. Today one backend type serves both, which is why the current UI can only render one of
them well.

| | Plan | Todos |
| --- | --- | --- |
| what | a markdown document on disk | an in-memory checklist |
| path | always shown | none |
| history | versioned; v1 readable next to v3 | one live list that rewrites itself |
| you | approve it or send it back | read it |
| when | plan mode, before anything runs | any mode, while it works |
| ends | kept, outlives the turn | collapses to one line |

## Requirements — the split

### R1 — Two item kinds

`ActivityPlanItem` (`src/activity/types.ts:96-100`) currently carries `text` + `steps[]` and is
fed by Claude's plan output *and* Codex's `turn/plan/updated` *and* `TodoWrite`. Split it:

```ts
interface ActivityPlanItem extends ActivityItemBase {   // the document
  kind: "plan";
  path: string | null;        // supplied by the harness; NEVER constructed client-side
  version: number;
  markdown: string;
  supersededBy: string | null;
  approvedAt: string | null;
}

interface ActivityTodoItem extends ActivityItemBase {   // the checklist
  kind: "todo";
  steps: ActivityTodoStep[];  // { id, text, status, detail? }
  added: number;              // churn since the list first appeared
  removed: number;
}
```

Delete the merged type rather than aliasing it (spec 13 §D1). `PlanRow`
(`web/src/components/session-activity.tsx:414`) goes with it.

### R2 — Provider mapping, honestly

| Source | Produces |
| --- | --- |
| Claude plan file (`~/.claude/plans/*.md`) + ExitPlanMode | `plan` — with a real `path` |
| Claude `TodoWrite` | `todo` |
| Claude `TaskCreated` / `TaskCompleted` hooks (spec 03) | `todo` |
| Codex `turn/plan/updated`, `item/plan/delta` | **`todo`** |

**Codex has no plan document.** It emits structured steps. Rendering those as a "plan artifact"
with a version tag and a path chip would be inventing a file that does not exist.

So: Codex plan mode renders in the **todo grammar** — neutral chrome, no lime tile, no path, no
version. If Codex later gains a plan document, it gets the plan grammar then.

`path` is `null` unless the harness supplied it. The design's path shape
(`/tmp/agent-manager-<uid>/plans/<session-id>-v<n>.md`) is a *description of what Claude
produces*, not a template for the cockpit to fill in. The design says so:
*"supplied by the harness — never constructed client-side."*

## Requirements — plan (`14a`, `14b`)

### R3 — In the thread

A card reading `Wrote a plan · <its own first heading>` with a version tag (`v3`) and — **at
every size, collapsed or open** — a path chip: file glyph, the path in 11.5px mono truncating
**from the left** (`direction: rtl; text-align: left`), and a copy glyph.

Opened, the card renders **the markdown as written**: monospace 13px/21px on a 2px left rule,
headings 600, body near-white.

> **Do not parse it into rows or prettify it; it is the text on disk.** The design states this
> twice. A plan is prose the operator is being asked to approve — reformatting it changes what
> they are approving.

Actions: `Send it back with notes` and `Execute this plan` (lime pill, bolt glyph). A line states
`nothing has run — the mode is Plan`.

### R4 — After executing

The plan collapses to a reference line (`Executing v3 · approved 11:06`) with its path still
attached, and the work hands off to the todo list underneath.

> **Progress never renders against the plan.** Prose has nothing to tick. The earlier draft of
> the design showed ticks against plan steps; `14a`'s final version removes that, and the reason
> is in the handoff: a document is not a checklist.

### R5 — The file view (`14b`)

The same prose full-height: path in the header, copy and download beside it, revisions as tabs
(`v3 11:04` active), and added/removed **lines of prose** tinted green/red. A footer states the
change in words and offers `Execute v3`.

Revisions need `{ version, writtenAt, path, superseded }` per plan. Source them from the
harness's own plan files; do not synthesise a history the harness did not keep.

**Reading a plan file is a filesystem read of a path the provider named.** Route it through the
same hardening as `src/server/transcript.ts:193-259` — uid-owned root, no symlink component
including the leaf, `O_RDONLY|O_NOFOLLOW`, dev/ino re-verified after open. Do not add a
general-purpose file-read endpoint; scope it to plan paths the provider actually emitted for
that session.

## Requirements — todos (`15a`, `15b`)

### R6 — Neutral chrome, deliberately

A grey list glyph, no lime tile, no path, no version — *because there is no artifact behind it*.
Call it **Todos** everywhere; never "task list". The header reads
`Made a todo list · 5 todos`, and the items are **todos**, not "tasks".

### R7 — Pinned while running

Created inline like any tool result. While the turn runs it **pins just above the composer** in a
bordered box, header reading `Todos · 2 of 6` with a tick bar (16px × 3px segments: done lime,
current dim-lime, pending grey).

Rows: done = lime check, struck through; **current = spinner, 600 weight, brightest text, with a
detail line**; pending = a 9px hollow circle.

### R8 — Churn is a fact worth showing

When the harness **rewrites its own list**, additions take a green plus and dropped items a dash
with a reason, and a footer counts the churn (`+1 −1 since it started`).

This is the most faithful thing in the whole design: a list that keeps growing is a real signal
about how the turn is going, and a UI that silently replaced the list would hide it. `added` /
`removed` on the item (R1) exist for this.

Finished, the list collapses to one line with the tick bar and duration.

### R9 — Todos become the session's progress everywhere

Once a list exists it is the session's progress in every surface: the board card's state line
becomes the current todo with a tick bar (spec 05 R3), plus a header chip in the drawer and a row
in the palette.

Always `n of m`, **never a percentage**. Sessions without a list show nothing — no empty bar.

### R10 — Stalled

The only place todos raise their voice: an amber field, `No todo has moved in 9 minutes`, and
explicitly **"It is not blocked on you"** — otherwise it reads like a question the operator
missed. Actions: `Ask what is happening`, `Stop the turn`.

The threshold is derived from the last todo transition, not from turn start. A long single todo
is not stalled; a list that has not moved is.

`Ask what is happening` sends a message, so it requires `queue`/`steer` — on a session without
them (`claude-hook-bridge`, `observe-only`) show only `Stop the turn`, or neither.

## Removals (spec 13 §D1)

The merged `ActivityPlanItem` and `PlanRow`.

## Acceptance criteria

1. A Claude session in plan mode produces a `plan` item with a real path, renders its markdown
   verbatim, and offers approve / send back.
2. A Codex session in plan mode produces `todo` items with **no path chip and no version tag** —
   no synthesised file.
3. Approving a plan collapses it to a reference line; **no progress ever renders against plan
   steps**.
4. A plan path outside the provider-declared set, or reached through a symlink, is refused.
5. A rewritten todo list shows the plus/dash markers and a correct churn footer.
6. A session with a todo list shows `n of m` on its board card; one without shows nothing.
7. Stalled state appears only from todo inactivity, says it is not blocked on the operator, and
   offers only the actions the session's plane supports.
8. The word "task" does not appear in any todo surface.

## Open questions

- **Q1.** Does Claude Code emit the plan file path in a way the SDK/hook stream exposes, or must
  it be inferred from `~/.claude/plans/`? Inference by directory listing would be a guess about
  which file belongs to which session — if the path is not in the stream, `path` stays `null` and
  the path chip does not render.
- **Q2.** Plan revisions (`14b`) assume multiple versions exist on disk. Confirm the harness keeps
  v1 when it writes v2; if it overwrites, the tabs show one version and the diff tinting is
  unavailable. Do not fabricate a previous revision from memory.
