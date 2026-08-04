# 11 — System states, session panel, phone, first run

**Status:** Draft · **Depends on:** all · **Design frames:** `8b` (system states), `9b` (session
panel), `13b` (header facts), `13c` (first run), `9a-1`…`9a-5` (phone)

## Purpose

The states the cockpit is in when it is not showing a healthy session, the panel that answers
"what is this session allowed to do", and the two viewports the design treats as first-class.

## Requirements — system states (`8b`)

### R1 — Connecting

**Say what is being read.** Not a spinner over nothing — "reading tmux panes", "scanning
~/.codex/sessions". Discovery is a multi-source process with real latency
(`src/discovery/reconciler.ts`, 15s interval, 20s scan timeout) and naming the source is both
more honest and more useful than a generic wait.

Skeletons are raised blocks with dimmer bars pulsing at 1.6s.

### R2 — Offline

Amber. **States how stale the view is** — "Lost the daemon 40s ago… a snapshot from 10:31" — and
**keeps the composer writable**. Messages queue locally and flush on reconnect.

> Losing the daemon is not losing the agents. They are still running; only our window closed.

### R3 — The offline outbox is the sharpest friction in the redesign

Every action carries `expectedGeneration` and an `idempotencyKey`
(`src/server/contracts.ts:17-21`), and the server rejects a stale generation with
`409 STALE_GENERATION` (`src/server/server.ts:1418-1423`). A message composed at generation N may
flush at N+5.

Naively re-sending with a refreshed generation would deliver the operator's message into a
conversation that has moved on — the agent may have finished the turn, changed mode, asked and
been answered, or failed.

At flush time, for each queued message:

1. Re-read the session's current generation and capabilities.
2. If the session is **materially unchanged** — same turn, same mode, still steerable — send with
   the refreshed generation and the original idempotency key.
3. If it has **materially moved** — the turn ended, the mode changed, an attention request
   appeared or resolved, the capability is gone — **do not send.** Surface the message back in
   the composer with what changed, and let the operator decide.
4. If the session no longer exists, or the plane no longer permits the action, say so and keep
   the text.

"Materially changed" must be defined concretely in the implementation and unit-tested, not left
to judgement at the call site.

The outbox is per-session, capped, and **never persisted across a page load** — a message the
operator does not remember writing must not appear in an agent's queue.

### R4 — Session ended

Offers to continue in the same worktree carrying the history, **rather than going grey**. That is
`thread/fork` or a resume with the same `worktreePath` — and where neither is available, the
offer is absent rather than broken.

### R5 — Empty

Lists the repositories already known so the first action is one click. Sources: previously
resolved workspaces (`GET /api/v1/workspaces`) and repos discovered from any session ever seen.

## Requirements — session panel (`9b`) and header facts (`13b`)

### R6 — Four questions in order

1. **Where it runs** — host, repo, worktree with dirty count, harness.
2. **What it may do** — capabilities.
3. **What this turn cost** — tokens, cost, from `usage` items and, for Codex,
   `account/usage/read` / `account/rateLimits/read` (appendix §1.4).
4. **How to attach from a terminal.**

The access dropdown sits with (2) because it is changeable mid-session (spec 06 R2).

**No lease controls** (spec 06 R8).

### R7 — Capabilities are sentences, never provider strings

> Capabilities are plain sentences with a tick / question mark / cross — **never provider strings
> like `danger-full-access`.**

This is where `SessionControl.withheld` (spec 01 R7) earns its place: a cross needs a reason, and
"the provider does not support changing the model mid-session" is a sentence while
`set-model: false` is not.

The question mark is not decoration — it is for the genuinely unknown, which is common for
discovered sessions where evidence is `heuristic`. Do not resolve a question mark into a tick or
a cross by guessing.

### R8 — Attach

The browser is only ever shown the **owner-socket wrapper command**, never a raw provider
command (`src/server/server.ts:802-811`):

> `// Returning a raw provider command here would let a copied command bypass the native handoff`
> `// state machine and race the manager for ownership.`

That constraint survives the redesign unchanged. `13b` is the cheap version of the panel: four
facts in the thread header at rest, the rest expanding in place on hover, with cost history and
End session behind the `…` menu.

## Requirements — phone (`9a`, `13a`)

### R9 — 390 × 844

- The board becomes **one list in three bands** — wants you, working, idle — and **wants-you rows
  carry the actual question**, not a badge. Where the question is not exactly known (spec 05 R5),
  the row carries the evidence instead, and must not present an inference as a question.
- The thread keeps the desktop grammar with the tool group collapsed and **46px option targets**.
- Approvals arrive as a bottom sheet with two full-width 48px buttons.
- The composer drops only the `⌘L` focus hint.
- Multi-question forms move the `Send N answers` button to a sticky footer (`9a-4`).

The existing iOS PWA work — safe-area utilities, `overscroll-behavior: none`,
black-translucent status bar, `--touch-target: 2.75rem` on coarse pointers — carries over from
`web/src/styles.css` and `web/index.html`. Keep it; it is already correct.

### R10 — One board component or two?

Open (spec 05 Q2). The three-band phone list is a different information structure, not a
narrower board — bands are not columns. **Recommend one `buildBoard` producing both groupings**
(spec 04 R5) with two presentation components, so ordering and state derivation cannot drift
between viewports.

## Requirements — first run (`13c`)

### R11 — Ask for one thing

**A folder** — and offer the ones already visible nearby as one-click chips, sourced from
discovery: any repo a running session is already in.

Hosts are a **later, optional step**, framed as "anything you can already reach over SSH". The
check reports what it found, **including a missing harness**, which quietly limits what that host
can be asked to do rather than failing the setup.

That "quietly limits" is the same capability honesty as everywhere else: a host without Codex
installed is a host that cannot run Codex sessions, and the UI should say so at the point of
choosing rather than at the point of failing.

### R12 — The hook bridge belongs in first run

Spec 03's installer writes to the operator's `~/.claude/settings.json` / `~/.codex/hooks.json`.
That is a consequential, consent-requiring action and first run is where it should be offered —
with the diff shown, the benefit stated ("see and answer sessions you started in a terminal"),
and declining fully supported.

Never install as a side effect of setup completing.

## Removals (spec 13)

`access-sheet.tsx` is rewritten into the session panel — its `AttachCommand` copy behaviour and
terminal preview survive; the lease-adjacent surface does not (§C2).

## Acceptance criteria

1. Connecting names the source being read.
2. Offline states the staleness with a real timestamp and keeps the composer writable.
3. A queued message flushed into a materially-changed session is **not** sent; it returns to the
   composer with the reason. Unit-tested per "material change" condition.
4. The outbox does not survive a page reload.
5. The session panel renders capabilities as sentences; no provider string appears; unknowns stay
   unknown.
6. The browser is never given a raw provider command — existing test holds.
7. At 390 × 844: three bands, 46px option targets, approvals as a bottom sheet, no horizontal
   page scroll anywhere including diffs (spec 09 R7).
8. Wants-you rows on phone carry an exact question only when one exists.
9. First run asks for a folder and offers nearby repos; the host step is skippable; a host
   missing a harness is reported without failing.
10. The hook bridge is offered, never installed silently, and declining leaves settings untouched.

## Open questions

- **Q1.** "Lost the daemon 40s ago… a snapshot from 10:31" needs a server timestamp on the
  snapshot. `StateSnapshot` carries `seq`; confirm it also carries a wall-clock time, or add one.
- **Q2 (spec 05 Q2 / R10).** One board model, two presentations — confirm.
