# 02 — Codex private-server peer adoption

**Status:** Accepted · **Outcome:** GO for shared peers on the manager-owned server; NO-GO for the user-global experimental daemon · **Depends on:** 01 · **Design frames:** none

## Decision

Agent Manager owns one pinned private Codex app-server process and canonical uid-owned Unix
socket. Its managed control plane remains `codex-private`. That server is intentionally
multi-client: the cockpit's backend client and native Codex CLI clients may participate in the
same provider conversation at the same time.

“Private” is a lifecycle and trust boundary, not an exclusive-writer rule. Agent Manager owns
the server process and socket; it does not claim that one environment ID owns a thread. A native
peer joins an already managed thread with the closed attach command:

```text
codex resume <providerThreadId> --remote unix://<agent-manager-socket>
```

The browser continues through Agent Manager while that CLI is active. Either peer may send work
the pinned provider protocol permits. Exact provider requests use first-response-wins semantics:
after `serverRequest/resolved`, every losing projection is stale and cannot retry the answer.

`codex-app-server` remains the upstream protocol name. It is not a `ControlPlane` value, public
wire label, compatibility alias, or second implementation path.

## Trust boundary: never adopt the mismatched global daemon

The inspected host has Codex CLI `0.146.x` while its user-global experimental daemon reports
app-server `0.145.x`. Agent Manager does not infer safety from that daemon's existence. It never
silently connects to, trusts, upgrades, restarts, stops, repairs, mutates, or adopts the global
daemon or its socket. Version drift there cannot change the manager's capabilities.

Agent Manager resolves its pinned Codex executable, launches its own app-server with
`shell: false`, and owns only that child's lifecycle. The caller cannot substitute an executable,
socket, daemon address, or environment-derived endpoint. Paths are canonical, current-uid owned,
non-symlink, and socket-typed before use. A future global-daemon integration would require a new
explicitly probed contract; it is not a fallback path.

## Managed shared-peer contract

- `Thread.id` is `providerThreadId`; protocol `sessionId` is `providerTreeId`; the distributed
  ID is `${hostId}:codex:${providerThreadId}`. `parentThreadId` resolves to the same composed
  parent ID. Tree ID is never substituted for session identity.
- The manager backend holds the durable app-server connection. Multiple authenticated browser
  windows dispatch through it, subject to the normal short browser writer lease. A native CLI
  connected with `--remote` is an independent provider peer and remains usable concurrently.
- `thread/environment/connected` and `thread/environment/disconnected` report peer presence.
  Their IDs are observational: they neither identify a controller nor grant/revoke semantic
  authority. Joining or leaving does not withdraw healthy private-plane capabilities.
- Provider request identity is the arbitration key. The first exact valid response wins;
  `serverRequest/resolved` removes respondability everywhere, and a stale response returns a
  typed conflict. Agent Manager never retries or transforms an answer.
- Manager-created threads are reconciled by at most 100 concurrency-bounded exact
  `thread/read(includeTurns=false)` calls against persisted provider IDs. Startup never scans
  the global rollout corpus. Recovery performs one identity-checked resume and keeps the
  detailed provider subscription session-owned; browser drawer/task switching affects only the
  bounded browser observer and never unloads the shared provider thread.
- During cold resume, notifications and server requests are buffered until the response matches
  thread ID, tree, parent, and canonical cwd. Nothing from acquisition may replace the durable
  identity or expose controls. The pinned `excludeTurns=true` flag avoids unbounded replay.
- Experimental idle settings use `thread/settings/update` and accept
  `thread/settings/updated` as effective state. `-32601` withdraws live update and carries the
  selected values as `turn/start` overrides on the next turn.
- Archive, unarchive, delete, model/profile/account facts, and lifecycle actions are exposed only
  when the pinned schema and live server advertise them. Product end interrupts active work,
  clears only the manager queue, unsubscribes/detaches the manager view, and retains the
  resumable thread. There is no `thread/close` RPC.
- Deprecated `item/fileChange/outputDelta`, `thread/inject_items`, fork, rollback, and compact
  remain outside the cockpit contract.

## Standalone CLI migration

A Codex CLI that started on its own connection cannot be rebound in place, and — the load-bearing
half — two Codex processes cannot write one rollout at all: the format has no parent pointers and
gives content records no turn identity, so concurrent writers interleave unrecoverably and break
Codex's own next resume. The measurement is recorded in the appendix. Hook, process, registry, and
transcript evidence therefore remain observation-only until one safe migration puts the same exact
provider thread on Agent Manager's private server.

This is why Codex keeps a migration while Claude does not. Claude's transcript is a
`uuid`/`parentUuid` DAG, so a second writer forks legibly and is joined instead.

The default `guided-exit` flow waits up to five minutes for the operator to exit the standalone
CLI and can be cancelled. `graceful-stop` is a server-enforced two-action flow: the first action
pins the exact process and returns a takeover ID; only a second action carrying that ID may
confirm the stop. Immediately before signalling, Agent Manager revalidates uid, executable, PID start identity, provider session ID,
workspace, transcript/registry association, and that the process is still the intended CLI. It
sends exactly one `SIGTERM`, waits at most 15 seconds, and never sends `SIGKILL`, repeats a
signal, invokes a shell, or injects tmux keystrokes.

After exit, adoption has 30 seconds to identity-check `thread/read` and `thread/resume` through
the private bridge. Observed model, effort, profile, thread/tree/parent IDs, and workspace are
preserved. An unknown profile is shown before confirmation and uses the conservative `plan`
fallback for this migration only. Capabilities become writable only after identity, workspace,
and provider adoption all succeed. The adopted identity is persisted as managed, and a native
CLI can then join the same private thread with `--remote` without another takeover.

Failure preserves history and read-only native recovery guidance. It never starts a second
thread, changes identity, or silently falls back to the user-global daemon.

When the exact conversation is dormant and has no standalone owner, **Resume here** performs the
same `thread/read` identity pin and provisional `thread/resume` entirely from the web action. The
private App Server subscription and any resulting activity remain hidden until the managed
identity commits; failure releases the provisional subscription. Native join commands are an
advanced optional peer path, not a prerequisite for web control.

## Recovery and deployment

Wire schema 5 publishes `coordination = shared / join / first-response-wins` for managed Codex.
`SessionControl.recovery` truthfully reports `reconnecting`, `retrying`, or `needs-attention`
with attempt number and bounded timing/error fields. Automatic reconnect/retry is bounded; a
further safe manual attempt requires the `retry-control` capability. Recovery re-lists, verifies,
and re-subscribes, but never replays sends, turns, answers, interrupts, settings, or lifecycle
actions. Transcript reads remain available independently.
The native-exit state is not a failure or retry loop: internal identity polling stays bounded,
while the public state remains stable until that exact exclusive Claude owner exits.

Losing the manager's private child temporarily removes provider control but does not terminate a
separately running native peer. A peer may reconnect/rejoin the replacement pinned server only
through the exact supported remote flow; Agent Manager must not invent successful continuity.
`pnpm deploy` rebuilds and reloads Agent Manager's private runtime only and leaves the global
experimental daemon untouched.

## Acceptance criteria

1. `codex-private` is the only managed Codex `ControlPlane`; no `codex-daemon` or
   `codex-app-server` alias remains.
2. Tests prove exactly one manager-owned pinned app-server lifecycle, canonical socket checks,
   and rejection of caller-supplied or version-drifted endpoints.
3. A manager web client and native `codex resume … --remote unix://…` peer can use the same
   thread concurrently; peer environment connect/disconnect events never revoke healthy writes.
4. Two peers racing an exact request produce one provider-confirmed winner, one stale loser, one
   reconciled timeline item, and no replay after reconnect.
5. Standalone CLI migration proves guided cancellation, single confirmed `SIGTERM`, PID reuse and
   identity mismatch rejection, bounded exit/adoption timeouts, exact identity preservation, and
   durable managed recovery.
6. Managed recovery is bounded, projects the wire 5 recovery state, gates explicit retry, and
   never replays actions or kills/revokes an active native peer.
7. Repository, runtime, and deploy checks prove Agent Manager never connects to or mutates the
   mismatched user-global experimental daemon.
8. Settings tests prove effective notification, idle-only selection, `-32601` withdrawal, and
   next-turn fallback.
