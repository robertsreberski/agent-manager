# 13 — Removals

**Status:** Draft · **Applies to:** every phase · **Design frames:** none

## Purpose

This is the first revision of the project. Nothing here has external consumers, no version is
supported, and no compatibility is owed to anyone. That makes this the cheapest moment the
codebase will ever have to delete things — and the redesign touches enough of it that leaving
the superseded parts in place would double the surface every later spec has to reason about.

**Rule for every phase: when a spec replaces something, the replaced thing is deleted in the
same commit.** Not deprecated, not left behind a flag, not kept "just in case". A parallel old
path is a bug that has not happened yet.

Removals are listed with the spec that owns them. A removal with no owning spec is done first,
in a standalone cleanup commit.

---

## Group A — Standalone cleanup (do first, owns nothing)

### A1 — `dogfood-output/` (16 MB of tracked binaries)

Committed `.webm` screen recordings and `.png` screenshots from manual dogfooding runs —
`2026-08-03-live-activity-final`, `2026-08-03-managed-e2e`, `2026-08-04-v0.3.1`,
`2026-08-04-list-spacing`. Single files up to 10k lines of binary.

These are the output of a process, not an input to one. They document a UI that this redesign
deletes.

- `git rm -r dogfood-output`, add `dogfood-output/` to `.gitignore`.
- History rewrite is **not** proposed — the cost outweighs 16 MB on a first-revision repo. If
  the operator wants the artifacts, they move to a release asset or a scratch directory outside
  the repo before removal.

### A2 — Unused Radix dependencies

Declared: `alert-dialog`, `dialog`, `dropdown-menu`, `radio-group`, `scroll-area`, `select`,
`slot`, `tabs`, `tooltip`. Imported anywhere in `web/src`: **`dialog` and `tooltip` only.**

The redesign genuinely needs several of the unused ones — `dropdown-menu` (composer harness/mode
menus, `5a`), `radio-group` (described question options, `6a`), `tabs` (plan revisions, `14b`),
`slot` (`asChild`). So this is not a blanket delete:

- **Keep and use**: `dropdown-menu`, `radio-group`, `tabs`, `slot`, `dialog`, `tooltip`.
- **Delete unless a spec claims them by the end of phase 10**: `alert-dialog`, `select`,
  `scroll-area`. The design uses native scrolling, plain `<select>`-free menus, and has exactly
  one confirm (delete, `12a`) that `dialog` already covers.

Re-run the import scan at the end of phase 11 and drop whatever is still unimported.

---

## Group B — Owned by spec 05 (board, drawer, thread)

### B1 — `web/src/components/session-sidebar.tsx` (693 lines)

Superseded wholesale. The scope rail becomes the filter row; host grouping becomes the host
filter; the session list becomes the board. Delete the file and its test, and delete the
`--scope-rail-collapsed` / `--scope-rail-expanded` / `--session-list-width` tokens from
`web/src/styles.css` with it.

### B2 — The duplicate timeline path

This is the most valuable removal in the list.

`session-thread.tsx:569-572` renders from **one of two sources**:

```ts
const hasLiveActivity = activity.hasSnapshot;
… hasLiveActivity ? buildActivityTimeline(activity.items) : session.messages
```

The second source drags a whole parallel world behind it: `ConversationMessage[]`
(`src/core/types.ts:129-136`, `web/src/types.ts:92`), `SessionTranscript` state machine,
`TranscriptEmptyState` + `transcriptReason` (`session-thread.tsx:243-296`), a second
follow-revision source (`:563-567`, `:613`), a second truncation banner, and the `messages[]` /
`transcript` payload on `GET /api/v1/sessions/:id` (`src/server/server.ts:604`) — the only
endpoint that returns transcript content at all.

**It is redundant.** `SelectedTranscriptActivityObserver`
(`src/server/activity-observer.ts`) already projects transcripts into the activity hub as
`message` items with `transcript` / `inferred` / `transcript-derived` provenance. Every session
that has a transcript can have an activity stream.

Delete:

- `ConversationMessage` from both type files, and `messages` from `SessionView`.
- `messages[]` from the `GET /api/v1/sessions/:id` response.
- `TranscriptEmptyState`, `transcriptReason`, and the dual follow-source logic.
- The `hasSnapshot ? … : …` branch. One timeline, one empty state, one follow model.

Keep `SessionTranscript`'s **state and reason** — `not-found`, `unreadable`, `unsupported` are
real facts about why a session has no history — but surface them as a `lifecycle` item projected
into the stream, not as a second rendering mode.

### B3 — `web/src/components/session-badges.tsx` (79 lines)

Six badge components (`ActivityBadge`, `ModeBadge`, `ProviderBadge`, `OwnershipBadge`,
`AttentionBadge`, `AccessBadge`). The redesign carries state in the card's *fill and tick*, not
in badges, and carries facts in the drawer header's chips and the session panel's sentences.
Delete; the two or three genuinely reusable pieces move into the board and drawer components
that use them.

### B4 — `ui/badge.tsx` colour variants

`warning | danger | success | info` variants hardcode `amber-500` / `red-500` / `emerald-500` /
`blue-500` (`web/src/components/ui/badge.tsx:13-16`), bypassing the token system. Spec 12
replaces them with tokens. Delete the literals, not necessarily the component.

---

## Group C — Owned by spec 06 (composer, draft sessions, leases)

### C1 — `web/src/components/launch-dialog.tsx` (281 lines) and its test

A new session is an empty thread whose composer carries every option. Delete the dialog, the
host picker, the SSH path-completion UI and the advanced-options block.

**Keep** the machinery underneath it: `lib/create-attempt.ts` (persisted idempotency key),
`POST /api/v1/workspaces/resolve`, and `GET /api/v1/hosts/:id/directories`. The draft-session
flow still needs all three; only the modal goes.

### C2 — Every lease affordance

Take control, Release control, expiry countdowns, full-host arming dialogs, and every control
disabled *solely* because no lease is held. The lease stays as a background mechanism —
`use-cockpit.ts` and `lib/api.ts` keep `acquireLease` / `releaseBrowserLeases` — but it stops
being a thing the operator holds.

Acceptance is a grep, not an opinion: **no rendered string contains "lease", and no `disabled`
expression reads a lease field.** The only surviving surface is the `LEASE_CONFLICT` toast.

### C3 — The two-mode enum

`mode: z.enum(["planning","execution"])` (`src/server/contracts.ts:50-72`) becomes the design's
four (Ask first / Plan / Execute / Full access). Delete the two-value enum and every
`"planning"` / `"execution"` string literal rather than mapping old to new — there is no stored
state to migrate.

---

## Group D — Owned by spec 08 (plan and todos)

### D1 — `ActivityPlanItem`'s dual duty

One item type currently serves both the plan-you-approve and the checklist-it-keeps
(`src/activity/types.ts:96-100`). Spec 08 splits it. Delete the merged type; do not keep it as
a union alias.

`PlanRow` (`web/src/components/session-activity.tsx:414`) is deleted with it.

---

## Group E — Owned by spec 01/02 (control planes)

### E1 — `agent-sessions.ts` at the repository root (2,125 lines + 670 of test)

Two problems, one file:

1. **The layering is inverted.** `src/core/discovery.ts:20` imports from `"../../agent-sessions.ts"`
   — `src/` reaching outside `src/` for its most security-sensitive logic (process-table parsing,
   `lsof`, read-only SQLite, transcript walking).
2. **It leads a double life** as a standalone dependency-free script *and* as the service's
   discovery engine, and `README.md` promises the first. That promise is owed to no one on a
   first revision, and it constrains the file to zero imports forever.

Move it into `src/discovery/scan/`, split by concern — `claude.ts`, `codex.ts`, `process-table.ts`,
`tmux.ts`, `types.ts` — and delete the root file, the `agent-manager list [agent-sessions options]`
passthrough (`src/cli/args.ts:131`), and the special case in the `test` script that names
`agent-sessions.test.ts` explicitly.

Split the test alongside; do not merge 670 lines of assertions into one file.

**Timing:** do this *after* spec 02, not before. Daemon adoption removes the Codex process-scan +
`lsof` + SQLite path from the common case (it becomes the no-daemon fallback), and the hook
bridge removes some of the Claude heuristics. Splitting first would mean splitting code that is
about to shrink.

### E2 — `source: "legacy"` attention synthesis

`web/src/lib/normalize.ts:162-168` synthesises attention records with `id: null`,
`source: "legacy"`, `confidence: "heuristic"` from boolean-only discovery records.

The records are real and must keep working — that is friction #7 in `00-overview.md`. But
`"legacy"` is not a provenance, it is an apology. Fold it into the existing
`EvidenceSource` vocabulary (`src/core/types.ts:23-31`) with an honest name, and make the board
render heuristic attention differently from exact attention (spec 05 R-open).

### E3 — Possibly: the private-socket Codex plane

If the spec 02 spike shows the daemon is reliable, `codex-app-server` (manager-spawned private
socket) and `codex-daemon` are two implementations of one thing, and `supervisor.ts` carries
both. Collapsing to daemon-only would delete the spawn path, the socket-refusal guard and its
tests.

**Deferred, not decided** — spec 01 Q1. Revisit after the spike. Do not collapse before it.

---

## Group F — Owned by spec 11 (system states) / structural

### F1 — `use-cockpit.ts` must not grow (790 lines)

One hook with ~20 `useState`s returning a 35-key object, consumed by `App`. The redesign adds
`scope`, `hostFilter`, `selected[]`, `openId`, draft sessions, per-file read flags, plan
revisions and notification preferences. Added naively it clears 1,000 lines and every board
re-render goes through it.

Not a deletion but a decomposition, and it belongs in this document because the failure mode is
the same: split into `use-auth`, `use-sessions` (snapshot + SSE + `SessionStateGuard`),
`use-board` (scope, host filter, selection, open id), `use-session-actions` (mutations, busy,
leases). `SessionStateGuard` (`lib/session-state.ts`) already lives outside React state and
should stay that way.

### F2 — `GET /api/v1/sessions/:id/activity` — wire it or delete it

Registered at `src/server/server.ts:640`, returns a bounded history page with a `nextBefore`
cursor, and **is not consumed by the web app at all**. The client only streams.

The drawer scrolls a long thread against a materialised window of at most 400 items / 1 MiB, so
this endpoint is exactly what backscroll needs. **Recommend wiring it** in spec 05 rather than
deleting. If spec 05 ships without backscroll, delete the endpoint and its tests — an untested,
unused, security-relevant route that returns transcript content is a liability.

---

## Acceptance criteria

1. `dogfood-output/` untracked and gitignored; `git ls-files` returns no `.webm` or `.png`
   outside `web/public/`.
2. No file in `src/` imports from outside `src/`.
3. `grep -ri "lease" web/src --include=*.tsx` returns no user-visible string.
4. `session-thread.tsx` has exactly one timeline source and one empty state.
5. `ConversationMessage` does not exist in either type file.
6. Every dependency in `package.json` is imported somewhere, verified by a check script run in
   `pnpm check`.
7. No file added or modified by this project exceeds ~600 lines without a stated reason.
   `src/server/server.ts` (2,287) and `src/providers/claude/activity-projector.ts` (1,830) are
   pre-existing and out of scope here — but nothing new joins them.
8. No `@deprecated`, no `-v2` suffix, no `Legacy` prefix, and no dead branch left behind a
   feature flag anywhere in the diff.
