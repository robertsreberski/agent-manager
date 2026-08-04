# 02 — Codex shared-daemon decision

**Status:** Accepted · **Outcome:** NO-GO · **Depends on:** 01 · **Design frames:** none

## Decision

Agent Manager does not attach to the user-owned shared Codex daemon. Its sole managed Codex
control plane is `codex-private`: one isolated app-server process and socket whose lifecycle is
owned by Agent Manager. Ordinary official CLI sessions remain visible through the trusted Codex
command hook when installed and through bounded observation otherwise; they do not inherit the
private plane's write authority.

`codex-app-server` remains the upstream protocol name. It is not a `ControlPlane` value, public
wire label, compatibility alias, or second implementation path.

## Why the shared daemon is a NO-GO

The inspected host has Codex CLI `0.146.x` while the running daemon reports app-server `0.145.x`.
That canonical daemon is user-owned, unsupported by the pinned integration, and must remain
untouched. More importantly, safe second-client authority was not established for request
routing or a thread that already has another environment/controller.

Shared-daemon adoption would have required all of the following to pass in an isolated,
disposable two-client probe:

1. A canonical uid-owned, non-symlink socket and an exact supported CLI/app-server version pair.
2. Bounded `thread/list`, exact `Thread.id` identity, read, subscribe/unsubscribe, turn
   start/steer/interrupt, and reconnect without duplicate or replayed activity.
3. Deterministic approval delivery plus `serverRequest/resolved` first-winner reconciliation.
4. Exact current foreign-environment/controller state for a mid-life thread, or an explicit
   safe reclaim handshake. Missing connection events are not proof of exclusive authority.
5. Restart/reconnect that re-lists and re-subscribes without replaying actions or retaining a
   stale writable state.

Failure to prove any item is a NO-GO. The production implementation therefore contains no
shared-daemon connector, configuration, socket discovery, lifecycle command, or dormant plane.

## `codex-private` contract

- Agent Manager resolves the pinned Codex executable itself, launches one private app-server
  with `shell: false`, owns its socket, and stops only that child during shutdown/deploy.
- The caller cannot supply the executable, socket, or daemon address. Private paths are
  canonical, current-uid owned, non-symlink, and socket-typed before use.
- `Thread.id` is `providerThreadId`; protocol `sessionId` is `providerTreeId`; the distributed
  ID is `${hostId}:codex:${providerThreadId}`. `parentThreadId` resolves to the same composed
  parent ID. Tree ID is never substituted for session identity.
- Manager-created private threads are reconciled by at most 100 concurrent-bounded exact
  `thread/read(includeTurns=false)` calls against their persisted provider IDs. Startup never
  scans the global rollout corpus. A failed read retains the durable handle because Codex's
  `thread not loaded` error does not prove deletion; selecting a recovered session performs one
  identity-checked resume and ref-counts its detailed subscription.
- Live provider methods and controller state define capabilities. Method-not-found, transport
  loss, or ambiguous authority withdraws the affected action immediately.
- The private app-server process starts with only Agent Manager's RPC client; restarting it
  disconnects every previous environment. During selection, notifications and server requests
  are buffered until the resume response matches the cold thread ID, tree, parent, and cwd.
  Nothing from an acquiring resume may replace the cold identity or expose controls. Any live
  foreign-environment event withdraws writes before the selected state is published. The pinned
  experimental `excludeTurns=true` resume flag suppresses unbounded historical turn replay;
  activity continues from the selected live stream.
- With experimental API enabled, idle settings use the pinned `thread/settings/update` request
  and accept `thread/settings/updated` as effective state. `-32601` withdraws live update; the
  selected values become `turn/start` overrides on the next turn.
- `thread/archive`, `thread/unarchive`, `thread/delete`, model/profile lists, account facts, and
  request resolution are exposed only when the pinned schema and live runtime support them.
- Product end interrupts active work, clears only the manager queue, unsubscribes/detaches, and
  retains the resumable thread. Codex has no `thread/close` RPC.
- Deprecated `item/fileChange/outputDelta`, `thread/inject_items`, fork, rollback, and compact
  are outside the cockpit contract.

## External Codex sessions

The hook/observe projectors may correlate an official CLI session by exact
`providerThreadId`, but they never become `codex-private`. They advertise no queue, steer,
interrupt, settings, lifecycle, or approval response unless the pinned trusted hook exposes the
exact live request shape. Process and transcript evidence can improve visibility only.

## Failure and deployment

Wrong uid, a symlink/non-socket path, unsupported version, lost private child, or ambiguous
controller state withdraws semantic capabilities and retains only a stale timestamped metadata
snapshot. Reconnect never replays an action. `pnpm deploy` rebuilds and reloads Agent Manager's
private runtime only; it never inspects, restarts, replaces, or repairs the user's shared daemon.

## Acceptance criteria

1. `codex-private` is the only managed Codex `ControlPlane` value in source, tests, and wire
   fixtures; no `codex-daemon` or `codex-app-server` alias remains.
2. Tests prove the manager owns exactly one private app-server lifecycle and rejects unsafe
   executable/socket/version inputs.
3. Manager-created private sessions preserve provider thread/tree/parent identity and recover
   without a global history scan, duplicate activity, identity poisoning, or action replay.
4. Ordinary CLI sessions remain discoverable through hook/observation and never acquire private
   write capabilities.
5. Settings tests prove effective notification, idle-only selection, `-32601` withdrawal, and
   next-turn fallback.
6. Repository and deploy checks prove Agent Manager never invokes shared-daemon lifecycle or
   connection code.
