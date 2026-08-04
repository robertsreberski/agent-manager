# Agent Manager

Agent Manager is a local cockpit for Codex and Claude sessions on macOS. It
combines read-only discovery of sessions that already exist with a guarded
control plane for sessions launched by the manager.

The original dependency-free listing script remains available as
`agent-sessions.ts`. The service adds a responsive browser UI, live SSE state,
mode and attention detection, safe tmux preview/attach, and manager-owned
Codex/Claude controls. Selecting a session opens a private live activity stream
without placing conversation content in the global session feed.

## What it can control

| Session | Observe state/mode | Preview or native attach | Queue / steer / interrupt | Answer prompts / approvals |
| --- | --- | --- | --- | --- |
| Existing Codex or Claude | Yes, with evidence confidence | Only with an unambiguous tmux target | No | No |
| Manager-owned Codex | Exact mode and request evidence; normalized activity | Codex TUI over the manager's private Unix socket | When currently advertised | Supported structured requests |
| Manager-owned Claude | Exact mode and request evidence; normalized activity | Guarded idle handoff to normal Claude CLI | When currently advertised | Supported structured requests |

The managed rows are capability ceilings, not unconditional guarantees. The
session's current control plane and advertised `control.capabilities` are
authoritative; a provider version/capability failure or active native handoff
can withdraw an individual action without weakening the rest of the session.
MCP elicitation forms are visible but deliberately non-respondable in the
cockpit; continue those in the native provider interface.

Existing sessions are intentionally not “adopted.” For those, the cockpit can
show what local evidence supports and, when an exact tmux mapping exists, take
you to the real terminal. It does not inject keystrokes or pretend it has a
semantic steering API.

For managed sessions, planning/execution mode is independent from activity
(`running`, `waiting`, or `idle`). Exact pending questions—including atomic
multi-question forms—and approval requests appear in the cockpit.

## Live activity

The selected session updates while a provider turn is running. The timeline can
show user and assistant messages, provider-exposed reasoning, plans, tool calls,
arguments and results, command output, file diffs, subagents, queue state,
approvals, warnings, lifecycle events, and usage. Active work stays expanded;
completed details collapse, failures stay open, and scrolling away from the
bottom pauses auto-follow without pausing ingestion.

“Provider-exposed reasoning” means only reasoning text or summaries explicitly
returned by Codex or Claude. Agent Manager never exposes hidden prompts,
encrypted/redacted thinking, signatures, raw protocol envelopes, environment
values, or terminal stdin. It does not enable extra model-generated progress
summaries merely to populate the UI.

Managed sessions use their live App Server or Agent SDK stream. External,
rediscovered, and native-handoff sessions use selected-only bounded transcript
observation and are labeled transcript-derived. The selected activity window is
volatile: provider transcripts remain the durable history, while Agent Manager
keeps only a bounded in-memory materialization and replay ring.

The selected-session API is deliberately separate from global state:

```text
GET /api/v1/sessions/:id/activity/events  # private selected-session SSE
GET /api/v1/sessions/:id/activity         # bounded history page
GET /api/v1/events                        # metadata only
```

The default materialized window is at most 400 semantic items or 1 MiB. Large
fields are capped at 128 KiB, and replay is capped at 512 frames, 2 MiB, or 15
minutes. Truncation is visible in the UI; native attach remains the verbose
escape hatch.

## Requirements

- macOS and Node.js 24
- pnpm 11
- Codex CLI `0.146.x` for managed Codex controls
- Claude Code `2.1.220` and `@anthropic-ai/claude-agent-sdk` `0.3.220`
- tmux 3.6 for pane preview/attach
- Tailscale is optional

Run the preflight report at any time:

```sh
pnpm exec tsx src/cli/index.ts doctor
```

Version drift disables the affected semantic control path rather than falling
back to an unverified protocol.

## Development quick start

```sh
pnpm install
pnpm check

# Allow managed sessions to start in this workspace.
pnpm exec tsx src/cli/index.ts workspace add "$PWD"

# Terminal 1: loopback-only service and UI.
pnpm exec tsx src/cli/index.ts serve

# Terminal 2: issue a fresh one-time browser link.
pnpm exec tsx src/cli/index.ts open
```

The backend listens on `127.0.0.1:43127`. The browser URL contains a short-lived
secret in the fragment; the UI exchanges it for a private browser session and
removes it from the address bar. `open` always requests a fresh token through
the owner-only Unix socket.

For a production build:

```sh
pnpm build
node dist/cli/index.js serve
node dist/cli/index.js open
```

Configuration and SQLite state live under
`~/Library/Application Support/agent-manager/`. Runtime sockets live under
`/private/tmp/agent-manager-<uid>/`. These locations are created with private
permissions.

## CLI

```text
agent-manager list [agent-sessions options]
agent-manager serve [--host 127.0.0.1] [--port 43127]
agent-manager open [--no-browser]
agent-manager attach <session-id>
agent-manager doctor [--json]
agent-manager workspace list|add <path>|remove <id>
agent-manager tailscale install|status|off
agent-manager service print|install
agent-manager panic-lock
agent-manager panic-unlock
```

`attach` is the verbose/native escape hatch:

- an external tmux-owned session opens its exact tmux server and session;
- a managed Codex session opens `codex resume … --remote unix://…` against the
  private App Server;
- a managed Claude session first verifies that it is idle and drained, hands
  exclusive ownership to `claude --resume`, and reclaims SDK ownership when the
  native child exits.

Commands are validated against those three argv grammars and spawned without a
shell. The browser only displays a copyable command; it cannot execute it.
Preparing a managed native attach releases the browser write lease and excludes
cockpit writes until the native child exits and provider ownership is safely
reclaimed. Ambiguous wrapper/child lifecycles fail closed and keep writes
disabled instead of risking two concurrent controllers.

`panic-lock` first creates a persistent private sentinel, then closes the
manager control plane, releases browser leases, and stops manager-owned provider
transports. It does not kill a native child or type into unrelated existing
agent sessions. The sentinel keeps future starts blocked even if live cleanup
is incomplete; `panic-unlock` explicitly releases it after you have inspected
the host.

## Web cockpit and PWA

The web cockpit uses a compact scope rail, hierarchical session list, and one
active session workspace. Scope and selected-session filters are URL-backed, so
installed-app shortcuts and copied links open the same view. The transcript
renders provider-reported messages, safe reasoning, plans, tool calls, file
changes, subagents, usage, and attention requests as live activity arrives.
Writable controls remain capability- and lease-gated.

Agent Manager is installable as a PWA over its private HTTPS Tailscale URL.
Supported browsers expose an **Install Agent Manager** action in the session
footer; on iPhone and iPad the cockpit shows the Safari Share → Add to Home
Screen instructions. Updates are prompt-based. Applying one releases this
browser session's active writer leases across every open tab, then every
controlled tab reloads onto the new shell. The agent processes keep running.

Only the versioned public app shell is precached. API, authentication, SSE,
action, health, source-map, and session data responses are never placed in a
service-worker cache. A cold offline launch can show only the public shell and
cannot load or mutate session data. An already-open tab retains its in-memory
snapshot as a stale, read-only view until it is closed or reconnects. Moving the
app into the background immediately covers the cockpit to reduce task-switcher
leakage.

## Private Tailscale access

Agent Manager never binds to a LAN or tailnet address. Optional remote access
uses one exact Tailscale Serve HTTPS route to the loopback backend:

```sh
pnpm exec tsx src/cli/index.ts tailscale status
pnpm exec tsx src/cli/index.ts tailscale install
```

The installer:

- selects HTTPS port `9443`, which is not Funnel-capable;
- requires that HTTPS port `9443` is wholly unused and refuses to overwrite any
  existing listener or path mapping;
- records the exact local Tailscale login and device DNS name; and
- removes only that owned route with `agent-manager tailscale off` after
  re-verifying the recorded local login and device identity.

Configure the route before starting the service, or restart the service after
installation so it loads the recorded identity. Other Tailscale Serve routes
remain untouched. Removal is scoped to `/`, so other paths added later on the
same port survive. Tailscale does not offer a transactional compare-and-swap
between route inspection and mutation; a concurrent Serve edit by another
trusted local process can race this check.

## LaunchAgent

After choosing a stable built/global CLI path:

```sh
agent-manager service print
agent-manager service install
```

`service install` writes a user LaunchAgent but does not silently load it. It
prints the exact `launchctl bootstrap` command so activation remains explicit.
The generated service is still loopback-only. It starts through
`/usr/bin/env -i`, so arbitrary variables from the user launchd domain do not
reach Agent Manager or its provider children. The explicit non-secret allowlist
contains the user identity and runtime paths (`HOME`, `USER`, `LOGNAME`,
`TMPDIR`, and `SHELL`), the controlled `PATH`, and the exact Agent Manager
executable pins. The standard installer does not snapshot a transient
`SSH_AUTH_SOCK`; callers generating a custom plist may add only a deliberately
configured stable socket path. Provider API keys and other tokens are never
persisted in the plist. Durable Codex and Claude service sessions must therefore
use their standard per-user filesystem/keychain login; provider credentials
available only through environment variables are supported by an interactive
`agent-manager serve` process until an explicit secret source is configured.

## Read-only listing script

The original script remains useful without running the service:

```sh
./agent-sessions.ts
./agent-sessions.ts --since 1h
./agent-sessions.ts --since 0 --json
./agent-sessions.ts --provider codex --children
./agent-sessions.ts --status running,waiting
```

It reads Claude Agent View/registry/transcript data, Codex processes/rollouts and
read-only SQLite state, plus tmux pane topology. JSON schema version 2 includes
ownership, runtime liveness, mode evidence, attention evidence, effective
access, terminal target, capabilities, and service generation.

The service runs this synchronous discovery inside a Worker every 15 seconds.
Scans never overlap; failures retain the last snapshot and mark it stale.

## Safety and current limits

- There is no writable browser terminal and no tmux `send-keys` fallback.
- Browser control is single-writer, generation-checked, idempotency-keyed, and
  separately armed for full-host sessions.
- The writer lease is per session and bound to the authenticated actor, browser
  session, client ID, and rotating token. The UI uses a five-minute lease;
  another tab/browser stays read-only until explicit release or expiry. Closing
  or reloading the controlling tab without releasing may therefore delay a new
  controller until expiry.
- A standard session launched in the browser automatically acquires its
  five-minute writer lease for that browser. Full-host creation and arming
  remain separate explicit confirmations.
- Session creation is also idempotency-keyed. An interrupted creation is marked
  `unknown` and is never blindly replayed against a provider.
- A manager process owns its live SDK/App Server transports. Provider session
  metadata is persisted, but automatic semantic re-adoption after a manager
  restart is not yet enabled; rediscovered sessions remain safely observable.
- External mode and “needs input” status can be heuristic because provider
  transcript files lag live in-memory state. The UI shows source/confidence.
- Tailscale identity headers rely on the loopback proxy boundary and assume the
  local macOS user account is trusted.
- The browser renders only a bounded activity window for the selected session.
  It includes safe provider-exposed reasoning and tool traffic, but clips large
  fields and omits hidden/internal data. Use `agent-manager attach <session-id>`
  for the provider's native interface while preserving the guarded ownership
  handoff.

See [SECURITY.md](./SECURITY.md) for the complete trust model.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm test:web
pnpm build

# Everything above in sequence:
pnpm check
```

Provider tests use fake SDK/RPC transports and private temporary sockets. The
test suite never steers, interrupts, resumes, or otherwise mutates a current
user session.
