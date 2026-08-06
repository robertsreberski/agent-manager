# 00 — Cockpit rebuild contract

**Status:** Accepted · **Compatibility:** none · **Audience:** one trusted macOS user

## Goal

Agent Manager is a local cockpit for seeing and controlling Codex and Claude sessions. The web
application is rebuilt against `docs/design/cockpit/`, using assistant-ui's component grammar,
and reports the harness as it is rather than presenting controls that merely look plausible.

The organising model is repository → worktree → session. Selecting a card opens an overlay
thread drawer. Starting work creates a draft thread; its first send atomically creates the
provider session. Browser writer leases remain internal concurrency plumbing and never appear as
a routine ownership control.

## Locked decisions

- This is a pre-prototype personal tool. Replace contracts in place, cold-reset Agent
  Manager-owned state, and delete old code in the same slice. Do not add migrations, aliases,
  deprecated fields, feature flags, backup flows, or parallel compatibility paths.
- There are two public execution settings, and they are different questions. The execution profile
  `ask-first | plan | execute | full-access` is the intent axis: whether the harness asks before
  it acts. The Codex-only sandbox `read-only | workspace-write | danger-full-access`, plus a
  network toggle that only workspace-write can carry, is the containment axis: what acting can
  reach. Each maps atomically at the adapter boundary, they compose freely, and raw provider
  permission/sandbox strings still never render or become vocabulary.
- Full access is an immediate orange menu action. There is no confirmation dialog and no
  browser arming period.
- There is no global control-stop switch. No persistent sentinel, CLI/owner-socket command,
  middleware state, UI, documentation surface, or test for one remains.
- Claude external decisions use the Claude HTTP `PermissionRequest` hook only. Codex hooks are
  a separate command-hook integration and require Codex trust. Provider schemas are never
  conflated.
- Shared-daemon Codex control ships only after the isolated two-client gate in spec 02 passes.
  Agent Manager never starts, restarts, or stops the user's daemon.
- There is one selected-session activity timeline. Retention is bounded and stated honestly;
  there is no fake REST backscroll over an already-truncated buffer.
- Build and deployment are personal-tool commands: `pnpm dev`, `pnpm check`, and `pnpm deploy`.
  There is no publishing, tagging, changelog, release branch, or rollback ceremony.

## Honesty rules

1. Render only provider facts or explicitly labelled derivations. Inferred attention stays in
   Wants You with a dashed lime edge, muted body, and “looks blocked — from transcript”; it is
   never respondable and never triggers a notification.
2. Authorise from the live capability set. A missing action remains unavailable and the UI
   states why; a capability ceiling is not a promise.
3. Never fake steering through Claude `Stop`, Codex `thread/inject_items`, terminal keystrokes,
   or a hook return value attributed to the wrong actor.
4. Preserve provenance per activity item: provider API/exact/provider-exposed versus
   transcript/inferred or heuristic/transcript-derived.
5. Fail closed on controller ambiguity and wire-version mismatch. Fail open to a waiting
   provider hook by releasing it with an empty successful response.
6. Global state and SSE remain metadata-only. Exact prompts, answers, commands, paths, and
   transcript snippets use authenticated selected-session routes with `Cache-Control: no-store`.

## Specifications and implementation order

| Wave | Specifications | Result |
| --- | --- | --- |
| 0 | 00–03, appendix | Correct protocol facts; run the isolated Codex gate before freezing contracts |
| 1 | 01, 04, 13 | One strict shared wire schema, cold reset, discovery/workspace model, structural deletions |
| 2 | 02, 03 | Codex controller path, Claude hook bridge, controller arbitration |
| 3 | 12, 05, 06, 07 | Design system, board/drawer/thread, drafts/composer, questions/approvals |
| 4 | 08–11 | Plans/todos, diffs, palette/lifecycle/notifications, system states/mobile/first run |
| 5 | 13 | Dependency and package pruning, exact clean build, simple local deployment, final verification |

`use-cockpit` is decomposed and the shared contract is frozen before parallel UI work. One
integrator owns server hot files and one owns web hot files; package/lock changes have one owner.
Workers do not edit those integration surfaces concurrently.

## Required public model

- One shared server/browser schema and one wire epoch. Old clients and remote nodes fail closed
  and request a reload/update; they are not normalized into the new shape.
- Distributed session identity is always `SessionRecord.id` =
  `` `${hostId}:${provider}:${providerThreadId}` ``. `providerThreadId` preserves
  the exact provider thread identity; `providerTreeId` groups a provider thread tree. For Codex,
  `providerThreadId` is `Thread.id` and protocol `sessionId` becomes `providerTreeId`. This is the
  current app-stable encoding, not a compatibility alias.
- One activity/status truth, one attention truth, and one controller/authority truth. Delete
  duplicate `status`/`activity`, `lifecycle`/`runtimeAlive`, `waitingReason`/`attention`, and
  ownership aliases rather than reconciling them forever.
- Provider settings, lifecycle, activity, request responses, and editor operations are typed,
  capability-gated actions. Browser input never selects an executable or supplies shell text.

## Design authority

`Cockpit Redesign.dc.html` is normative for surviving frames. The complete prototype supplies
the board, drawer, composer, questions, and boundary-truncated approval frame. `support.js` is
canvas runtime only and is not product code. Frame `8b` is absent; spec 11 defines it using the
adjacent design grammar, and this exception is recorded in `docs/design/cockpit/NOTES.md`.

## Completion gates

- Every accepted spec is implemented or a provider limitation is explicitly unavailable; no
  fake control or silent fallback remains.
- Existing exact-interaction invariants survive: request exactness, unsupported-send draft
  preservation, `isRunning: false`, cursor equality, UTF-8 append validation, and idempotent
  creation.
- Disposable real Claude hook and isolated two-client Codex tests do not alter global hook
  configuration, the running shared daemon, or existing sessions.
- Visual/keyboard/accessibility checks cover 320px, 390×844, 900/901px, and 1440×900.
- `pnpm check`, package-content checks, `pnpm deploy`, local health, and browser smoke pass.
- Repository searches find no global stop/sentinel code, old mode/access contract, migration aliases,
  duplicate timeline, obsolete launcher/sidebar, release ceremony, or tracked dogfood artifacts.
