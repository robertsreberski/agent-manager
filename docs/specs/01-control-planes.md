# 01 — Control planes

**Status:** Draft · **Depends on:** `appendix-harness-capabilities.md` · **Blocks:** 02, 03, 06

## Purpose

Replace the binary *manager-owned vs external* with a spectrum of control planes, each
advertising the capabilities it can actually honour. This is the type-level change that lets
specs 02 and 03 exist without weakening any guarantee the project currently makes.

## Background

`ControlPlane` (`src/core/types.ts:105-127`) already anticipates a spectrum — it has five
members and a `capabilities: ControlCapability[]` list beside it. The gate chain in
`POST /api/v1/sessions/:id/actions` (`src/server/server.ts:1414-1445`) already tests
`session.control.capabilities.includes(capability)` rather than testing ownership. So the
architecture takes new planes without structural change; what it needs is two new members and
truthful derivation for each.

The one place ownership is tested directly is lease acquisition
(`src/server/server.ts:1215-1219`), which rejects with `409 CONTROL_UNAVAILABLE` when a session
has none of `queue|steer|interrupt|respond|set-mode`. That test stays correct: it is
capability-based, not ownership-based.

## Requirements

### R1 — Extend `ControlPlane`

```ts
export type ControlPlane =
  | "codex-app-server"   // manager-spawned private socket — unchanged
  | "codex-daemon"       // NEW — shared app-server daemon, thread adopted (spec 02)
  | "claude-sdk"         // manager-owned SDK query — unchanged
  | "claude-hook-bridge" // NEW — external session with hooks installed (spec 03)
  | "tmux-attach"
  | "resume-only"
  | "observe-only";
```

`observeOnlyControl()` (`src/core/types.ts:301-308`) remains the default for anything
discovered. A session is only promoted out of it by positive evidence.

### R2 — Extend `ControlCapability`

Add `set-model`, `set-effort`, `set-access` (required by spec 06). Keep the existing eight.

```ts
export type ControlCapability =
  | "queue" | "steer" | "interrupt" | "respond" | "set-mode"
  | "set-model" | "set-effort" | "set-access"   // NEW
  | "preview" | "attach" | "resume";
```

`requiredCapability()` (`src/server/contracts.ts:233-244`) gains the three new mappings. It is
an exhaustive switch over `SessionAction`, so the compiler will find every call site.

### R3 — Capability matrix

This is the contract. A plane may advertise **less** than its row at runtime (degraded
creation, withdrawn method, version drift) but never more.

| Plane | queue | steer | interrupt | respond | set-mode | set-model | set-effort | set-access | preview | attach | resume |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `codex-app-server` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| `codex-daemon` | ✓ | ✓ | ✓ | **spike** | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| `claude-sdk` | ✓ | ✓¹ | ✓ | ✓ | ✓ | spike | spike | ✓ | — | ✓ | ✓ |
| `claude-hook-bridge` | ✗ | ✗ | ✗ | ✓² | ✗ | ✗ | ✗ | ✗ | ✓³ | ✓³ | ✗ |
| `tmux-attach` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ |
| `resume-only` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `observe-only` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

¹ `canSteer` requires exact version pins on both the SDK and the CLI
(`src/providers/claude/managed-session.ts:593-595`).
² Permission and elicitation decisions only — the hook is holding the harness. Not arbitrary responses.
³ Only when an unambiguous tmux target also resolves; `preview`/`attach` are orthogonal to the bridge.

### R4 — `claude-hook-bridge` must not advertise `queue` or `steer`

There is no local channel to send a user message to an external Claude session
(appendix §2.1). The composer for such a session renders read-only with the reason stated, and
offers attach as the escape hatch — the same shape `tmux-attach` sessions already have.

**Prohibited implementations**, both of which would technically "work" and both of which lie:

- Blocking a `Stop` hook and returning the operator's text as `reason` or `additionalContext`.
  That injects a system instruction attributed to no one; the transcript would show the model
  responding to a message the user never sent.
- Codex `thread/inject_items` for the same purpose.

### R5 — Provenance is per-plane, not per-session

`ActivitySource` / `ActivityConfidence` / `ActivityExposure` (`src/activity/types.ts:23-25`)
are set by whatever produced the item, and a single session may mix them — a hook-bridged
Claude session gets `provider-api`/`exact`/`provider-exposed` items from hooks *and* may still
have `transcript`/`inferred`/`transcript-derived` items from the polling observer for the parts
hooks do not cover.

| Producer | source | confidence | exposure |
| --- | --- | --- | --- |
| Codex app-server / daemon stream | `provider-api` | `exact` | `provider-exposed` |
| Claude Agent SDK stream | `provider-api` | `exact` | `provider-exposed` |
| Hook bridge | `provider-api` | `exact` | `provider-exposed` |
| `SelectedTranscriptActivityObserver` | `transcript` | `inferred` | `transcript-derived` |
| Discovery heuristics (`agent-sessions.ts`) | `transcript` | `heuristic` | `transcript-derived` |

Hook events **are** provider events: the harness called us, synchronously, with its own payload.
Labelling them `inferred` would be as dishonest as labelling a transcript guess `exact`.

### R6 — Two controllers is a state, not an error

Adoption creates a case that never existed: a session with a live cockpit plane *and* a live
foreign controller (a TUI, an editor). The existing native-handoff state machine
(`src/server/server.ts:345-364`, `:1963-2226`) already models exactly this, with statuses
`preparing | prepared | authorized | attached | reclaiming | degraded`.

Reuse it. Do not add a parallel mechanism.

- An adopted thread whose foreign controller is live is `attached`; cockpit **writes stay
  disabled**, observation continues at full fidelity.
- Loss of certainty about who controls the session resolves to `degraded` and fail-closed, as
  it does today (`src/server/server.ts:1944`, `:2107`).
- Capability withdrawal on a per-method basis already exists for Codex `-32601`
  (`src/providers/codex/adapter.ts:713-721`) and on transport loss (`:651-693`). Adopted
  threads use the same paths.

### R7 — Every plane states itself in the UI

The session panel (design `9b`) answers "what may it do" in plain sentences with a tick,
question mark or cross — never provider strings like `danger-full-access`. The plane name and
its reason for any withheld capability must be available to that surface. Extend `SessionControl`:

```ts
export interface SessionControl {
  plane: ControlPlane;
  capabilities: ControlCapability[];
  managerOwned: boolean;
  writableLease: boolean;
  /** NEW — why a capability the plane could offer is currently withheld. */
  withheld?: ReadonlyArray<{ capability: ControlCapability; reason: string }>;
}
```

`withheld` is what turns a greyed-out control into an explanation. It is display-only and must
never be consulted for authorisation — the gate reads `capabilities`.

## Non-goals

- Adopting a Codex thread whose daemon is not running. No daemon, no `codex-daemon` plane.
- Any Claude adoption path built on `--resume` of a session the manager did not own. That
  creates a second controller for a live conversation with no arbitration primitive, which is
  the hazard R6 exists to prevent. `ClaudeManagedSession` documents this deliberately
  (`src/providers/claude/managed-session.ts:80-84`).
- Remote Control. It is cloud-routed with no local endpoint (appendix §2.1).

## Acceptance criteria

1. `ControlPlane` and `ControlCapability` extended; `requiredCapability()` exhaustive and compiling.
2. A session on each plane produces exactly the capability set in R3, verified by unit test per plane.
3. `POST /actions` for a capability absent from the plane returns `409 CAPABILITY_UNAVAILABLE`
   without reaching a provider adapter.
4. A `claude-hook-bridge` session rejects `send` at the gate, and the composer explains why
   rather than silently disabling.
5. `withheld` reasons render in the session panel; no provider string leaks into that surface.
6. Existing tests for lease gating, generation staleness and native-handoff status transitions
   still pass unmodified.

## Open questions

- **Q1.** Should `codex-app-server` (private socket) survive at all once `codex-daemon` works,
  or does the manager always go through the daemon? Keeping both doubles the supervisor's
  surface. Defer until spec 02's spike lands — if the daemon is reliable, collapsing to one
  path is a simplification worth taking.
