# Security model

Agent Manager is a single-user personal control plane for agents that may already have broad
filesystem and command access. Treat access to an authenticated browser session or the private
owner socket as access to those agents.

## Network and browser boundary

- HTTP binds to `127.0.0.1` only and rejects unknown Host/Origin values. Optional private remote
  access is an exact Tailscale Serve HTTPS route back to loopback; Funnel is never used.
- Browser bootstrap is a short-lived, single-use URL-fragment secret exchanged for an HttpOnly,
  SameSite cookie and removed from history. The private owner socket is the only token issuer.
- Browser mutations require session cookie, CSRF token, expected generation, idempotency key,
  and a short principal/client-bound writer lease. The UI acquires/renews/releases the lease
  automatically; a competing window receives an explicit conflict and may take over subsequent
  writes. The losing action is not replayed.
- Global session state/SSE is metadata-only. Exact prompts, options, messages, commands, diffs,
  paths, and transcript snippets are available only through authenticated selected-session
  routes with `Cache-Control: no-store`.
- PWA cache contains only the versioned public shell/assets/fonts. API, auth, SSE, health,
  source maps, and session data are never cached. Wire/build epoch mismatch fails closed and
  forces a current shell/update.

## Hook boundary

Claude hooks post to a provider-specific loopback route authenticated by a high-entropy
per-install token. The route is exempt from browser cookie/CSRF because it is not a browser, but
retains loopback/Host checks, constant-time token validation, body/time limits, no-store, and
redaction. Tokens never enter browser state or logs.

Codex hooks execute a pinned absolute command shim with `shell: false`; the shim posts stdin to a
separate Codex route/token. Codex requires explicit trust of the exact hook hash. Claude and
Codex payloads and return schemas are parsed separately.

Only an exact held provider request may become respondable. External Claude is limited to
`PermissionRequest`; Codex is limited to request shapes verified against the pinned command-hook
integration. Pending decisions are memory-only, single-resolution UUIDs. Timeout, shutdown, or
error releases the hook with a provider-safe no-decision/empty successful result, so a terminal
is never wedged waiting for the browser. Hooks do not grant queue, steer, settings, process
ownership, or arbitrary message injection.

Installation is explicit from the CLI, shows the exact diff, requires confirmation, modifies
only Agent Manager-owned entries, and never touches managed policy. Disposable integration tests
use isolated settings overlays and do not alter global settings/trust or existing sessions.

## Provider, controller, and terminal boundary

- Every action is gated by the session's live exact capability set. Ownership labels, withheld
  prose, UI state, and capability ceilings never authorize an action.
- Unknown or multiple foreign controllers withdraw semantic writes while observation continues.
  Reclaim is explicit and fails closed; absence of a transition event is not proof of exclusive
  ownership.
- Shared Codex daemon attachment was rejected by the two-client safety gate. Agent Manager never
  connects to, starts, restarts, stops, bootstraps, or enables remote control on the user's
  daemon. `codex-private`, the single isolated manager-owned app-server path, is the only managed
  Codex plane.
- Manager-owned Claude uses the pinned Agent SDK Query. `Query.close()` is available only for a
  query Agent Manager owns. External Claude has no semantic queue/steer/end channel.
- Native attach commands are a closed validated argv union with pinned absolute executables and
  `shell: false`. The browser receives only the Agent Manager wrapper, never raw provider argv.
  Tmux is read-only capture/attach; there is no `send-keys` or browser terminal.
- `Open in editor` is an authenticated CSRF-protected server action. The browser supplies only a
  normalized session/file identity. The server enforces worktree containment/no symlink escape
  and invokes one configured pinned editor executable with `shell: false`; unsupported remote or
  deleted paths have no action.

## Filesystem and persistence

The state directory and owner socket are private/current-user owned (`0700`/`0600`). This
pre-prototype may cold-reset only its exact incompatible `config.json`, SQLite database and
sidecars, and obsolete browser caches. It never resets provider transcripts/settings/hooks,
credentials, repositories, worktrees, tmux state, or the user's daemon.

Creating a worktree from the new-thread screen is the one write this product makes to a
repository: an authenticated, rate-limited, local-host-only `git worktree add -b` under
`<repoRoot>/.worktrees/`, plus an append to `info/exclude`. The name is validated before any
process is spawned and is argv-only with `shell: false`; an existing directory or branch is
refused rather than replaced, and nothing here deletes a worktree, a branch, or history.

Session creation/actions are idempotency-keyed before provider dispatch. Ambiguous outcomes are
`unknown` and never replayed automatically. Audit records contain structural metadata, a payload
digest, character count, and fixed summary—not prompt/answer/denial text or arbitrary provider
results.

Selected activity is a bounded volatile materialization and replay ring, not durable history.
Its prefix eviction is visible. Transcript/plan reads reuse a session-scoped hardened reader:
allowed roots, current-user ownership, no symlink components/leaf, `O_NOFOLLOW`, bounded reads,
and dev/inode verification after open. There is no general filesystem read or fake history
endpoint.

Before browser delivery, secret-shaped fields and recognized credential/private-key forms are
redacted, unsafe terminal/bidirectional control characters are stripped, and provider HTML is
never interpreted. Hidden system/developer prompts, encrypted/redacted thinking, signatures,
raw protocol envelopes, environment values, terminal stdin, and internal stack traces are
excluded structurally.

## Remote and host trust

SSH targets are configured stable IDs. OpenSSH is invoked without a local shell and a bounded
JSON-lines bridge bootstraps the remote private owner socket; remote cookies/CSRF tokens never
reach the browser/controller. Wire mismatch refuses the bridge until the explicitly named host
is reinstalled.

The Tailscale installer owns one exact route, requires the selected HTTPS port to be unused, and
rechecks local login/device identity before removal. Tailscale does not provide transactional
compare-and-swap, so another trusted local process can race a Serve edit. The local macOS user,
administrators, and root remain trusted host principals.

Notifications are local-only and have no Push transport. Default lock-screen content is generic;
exact question, command, cwd, or answer text is never placed in a notification. Notification
actions only focus/select the session and cannot mutate provider state.
