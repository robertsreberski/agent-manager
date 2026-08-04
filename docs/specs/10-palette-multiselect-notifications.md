# 10 — Command palette, multi-select, notifications

**Status:** Draft · **Depends on:** 05, 06 · **Design frames:** `11a` (palette), `12a`
(multi-select), `12b` (notifications), `13b` (shortcut sheet)

## Purpose

Three surfaces with no upstream equivalent: a way to reach any session or command without the
board, a way to act on several sessions at once, and a way to be told when an agent has stopped
and is waiting. `github.md` records all three as *"proposals, not recreations"* — the design is
less constrained by existing behaviour here, and the backend work is proportionally larger.

## Requirements — command palette (`11a`)

### R1 — Shape

600px, 1px border, raised fill, centred 110px from the top over a dimmed backdrop. A search row
(15px input, `esc` hint) over grouped results at 9px/13px per row; group headings in 10px mono,
uppercase, `letter-spacing: 0.12em`.

**The first row is the only filled one.** `⌘K` toggles; `Esc` closes.

### R2 — Three kinds of result, ranked before typing

Sessions (carrying the board's state dot), commands, and text inside transcripts — **ranked so
what wants you sits at the top before any typing**. An empty palette is a triage list, not a
blank box.

Prefixes narrow: `>` commands, `@` files, `/` harness slash commands, `#` transcripts,
`~` hosts and worktrees.

`/` harness slash commands are the harness's own — Codex exposes `skills/list` and `plugin/list`
(appendix §1.4), Claude has its command set. Where the list cannot be read, the prefix returns
nothing rather than a guessed list.

### R3 — Transcript search needs a bounded endpoint

`#` searches text inside transcripts. No search endpoint exists.

The global collection SSE is **deliberately metadata-only** — `metadataOnly()`
(`src/server/state.ts:21-39`) strips provider summaries because *"summaries can contain the exact
question or command input"*. A search endpoint that returns matching transcript text would be a
hole in exactly that boundary.

`GET /api/v1/search?q=` must therefore:

- Search only sessions the authenticated principal can already open — the same set
  `GET /api/v1/sessions` returns.
- Reuse `TRANSCRIPT_LIMITS` (`src/server/transcript.ts:32-37`) and the existing path hardening
  (uid-owned root, `O_RDONLY|O_NOFOLLOW`, dev/ino re-verification). Do not write a second
  transcript reader.
- Be rate-limited like the other read routes (`60/min`).
- Return **a match location and a short surrounding snippet for the selected session only**; for
  other sessions return the session id, file offset and match count — enough to navigate to it,
  not enough to read someone's conversation out of a list.
- Never enter the global SSE or any replay ring.

If that boundary feels too tight to be useful, the honest resolution is to narrow the feature
(search the open session only) rather than widen the boundary.

### R4 — Shortcut sheet (`13b`)

`?` toggles a 700px sheet, two columns:

| Group | Keys |
| --- | --- |
| Move | `⌘K` anything · `J`/`K` next, previous session · `1`–`9` jump to a board column · `⌘⇧D` review this turn's changes |
| Answer | `1`–`9` pick an option · `↵` send · `⌘↵` allow an approval · `E` write a different answer |
| Write | `⌘L` focus the composer · `↵` queue · `⌘⇧↵` steer now · `⌘.` stop the turn |
| Set | `M` mode · `⌘⇧M` harness and model · `⌘⇧.` lock everything · `?` this sheet |

> **Conflict to resolve.** The prototype's shortcut sheet lists `⌘↵` to *allow an approval*, but
> `8a` states that outside-workspace and remote-host approvals have **no keyboard shortcut** —
> *"this one needs a click"* (spec 07 R6). The sheet must scope the shortcut: `⌘↵` allows a
> **tier-1 (inside-workspace)** approval only, and the sheet says so. Do not let a global
> shortcut re-open the hole tier 2 deliberately closes.

All shortcuts are suppressed while typing in an input or textarea, except the modal-toggling ones.

## Requirements — multi-select (`12a`)

### R5 — Selection is opt-in and quiet

**Checkboxes appear on cards only once a selection exists.** The resting board stays quiet.
Start one by shift- or cmd-clicking a card, which selects rather than opening.

### R6 — The bar names the selection in the terms the action cares about

`3 selected · 2 idle · 1 failed · across 2 repos`, then Archive / End / Delete.

That breakdown is the safety mechanism: the operator sees what they are about to act on in the
categories that determine whether it is safe.

- **Delete confirms; archive and end do not.**
- **A running session refuses deletion outright rather than offering it and failing.** Exclude it
  from the delete affordance and say why in the breakdown — do not enable a button that will
  return an error.

### R7 — Three new lifecycle actions

Extend `sessionActionSchema` (`src/server/contracts.ts:50-72`) with `end`, `archive`, `delete`
and capabilities to match (spec 01 R2 pattern).

| Action | Codex | Claude | Discovered / observe-only |
| --- | --- | --- | --- |
| `archive` | `thread/archive` (native) | no equivalent — **capability absent** | absent |
| `delete` | `thread/delete` (native) | no equivalent — **capability absent** | absent |
| `end` | `turn/interrupt` then close the thread | end the SDK query | absent |

Codex has these natively (appendix §1.4); Claude does not. So a mixed selection may support an
action for some sessions and not others. **The bar must apply an action only where the capability
exists and report exactly what happened** — "Archived 2 · 1 not supported" — rather than
partially succeeding in silence.

Each action is per-session, idempotent, and audited like every other mutation.

## Requirements — notifications (`12b`)

### R8 — The rule is blocked or not blocked

- **A question or approval always notifies.** The agent has stopped and only the operator can
  restart it.
- **Finishing waits until the operator has been away 5 minutes.**
- **Progress never notifies.**
- Short answers ride along as actions in the notification.
- Quiet hours mute the sound, not the board.

### R9 — Local notifications only, and say so

Agent Manager is a loopback-bound local daemon. It has **no push service, no VAPID keypair and no
public endpoint**, so Web Push is not available and half-building it would be worse than not
having it.

Use the Notification API from the page and the existing service worker (`web/src/pwa/sw.ts`),
which delivers while a tab is open or the PWA is installed and running. That is a real limit and
the settings surface must state it plainly — an operator who thinks they will be paged on a
locked phone and is not has been misled by the UI.

The app badge already exists (`App.tsx`); extend it with the wants-you count.

### R10 — Preferences

Per event class (blocked / finished / stalled) and per delivery target. Stored client-side.
Requesting notification permission happens on the operator's action, never on load.

## Removals (spec 13)

Nothing directly. §A2 — re-run the dependency import scan after this phase; the palette and
menus should by now have claimed `dropdown-menu`, and anything still unimported is deleted.

## Acceptance criteria

1. `⌘K` on an untouched board lists wants-you sessions first, before any typing.
2. Each prefix narrows to its kind; a prefix whose source is unavailable returns empty, not a
   guessed list.
3. Transcript search returns snippets only for the selected session; other sessions return
   location and count. Verified by test against the metadata-only boundary.
4. Search reuses `TRANSCRIPT_LIMITS` and the existing hardened reader — no second implementation,
   no unhardened path.
5. `?` shows the sheet; `⌘↵` is documented and implemented as tier-1 approvals only, and does
   nothing on a tier-2 or tier-3 approval.
6. Checkboxes are absent until a selection exists.
7. A selection containing a running session offers no delete for it and says why.
8. A mixed-provider selection reports per-action outcomes rather than failing silently or
   partially.
9. A question raises a notification; a turn finishing while the operator is present does not.
10. The notification settings state the local-only limitation.

## Open questions

- **Q1.** "Away 5 minutes" — measured how? Page visibility plus last input is the obvious
  client-side answer; note that Claude Code solves the same problem with
  `CLAUDE_CLIENT_PRESENCE_FILE`, which may be worth mirroring for the desktop case.
- **Q2 (blocking R7).** Does ending a Claude session mean closing the SDK query, or terminating
  the process? For an adopted or hook-bridged session the manager does not own the process at
  all — `end` should be **absent** there, not best-effort. Confirm before implementing.
