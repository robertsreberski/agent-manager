# 06 — Composer, drafts, and invisible writer coordination

**Status:** Accepted · **Depends on:** 01, 05 · **Design frames:** 5a, 6b
**Read from:** `Cockpit Prototype.dc.html` because turns 5–6 are absent from the redesign export.

## Purpose

Replace modal launch with an empty draft thread and expose one honest execution profile alongside
provider/model/effort. Browser writer leases remain automatic concurrency plumbing.

## Composer

Match frame 5a: a raised 16px-radius field, multiline textarea, quiet text-with-glyph controls,
and one solid round send/stop button. The provider/model menu, effort meter, profile menu, attach,
dictation, and delivery hint share one compact row. Full access and its derived access chip are
orange; there is no confirmation dialog.

The public settings are:

- provider/harness: selectable only for a draft; immutable after creation;
- model and effort: capability-derived and populated from the provider where possible;
- `ExecutionProfile`: `ask-first | plan | execute | full-access`, applied through the one
  `set-profile` action; and
- reset to the configured defaults for a draft or the next supported idle transition.

There is no separate access field, `set-access`, two-value planning/execution mode, or provider
permission/sandbox enum in browser state. The orange chip is derived from `full-access`.

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

### Delivery

Preserve the actual asymmetric provider semantics: `Enter` sends when idle and queues while a
turn runs; `Cmd+Shift+Enter` steers only where advertised; `Cmd+.` interrupts only where
advertised. Unsupported delivery calls `preventDefault` before assistant-ui can clear the draft.
The server owns queue order and removal.

Queued user messages render in the thread as numbered dashed bubbles below a labelled
`Queued · sends when this turn ends` rule. Each has a server action to remove that exact queued
item; the composer shows only the count.

Attachment and microphone affordances must not imply functionality. Until a real bounded adapter
exists, render them unavailable with a short reason or omit them according to the frame state.

## Draft sessions

- Header **New thread** creates a client draft and asks for one host/workspace path using the
  existing bounded resolver. **New thread here** inherits host, repository, and worktree.
- A draft has no server/provider ID. It opens the normal drawer with an empty timeline and
  focused composer; provider/model/effort/profile are local create parameters.
- First send performs one persisted-idempotent `POST /sessions` containing create parameters and
  the initial prompt, then replaces the draft with the returned session.
- Duplicate clicks/reconnects resolve to the same create attempt. `CREATE_OUTCOME_UNKNOWN`
  remains visible and is never retried silently; the operator explicitly starts a new attempt or
  checks the provider.
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
2. One profile action replaces mode/access, full access applies immediately in orange, and raw
   provider policy strings do not render.
3. Claude settings use the real SDK methods; Codex settings are idle-only, provider-confirmed,
   and fall back from the pinned experimental update to next-turn overrides.
4. Draft first-send creation is idempotent and unknown outcomes are never silently retried.
5. Queue/steer/interrupt preserve drafts on unsupported paths; queued items can be removed by
   stable server identity.
6. Two writers produce a conflict/takeover flow without any routine lease UI or lost/replayed
   action.
7. External hook/observe sessions show a truthful read-only composer and only exact native
   attachment where available.
8. Static/rendered-string checks find no old mode/access actions, launch dialog, lease affordance,
   or full-access confirmation.
