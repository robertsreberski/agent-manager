# 02 — Codex daemon adoption

**Status:** Draft, **gated on a spike** · **Depends on:** 01 · **Design frames:** none (backend)

## Purpose

Let Agent Manager control Codex threads it did not start — the ones a person opened in a
terminal — by joining the shared app-server daemon as a second client instead of spawning a
private one.

## Prerequisite — run this spike before implementing

Two questions decide how much of this spec is real. Both need a live daemon and two clients;
neither can be answered from the schema. **Record the answers in this file before writing code.**

**S1 — Can a second client drive a foreign thread?**
Start a daemon, open a thread from the TUI (`codex --remote unix://~/.codex/app-server-control/app-server-control.sock`),
then from a second connection: `thread/list` → does the TUI's thread appear with
`source: "cli"`? Then `thread/read` it, then `turn/start` / `turn/steer` / `turn/interrupt`.
Record which succeed and what errors the failures return.

**S2 — Who receives server→client requests?**
With both clients subscribed, trigger an approval (a command needing permission). Determine
whether `item/commandExecution/requestApproval` is delivered to: both clients, the
first-connected, or only the thread's originator. Then have the *non-receiving* client attempt
to answer, and observe `serverRequest/resolved`.

**The answer to S2 decides the plane's `respond` capability.**

| S2 outcome | Consequence |
| --- | --- |
| Broadcast to all subscribers, first answer wins | `respond: ✓`. `serverRequest/resolved` drives optimistic-UI reconciliation (R6). |
| Only the originating client | **`respond: ✗`.** Remove it from the matrix in spec 01 R3. Adopted threads are observe + `interrupt` only, and the cockpit says so. Do not ship a control that silently fails. |
| Broadcast but only originator may answer | `respond: ✗`, but the request is still *shown* — with an explicit "answer this in the terminal" affordance. |

Also record: **S3** — does `thread/list` include threads from *other users*' daemons or only
this uid's? (Expected: uid-scoped by socket ownership, but verify — it feeds an authorization
boundary.) **S4** — what happens to an adopted thread when the daemon restarts?

## Background

From `appendix-harness-capabilities.md` §1:

- The daemon control socket is `~/.codex/app-server-control/app-server-control.sock`, mode
  `0600`, and already present on the dev machine.
- `thread/list` is a paginated, cwd-filterable index returning `Thread` records with `id`,
  `sessionId`, `cwd`, `status`, `turns`, `preview`, `cliVersion`, `createdAt`, `updatedAt`.
- `ThreadSourceKind` distinguishes `cli` (terminal) from `appServer`, `vscode`, `exec` and the
  `subAgent*` family.
- `thread/loaded/list` enumerates threads currently loaded in the daemon.
- `thread/unsubscribe` exists, implying per-client subscription.
- `serverRequest/resolved` is broadcast when a server→client request is answered.

Two pieces of the codebase are already built for this and have **zero production callers**:

- `CodexAppServerAdapter.resumeThread()` (`src/providers/codex/adapter.ts:472-492`) — issues
  `thread/resume` with `excludeTurns: false`. Only referenced by `adapter.test.ts`.
- `listManagedSessions()` (`src/server/persistence.ts:451-465`) — reads the
  `managed_sessions` table (`UNIQUE(provider, provider_session_id)`, `:179-188`). No caller in `src/`.

`README.md:288-292` describes the gap they were left for: *"Provider session metadata is
persisted, but automatic semantic re-adoption after a manager restart is not yet enabled."*

## Requirements

### R1 — A second supervisor mode, not a relaxed first one

`src/providers/codex/supervisor.ts:191-196` refuses to connect to or replace an existing socket:

> `"Refusing to connect to or replace an existing Codex socket"`

**Keep that refusal exactly as it is for the private-socket path.** It guards against hijacking
a socket the manager did not create. Daemon attachment is a *separate, opt-in code route* with
its own preconditions:

1. The socket path is the canonical daemon control socket, resolved from `CODEX_HOME` (default
   `~/.codex`), not from a caller-supplied argument.
2. The socket passes the same ownership checks used for tmux sockets — non-symlink,
   socket-typed, uid-owned. Reuse `safeOwnedSocket` (`src/core/tmux.ts:164-173`) and
   `safePrivateDirectory` (`:152-162`) rather than writing a second implementation.
3. `codex app-server daemon version` reports a running app-server within the supported range
   (`SUPPORTED_VERSION`, `src/providers/codex/adapter.ts:44`). Version drift disables the plane
   rather than falling back to an unverified protocol, consistent with `README.md:88`.
4. Agent Manager **never starts, restarts or stops the daemon.** If it is not running, Codex
   sessions behave exactly as they do today. The daemon is the user's, and its lifecycle is
   `codex`'s business.

### R2 — Discovery through the daemon supersedes the scan, when available

When the daemon is reachable, `thread/list` + `thread/loaded/list` are the authoritative Codex
index. That replaces — for Codex only, and only while the daemon is up — the process scan,
`lsof` rollout-file resolution and read-only SQLite projection in
`agent-sessions.ts:1579-1686`.

- Keep the existing scan as the fallback. It is the only path when no daemon runs.
- Reconcile by `sessionId`: a thread present in both must produce one session record, not two.
  `replaceDiscoveredSessions()` (`src/server/server.ts:402-415`) already drops discovery results
  for ids the manager holds; extend that rule to daemon-adopted ids.
- Map `ThreadSourceKind` onto the existing `SessionKind` / ownership model. `cli` and `vscode`
  are foreign-controlled; `appServer` is a candidate for manager ownership; `subAgent*` are
  children and must attach to their parent, matching the hierarchy `session-navigation.ts`
  already builds.
- `thread/list` is paginated and could be large. Bound it: filter by the cwds of known
  workspaces, cap pages, and never let it block the 15s reconcile
  (`src/discovery/reconciler.ts:59-116`).

### R3 — Adoption is explicit and reversible

Adopting a thread means: subscribe, project its stream into the activity hub, and advertise the
`codex-daemon` plane. It does **not** mean taking ownership.

- Adoption is per-session and driven by the operator selecting the session, not blanket at
  startup. Blanket subscription to every thread in the daemon would flood the hub and is not
  what "selected-session activity" means anywhere else in this codebase.
- `thread/unsubscribe` on deselect, mirroring the ref-counted `acquire`/`release` shape of
  `SelectedTranscriptActivityObserver` (`src/server/activity-observer.ts:113-143`).
- A session record must state its plane truthfully the moment adoption fails or the daemon
  drops: fall back to `observe-only` (or `tmux-attach` if a pane resolves) rather than keeping a
  stale `codex-daemon`.

### R4 — Restart re-adoption

On startup, `listManagedSessions()` yields persisted `(provider, provider_session_id)` pairs.
For Codex, cross-reference against `thread/list` and re-adopt the ones still present. This
closes the `README.md:288-292` gap for the daemon case.

Re-adoption is subject to R6: a re-adopted thread with a live foreign controller is `attached`,
not writable.

### R5 — Foreign-controller detection

`thread/environment/connected` / `thread/environment/disconnected` (server notifications) and
`thread/status/changed` are the signals. Map them onto the native-handoff status machine
(spec 01 R6):

| Observation | Status | Cockpit writes |
| --- | --- | --- |
| Thread has a live foreign environment | `attached` | disabled |
| Foreign environment disconnected, cleanly | reclaim → adopted | enabled |
| Ambiguous, or reclaim unresolved | `degraded` | disabled |

**Do not infer "no foreign controller" from silence.** Absence of a connected notification when
we subscribed mid-life is not evidence the TUI is gone. If the daemon does not expose current
environment state on subscribe, treat unknown as `attached` and say so.

### R6 — Concurrent-answer reconciliation

Assuming S2 lands on broadcast: two controllers may both be showing the same approval. The
cockpit must handle losing that race gracefully.

- On `serverRequest/resolved` for a request the cockpit is showing, mark the attention item
  `resolved` and state who resolved it if the payload says. The inline controls disappear
  without an error.
- A `respond` action for an already-resolved request returns `409 REQUEST_STALE` — the existing
  check at `src/server/server.ts:1434-1439` already covers this; make sure adopted-thread
  attention records flow through the same `session.attention[]` path so they get it.

### R7 — Capability derivation

Derive from the daemon's advertised controls exactly as `provider-bridge.ts:183-210` derives for
the private socket. Do not hardcode the R3 matrix from spec 01 — that matrix is the ceiling, and
`adapter.capabilities.controls` is the authority. The `-32601` withdrawal path
(`src/providers/codex/adapter.ts:713-721`) applies unchanged.

### R8 — Unexploited protocol surface

Wire these while adopting, because they replace guesses with facts. Each is optional to the
adoption itself but load-bearing for a later spec:

| Method | Consumer |
| --- | --- |
| `model/list` | spec 06 — composer model picker |
| `permissionProfile/list` | spec 06 — access control |
| `thread/archive` / `unarchive` / `delete` | spec 10 — multi-select bar |
| `thread/name/set` | spec 05 — session rename |
| `account/usage/read`, `account/rateLimits/read` | spec 11 — session panel cost facts |
| `hooks/list`, `skills/list`, `plugin/list` | spec 11 — "what it may do" |

Also add the two server notifications the projector currently drops, since they are real harness
activity the cockpit is hiding today:
`item/autoApprovalReview/started` / `completed`, and `item/fileChange/outputDelta`
(`src/providers/codex/activity-projector.ts:628-920`).

## Non-goals

- Starting or managing the daemon's lifecycle (R1.4).
- `thread/inject_items` as a steering channel (spec 01 R4).
- `thread/fork` / `thread/rollback` / `thread/compact/start`. Real and interesting; not in the
  redesign. Noted so they are not reinvented later.
- Remote (SSH) daemon adoption. `src/remote/manager.ts` proxies HTTP, not the app-server
  protocol. Local only in this pass.

## Acceptance criteria

1. Spike results S1–S4 are recorded in this file and the spec 01 R3 matrix reflects S2.
2. With no daemon running, Codex behaviour is byte-identical to today. Verified by the existing
   discovery and provider test suites passing unmodified.
3. With a daemon running and a thread started from a real terminal, the cockpit lists it, states
   plane `codex-daemon`, and shows its live activity with `provider-api` / `exact` /
   `provider-exposed` provenance.
4. While that terminal is attached, cockpit writes are refused with a stated reason — not
   silently greyed.
5. After the terminal exits, the cockpit reclaims and the advertised capabilities widen. After a
   manager restart, the thread is re-adopted from `listManagedSessions()` + `thread/list`.
6. A socket that is a symlink, not uid-owned, or outside `CODEX_HOME` is refused. Test this;
   it is an authorization boundary.
7. `SECURITY.md:37-41` and the `README.md` control table are rewritten in the same commit.

## Open questions

- **Q1.** Does the daemon expose current environment/attachment state on subscribe, or only
  transitions? Decides whether R5's "unknown ⇒ attached" is a permanent rule or a fallback.
- **Q2.** `codex remote-control pair` prints a short-lived pairing code. Is there a
  daemon-mediated remote path that would make R-goal "remote daemon adoption" cheap later?
  Out of scope, worth knowing.
