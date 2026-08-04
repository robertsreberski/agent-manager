# 06 — Composer, draft sessions, and the invisible lease

**Status:** Draft · **Depends on:** 01, 05 · **Design frames:** `5a` (composer), `6b` (queued messages)
**Read from:** `docs/design/cockpit/Cockpit Prototype.dc.html` — turns 5 and 6 were truncated
out of the redesign file.

## Purpose

Three changes that are really one: the composer owns harness, model, effort, mode and access for
the life of the session; a new session is an empty thread rather than a modal; and the lease
stops being something the operator holds.

## Requirements — the composer (`5a`)

### R1 — Shape

1px border, `border-radius: 16px`, raised fill, 14px padding. A textarea
(`min-height: 52px`, `max-height: 120px`, 15px/22px, transparent, borderless) over a control row
with `gap: 14px`:

- **Harness + model** — a 17px lime tile with the harness mark, the harness name in 500 13px, the
  model in muted. Opens a menu with Harness / Effort / Access and a **Reset to default** row.
- **Effort meter** — three 3px bars, `gap: 2px`; filled bars 11px tall and lime, empty ones 7px
  and dim.
- A 1px × 14px divider, then **mode** with a chevron; the menu carries number shortcuts 1–4 and
  renders Full access in orange.
- An **access chip appears only when access is not standard** — orange fill and text, shield glyph.
- Right: attach and mic glyphs, then one 30px round button — lime with an up arrow to send,
  near-white with a square to stop while a turn runs.
- A hint right of the glyphs stating what will happen: `↵ sends` when idle, `queues while
  running` when a turn is in flight.

**Controls read as text with a glyph, not as buttons, until touched; the open one takes a filled
pill. Only the round button is solid.** This is the composer's whole visual thesis — do not
promote the controls to buttons.

### R2 — Mid-session settings need new actions

None of harness/model/effort/access is changeable today. Extend `sessionActionSchema`
(`src/server/contracts.ts:50-72`) and `requiredCapability()` (`:233-244`), per spec 01 R2:

| Action | Capability | Codex | Claude |
| --- | --- | --- | --- |
| `set-mode` | `set-mode` | `thread/settings/update` | `permission_mode` |
| `set-model` | `set-model` | `thread/settings/update`; options from `model/list` | **spike** |
| `set-effort` | `set-effort` | `thread/settings/update` | **spike** |
| `set-access` | `set-access` | `approval_policy` + `sandbox_mode`; options from `permissionProfile/list` | `permission_mode` |

All four carry `expectedGeneration` + `idempotencyKey` like every other action.

**Harness is not changeable.** A session belongs to the provider that created it. The harness
row in the menu is a picker for a *draft* session only (R5); on a live session it renders as a
fact, not a control.

**Spike required before implementing the Claude column**: does `@anthropic-ai/claude-agent-sdk`
`0.3.220` support changing model or effort on a live query? `/model` and `/effort` exist as
slash commands with arguments, which suggests a session-level setter, but the SDK surface must be
checked. If it does not, `set-model` / `set-effort` are absent from the `claude-sdk` plane and
the controls render disabled with the reason — per spec 01 R7's `withheld`.

### R3 — Four modes, replacing two

`planning | execution` becomes the design's four. Mapping:

| Design mode | Claude `permission_mode` | Codex |
| --- | --- | --- |
| Ask first | `default` / `manual` | `approval_policy: on-request` |
| Plan | `plan` | plan mode |
| Execute | `acceptEdits` | `approval_policy: on-failure` |
| Full access | `bypassPermissions` | `approval_policy: never`, `sandbox_mode: danger-full-access` |

A provider that cannot express a mode does not offer it. **Full access renders in orange
everywhere it appears** and is the one mode whose selection is worth a confirmation.

Delete the two-value enum outright (spec 13 §C3) — there is no stored state to migrate.

### R4 — Queue vs steer is asymmetric and must stay so

Existing behaviour, preserved: `↵` queues while a turn runs, `⌘⇧↵` steers now, `⌘.` stops.
The composer's `onKeyDown` must keep calling `preventDefault` when the delivery mode is
unsupported — assistant-ui clears the composer *before* the queue adapter runs, so without it the
operator's draft vanishes (`web/src/components/session-thread.tsx:353-361`). There is a test for
this; it stays.

The `queue` adapter's `steer` / `remove` / `clear` remain deliberate no-ops
(`session-thread.tsx:586-598`) — the **server owns the queue**.

### R5 — Queued messages live in the thread (`6b`)

A queued message is a message, so it belongs on the user side of the thread: same bubble
geometry, but `1px dashed`, dimmer fill and text, numbered in send order with a remove button.

A labelled rule separates sent from unsent — two hairlines around
`Queued · sends when this turn ends` in 11px mono, uppercase, `letter-spacing: 0.1em`.
**The composer keeps only the count.**

## Requirements — draft sessions

### R6 — A new session is an empty thread

Delete `launch-dialog.tsx` (spec 13 §C1). Replace it with a client-side **draft session**:

- Created by **New thread** (header) or **New thread here** (column footer). The column footer
  variant inherits `hostId`, `repoRoot` and `worktreePath` from the column it sits in — that is
  most of what the dialog used to ask for.
- The draft has no server id. It opens the drawer with an empty thread and a focused composer.
- Harness, model, effort, mode and access are pickable on the draft and become the create
  parameters.
- **On first send**, `POST /api/v1/sessions` runs with the existing persisted-idempotency
  machinery (`web/src/lib/create-attempt.ts`, `beginCreateSessionIntent` in
  `src/server/server.ts:1038-1210`) and the draft is replaced by the real session. The message is
  the initial prompt.
- Workspace resolution still uses `POST /api/v1/workspaces/resolve`, and the header **New thread**
  variant — which has no column context — still needs a path input with completion from
  `GET /api/v1/hosts/:id/directories`. Keep both endpoints; only the modal goes.

### R7 — Draft failure is visible, and never silently retried

`CREATE_OUTCOME_UNKNOWN` already exists and is deliberately never replayed
(`src/server/server.ts:1038-1210`). A draft whose creation outcome is unknown must say so and
offer the operator the choice, rather than resolving itself. The composer is the surface for that
message.

## Requirements — the lease

### R8 — Keep the mechanism, delete the affordance

The lease is real single-writer safety: a rotating token, 60s TTL, a 15s recovery window,
principal bound to auth session + actor + client id (`src/server/controls.ts:65-216`). Two
browser tabs steering one session concurrently is a genuine hazard.

But the operator should never hold it.

- `use-cockpit.ts` and `lib/api.ts` keep `acquireLease` / `releaseBrowserLeases` and the renewal
  loop. **Acquire on first write intent** — focusing the composer or opening a decision — not on
  session selection, and release on drawer close.
- Delete Take control, Release control, expiry countdowns and full-host arming (spec 13 §C2).
- **Nothing is disabled solely because no lease is held.** If a control is enabled by capability,
  it is enabled; acquiring the lease is the client's job, transparently.
- The one surviving surface is `LEASE_CONFLICT`: a toast reading that another window is steering,
  with takeover behind it. Not a lease control — a conflict resolution.

Acceptance is mechanical: **no rendered string contains "lease", and no `disabled` expression
reads a lease field.**

### R9 — Read-only sessions say why

A session whose plane offers no `queue`/`steer` — `claude-hook-bridge`, `tmux-attach`,
`observe-only` — renders the composer read-only with the reason from
`SessionControl.withheld` (spec 01 R7), and offers attach as the escape hatch.

**It must not look like a lease problem, a connection problem, or a bug.** "This session was
started in a terminal and cannot be steered from here" is the honest sentence.

## Removals (spec 13)

`launch-dialog.tsx` and its test (§C1) · every lease affordance (§C2) · the
`planning|execution` enum (§C3).

## Acceptance criteria

1. Composer controls render as text-with-glyph at rest and take a filled pill when open; only the
   round send/stop button is solid.
2. Changing mode mid-session takes effect and is reflected in the session state; changing it on a
   provider that cannot returns `409 CAPABILITY_UNAVAILABLE` and the control was already disabled
   with a stated reason.
3. Model and effort controls are enabled only where the provider supports them; the Claude spike
   result is recorded in this file.
4. `New thread here` in a column produces a draft in that worktree with no dialog, and first send
   creates the session with the composer's settings.
5. A duplicate first send (double-click, reconnect) creates exactly one session — the existing
   idempotency tests still pass against the new flow.
6. Sending while a turn runs produces a numbered dashed bubble under the labelled rule, removable.
7. `grep -ri lease web/src --include=*.tsx` returns no user-visible string.
8. Two browser windows steering one session: the second gets a conflict toast with takeover, and
   no action is silently dropped.
9. A `claude-hook-bridge` session shows a read-only composer with the plane's reason and an attach
   affordance.

## Open questions

- **Q1 (blocking R2).** Does the Claude Agent SDK support mid-session model/effort change?
- **Q2.** Full access is one click from Execute in the mode menu. Given it maps to
  `bypassPermissions` / `danger-full-access`, does it warrant a confirmation, and does that
  contradict the design's "controls read as text" thesis? Recommend: confirm on entering Full
  access only, reusing the single `dialog` the multi-select delete already needs.
