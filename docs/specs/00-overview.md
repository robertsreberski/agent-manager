# 00 — Overview: cockpit redesign and control-plane re-evaluation

**Status:** Draft · **Supersedes:** nothing · **Changes public claims in:** `README.md`, `SECURITY.md`

## Why this exists

Agent Manager splits sessions in two: *manager-owned*, with full semantic control, and
*external*, observe-only and transcript-derived. That split was not timidity — it was an
accurate reading of the harnesses. Both providers' control channels were connection-scoped:
Codex approvals arrive as JSON-RPC server→client requests on the socket the client opened, and
Claude's `canUseTool` / `onElicitation` are callbacks passed into `query()`. A session started
in someone else's terminal had already bound those channels to that terminal, and the
filesystem transcript is a write-only side effect with no path back to the owning process.

**That reading is now out of date.** See `appendix-harness-capabilities.md` for the evidence.
In short:

- **Codex runs a shared app-server daemon** with a `thread/list` index, per-client
  subscriptions (`thread/unsubscribe`), and a `serverRequest/resolved` broadcast for
  arbitrating who answered what. `ThreadSourceKind` distinguishes `cli` threads — sessions
  started in a terminal — from `appServer` ones.
- **Both harnesses have hooks that can block and decide**, over HTTP, synchronously, with
  600s timeouts. Claude reloads hook config **live via file watcher, with no session restart**,
  so an install takes effect on sessions that are already running.
- **Claude still has no local control channel** for an arbitrary interactive session. Remote
  Control is cloud-routed. External Claude sessions can be observed exactly and can have their
  decisions answered — but they cannot be queued or steered.

The web layer was drawn against the old concept, and the Claude Design handoff
(`docs/design/cockpit/`) replaces its three organising ideas: a host-grouped list becomes a
repo → worktree **board**; a modal launcher becomes a **draft thread** whose composer owns
harness/model/effort/mode/access for the session's life; and the operator-held **lease
disappears** from view.

Both halves serve one commitment, which is the project's reason to exist: **the most faithful
depiction of what is actually happening with the harness.**

## Honesty rules

These bind every spec. They are the difference between this project and a dashboard.

1. **Never render a fact the harness did not supply.** Derive what is derivable (is this path
   inside the workspace?), omit the rest. Do not invent "deletes 412 files" because the design
   frame shows a number there.
2. **Never advertise a capability that will fail.** Capabilities are derived from the live
   control plane, not asserted. A control that cannot work renders disabled *with its reason*,
   per the design's own rule that capabilities read as plain sentences with a tick, question
   mark or cross.
3. **Never disguise a side channel as the real thing.** Claude's `Stop` hook can block with a
   `reason` that the model then acts on. That is a system instruction, not a user turn.
   Using it to fake steering would put words in the transcript the operator never said.
   Codex's `thread/inject_items` is the same trap. Neither is a steering channel.
4. **Provenance survives the redesign.** `source` / `confidence` / `exposure`
   (`src/activity/types.ts:23-25`) must remain visible wherever they are not `provider-api` /
   `exact` / `provider-exposed`. A prettier surface must not launder an inference into a fact.
5. **Fail closed on ownership, fail open to the harness.** Ambiguity about who controls a
   session disables cockpit writes. A hook that times out waiting for a browser must return
   control to the harness's own prompt — never leave a terminal wedged.
6. **What a spec replaces, the same commit deletes.** This is the first revision; nothing is
   owed compatibility. No deprecation, no flag, no parallel old path. See
   [`13-removals.md`](13-removals.md) — it is not a cleanup backlog, it is a constraint on
   every phase.

## The spec set

Every implementation phase implements exactly one spec, and no phase starts before its spec is
reviewed. Read in this order.

| Spec | Covers | Design frames |
| --- | --- | --- |
| [`01-control-planes.md`](01-control-planes.md) | The plane spectrum, capability derivation, two-controller safety | — |
| [`02-codex-daemon-adoption.md`](02-codex-daemon-adoption.md) | Joining the shared daemon, thread adoption, approval arbitration | — |
| [`03-hook-bridge.md`](03-hook-bridge.md) | Hook installation, event ingestion, blocking decisions | — |
| [`04-workspace-model.md`](04-workspace-model.md) | Repo → worktree discovery, branch, dirty counts | `7a` |
| [`05-board-and-drawer.md`](05-board-and-drawer.md) | Board columns, cards, scopes, host filter, overlay drawer, thread | `7a` `4a` `4b` |
| [`06-composer.md`](06-composer.md) | Harness/model/effort/mode/access, draft sessions, queue vs steer, lease removal | `5a` `6b` |
| [`07-questions-and-approvals.md`](07-questions-and-approvals.md) | `request_user_input`, multi-question, three approval tiers, panic lock | `6a` `8a` `9a-3` `9a-4` |
| [`08-plan-and-todos.md`](08-plan-and-todos.md) | Plan document vs todo checklist — two different objects | `14a` `14b` `15a` `15b` |
| [`09-diffs.md`](09-diffs.md) | Inline diff, review drawer, phone unified | `10a` `10b` `13a` |
| [`10-palette-multiselect-notifications.md`](10-palette-multiselect-notifications.md) | ⌘K, selection bar, notification policy | `11a` `12a` `12b` |
| [`11-system-states-and-first-run.md`](11-system-states-and-first-run.md) | Connecting, offline, ended, empty, onboarding, phone | `8b` `13b` `13c` `9a-1` |
| [`12-design-system.md`](12-design-system.md) | Tokens, type, fonts, icons, motion | tokens |
| [`13-removals.md`](13-removals.md) | What each phase deletes, and why now is the moment | — |
| [`appendix-harness-capabilities.md`](appendix-harness-capabilities.md) | The survey specs 01–03 rest on | — |

## Delivery order

Follows the handoff's own suggested order, with the control-plane work slotted where it
unblocks UI that would otherwise have nothing to show.

| # | Phase | Specs | Gate |
| --- | --- | --- | --- |
| 0 | Standalone cleanup — untrack `dogfood-output/`, dependency audit | 13 §A | — |
| 1 | Design system | 12 | — |
| 2 | Workspace model | 04 | — |
| 3 | Board + drawer + thread | 05 | 12, 04 |
| 4 | Composer, draft sessions, lease removal | 06 | 05 |
| 5 | Questions and approvals | 07 | 05 |
| 6 | Codex daemon adoption | 01, 02 | **daemon spike** (spec 02 §Prerequisite) |
| 7 | Hook bridge | 01, 03 | 06 |
| 8 | Plan and todos | 08 | 05 |
| 9 | Diffs | 09 | 05 |
| 10 | Palette, multi-select, notifications | 10 | 05, 06 |
| 11 | System states, phone, first run | 11 | all |

Phases 6 and 7 change what `README.md` and `SECURITY.md` promise. `SECURITY.md:37-41` currently
states that Agent Manager "does not adopt external sessions into its semantic control plane."
**Rewrite that claim in the same commit as the behaviour change, never after.**

## Frictions between the design and the harnesses

Resolving these *is* the work. Each is owned by a spec.

| # | Friction | Owner | Resolution |
| --- | --- | --- | --- |
| 1 | Board groups by repo → worktree; no worktree concept exists | 04 | Add discovery |
| 2 | Design removes all lease UI; the lease is real single-writer safety | 06 | Keep mechanism, surface only conflicts |
| 3 | Composer owns model/effort/access; no mid-session change exists | 06 | New actions; disable with a stated reason where unsupported |
| 4 | Plan is a versioned markdown file; Codex emits structured steps | 08 | Two item kinds; Codex renders as todos, no fake path |
| 5 | Approval facts ("deletes 412 files") are in no provider payload | 07 | Show only derivable facts |
| 6 | Diff "expand context" implies re-reading the file | 09 | Expand only within the patch |
| 7 | External attention is heuristic with `id: null`, but the board has no visual for it | 05 | **Open — needs a design decision** |
| 8 | Palette searches transcript text; the global feed is metadata-only by design | 10 | Scoped search, offsets not content |
| 9 | Offline outbox vs `expectedGeneration` | 11 | Re-validate at flush, confirm on material change |
| 10 | Design loads Google Fonts; CSP is `default-src 'self'` | 12 | Self-host woff2 |

## Invariants the rebuild must not break

Each has a test today. Keep the tests, whatever happens to the component around them.

| Invariant | Where |
| --- | --- |
| Inline answer controls only for `!resolved && waiting && provider-api && exact && provider-exposed && !truncated` | `web/src/components/session-thread.tsx:126-145` |
| Attention metadata never synthesises answer controls | `web/src/components/session-thread.tsx:147-190` |
| Activity frame cursor equality check | `web/src/lib/session-activity.ts:148` |
| UTF-8 byte-offset append verification | `web/src/lib/session-activity.ts:224` |
| `isRunning: false` on the external store — assistant-ui must not invent a running message | `web/src/components/session-thread.tsx:601-604` |
| Composer `preventDefault` for unsupported delivery, or the draft is lost | `web/src/components/session-thread.tsx:353-361` |
| Global SSE carries metadata only; exact request content is selected-session only | `src/server/state.ts:21-39` |
| Attach instructions to the browser are owner-socket wrappers, never raw provider commands | `src/server/server.ts:802-811` |
