# 06 — Composer, drafts, and invisible writer coordination

**Status:** Accepted · **Depends on:** 01, 05 · **Design frames:** 5a, 6b
**Read from:** `Cockpit Prototype.dc.html` because turns 5–6 are absent from the redesign export.

## Purpose

Replace modal launch with an empty draft thread and expose one honest execution profile alongside
provider/model/effort. Browser writer leases remain automatic concurrency plumbing.

## Composer

Match frame 5a: a raised 16px-radius field, multiline textarea, quiet text-with-glyph controls,
and one solid round send/stop button. The provider/model menu, effort meter, profile menu, attach,
and delivery hint share one compact row. Full access is orange on the profile control itself;
there is no confirmation dialog.

The public settings are:

- provider/harness: selectable only for a draft; immutable after creation;
- model and effort: capability-derived and populated from the provider where possible;
- `ExecutionProfile`: `ask-first | plan | execute | full-access`, applied through the one
  `set-profile` action;
- `SandboxPolicy`, Codex only: `read-only | workspace-write | danger-full-access` plus a network
  toggle that only `workspace-write` can carry, applied through the one `set-sandbox` action; and
- reset to the configured defaults for a draft or the next supported idle transition.

The profile and the sandbox are two axes of one decision and neither implies the other: the
profile decides whether the harness asks before it acts, the sandbox decides what acting can
reach. They compose freely — never-ask with a read-only sandbox is a coherent request — so
`full-access` no longer forces a permissive sandbox, and a permissive sandbox is not read back as
`full-access`. Claude has no sandbox: it renders no control at all, because an unavailable setting
and a nonexistent one are different facts. There is still no separate access field, `set-access`,
or two-value planning/execution mode, and raw provider policy strings never render.

`full-access` is stated **once**, orange, on the profile control that changes it — its trigger
label and its menu item — and `danger-full-access` likewise once on the sandbox control. There is
no derived access chip beside either control and no profile chip in the drawer header: the same
fact rendered three times reads as decoration, which is the one thing an alarm colour cannot
afford. The Session facts panel still states the profile and sandbox neutrally, because that panel
is a full inventory rather than an alert.

### Live settings

- Draft catalog discovery is a read-only provider-runtime operation and must work before any
  manager-owned thread exists. It must not borrow an unrelated session as a catalog proxy.
  Host routing remains explicit: a local Codex draft reads the private App Server's live
  `model/list`; a remote draft reports unavailable until that remote provider exposes the same
  bounded read edge.
- Claude SDK `0.3.220` exposes `setModel`, `applyFlagSettings({ effortLevel })`,
  `supportedModels`, and `setPermissionMode`. Advertise only what the pinned Query currently
  supports and withdraw on provider/transport failure.
- Codex profile, model, and effort are selectable only while idle. The pinned 0.146 experimental
  API uses `thread/settings/update`, and the provider's `thread/settings/updated` notification
  confirms effective state. A `-32601` response withdraws the live method and carries the
  selection as an override on the next `turn/start` instead.
- Every setting action is generation-checked/idempotency-keyed and capability-gated. Unsupported
  controls stay visible only when the design needs the fact, disabled with a plain reason.
- Reading a catalog is not writing to it. The model catalog loads for any selected session and is
  never gated on `set-model`; where the harness will not take the write, the list renders disabled
  with the harness's own reason. A control that is greyed out with nothing to show and nothing to
  say is indistinguishable from a broken one.
- A catalog read survives unrelated session churn. A fresh managed session streams its first turn
  from creation, so any generation comparison rejects exactly the sessions worth reading; only
  identity or ownership changes — thread replaced, removed, adopted away — withdraw the result.
  A read that failed transiently is retried once when the session settles from running, never in
  a loop, and structural refusals are not retried at all.
- The session states its model as a wire id while catalogs list alias rows, so the checked row
  and its efforts come from the covering row: an exact `value` match, else the row whose
  `resolvedModel` names the same wire id, else — for a null model — the row the catalog itself
  marks default. An unmatched model checks no row rather than presenting the first as chosen.
- Where `set-effort` is granted and the loaded covering row declares no effort metadata, the
  radios offer the provider's own effort vocabulary — the grant is the harness's claim that a
  write from that vocabulary will be accepted. A withheld `set-effort` fabricates nothing.

### Delivery

Preserve the actual asymmetric provider semantics: `Enter` sends when idle and queues while a
turn runs; `Cmd+Shift+Enter` steers only where advertised; `Cmd+.` interrupts only where
advertised. Unsupported delivery calls `preventDefault` before assistant-ui can clear the draft.
The server owns queue order and removal.

Queued user messages render in the thread as numbered dashed bubbles below a labelled
`Queued · sends when this turn ends` rule. Each has a server action to remove that exact queued
item; the composer shows only the count.

Attachment and microphone affordances must not imply functionality. Attachments are wanted work,
so the control stays visible and disabled, naming the issue that tracks it. Dictation is not, so
it is omitted rather than rendered dead: a control that can never become live is noise, not an
honest statement of a withheld capability.

## Draft sessions

- Header **New thread** creates a client draft and asks progressively, on one screen with the
  composer always below it: a recently opened project or a typed path completed from bounded,
  server-confirmed directory suggestions; then, once that path resolves to a repository, where in
  it to run — an existing worktree, a new one, or none. **New thread here** inherits host,
  repository, and worktree.
- A folder that is not a repository has nothing to ask, so no worktree control appears at all. A
  host that cannot manage worktrees says so plainly instead of offering one that cannot work.
- A new worktree is always based on the repository's default branch and named once, for both the
  directory and its branch (see `04-workspace-model.md`). There is no branch step: choosing no
  worktree runs in the folder exactly as given.
- A draft has no server/provider ID. It opens the normal drawer with an empty timeline and
  focused composer; provider/model/effort/profile/sandbox are local create parameters.
- First send creates the worktree, when one was requested, through its own explicit call before
  performing one persisted-idempotent `POST /sessions` containing create parameters and the
  initial prompt, then replaces the draft with the returned session.
- Duplicate clicks/reconnects resolve to the same create attempt. `CREATE_OUTCOME_UNKNOWN`
  remains visible and is never retried silently; the operator explicitly starts a new attempt or
  checks the provider. A worktree that outlives a failed session create is durable: the draft
  re-targets it, so a retry reuses it and never asks git for a second one under the same name.
- No launch dialog, advanced-options block, or shadow session row survives.

## Writer coordination

Retain short principal/client-bound leases because two tabs issuing semantic writes is unsafe,
but remove the product concept:

- acquire on actual write intent, renew while required, and release on drawer/tab close;
- never disable an otherwise capable control merely because no lease is currently held;
- render no “lease”, take/release control, countdown, host arming, or access switch;
- on a real conflict, state that another window is controlling the session and offer explicit
  takeover for subsequent writes; never replay the losing action automatically.

Read-only sessions state the provider limitation and offer native attach when exact/capable. They
must not resemble a connection or writer-coordination failure.

## Acceptance criteria

1. Only the round action button is solid at rest; controls match frame 5a and are keyboard/focus
   accessible.
2. One profile action and one Codex sandbox action replace mode/access; full access and the danger
   sandbox each apply immediately in orange on their own control, and raw provider policy strings
   do not render.
3. Claude settings use the real SDK methods and expose no sandbox control; Codex settings are
   idle-only, provider-confirmed on each axis independently, and fall back from the pinned
   experimental update to next-turn overrides carrying both axes at once.
4. Draft first-send creation is idempotent and unknown outcomes are never silently retried; a
   worktree created before a failed session create is reused rather than recreated.
5. Queue/steer/interrupt preserve drafts on unsupported paths; queued items can be removed by
   stable server identity.
6. Two writers produce a conflict/takeover flow without any routine lease UI or lost/replayed
   action.
7. External hook/observe sessions show a truthful read-only composer and only exact native
   attachment where available.
8. Static/rendered-string checks find no old mode/access actions, launch dialog, lease affordance,
   or full-access confirmation.
