# Agent Manager

Agent Manager is a personal macOS cockpit for Codex and Claude sessions. It groups work by
repository and worktree, renders one faithful live activity timeline, and exposes only actions
the current harness/control plane can actually honour.

The web cockpit follows the vendored Claude design in `docs/design/cockpit/` and uses
assistant-ui for thread composition. Exact provider events stay exact; transcript/process
inferences remain visibly inferred.

## Control model

| Session origin | Observation | Semantic control |
| --- | --- | --- |
| Manager-owned Claude SDK | Exact SDK stream | Queue, pinned steer, interrupt, exact requests, model/effort/profile, close |
| External Claude CLI | Exact installed HTTP-hook events plus bounded transcript fallback | Live held `PermissionRequest` only; no queue/steer/end |
| Manager-owned Codex | Exact private app-server stream (`codex-private`) | Provider methods exposed by that isolated runtime |
| Ordinary Codex CLI | Trusted Codex command-hook events plus bounded discovery fallback | Only a live hook request shape proved by the pinned integration |
| tmux/resume/observe-only | Bounded evidence with source/confidence | Native preview/attach/resume only when exact; otherwise read-only |

The live capability list is authoritative. A provider/version failure, unknown foreign
controller, or transport loss withdraws actions and explains why. Agent Manager never fakes a
user turn through hook side channels, terminal keystrokes, or `thread/inject_items`.

There is one provider-neutral execution profile:

```text
ask-first | plan | execute | full-access
```

The adapter maps it atomically to provider permission/sandbox semantics. Full access is always
orange. Codex model/effort/profile controls are idle-only: the pinned experimental API updates
them when available, with provider confirmation and next-turn overrides after exact method
withdrawal. Claude SDK controls use its pinned live methods when available.

## Cockpit

- Repository columns split into main/linked worktrees, with host filtering and stable session
  ordering.
- Wants You, Working, Failed, and Idle card states. Transcript-inferred attention uses a dashed
  lime edge, muted body, and `looks blocked — from transcript`; it is never actionable.
- A right overlay drawer with one selected-session activity stream, assistant-ui tool groups,
  subagents, plans, todos, diffs, usage, queue, lifecycle, and exact inline decisions.
- Draft threads replace launch dialogs. First send idempotently creates the provider session;
  ambiguous outcomes are shown and never silently retried.
- Questions submit atomically. Approvals show only provider-supplied or safely derivable facts.
- Local notifications fire only for new exact unresolved request IDs and for completion after
  five minutes continuously away. Notification actions only focus/select the session.
- The activity window is bounded and volatile. When its prefix is evicted, the UI states the
  retention boundary; provider history/native attach is the durable source.

Global state and SSE are metadata-only. Exact messages, prompts, commands, diffs, paths, and
search snippets use authenticated selected-session routes with `Cache-Control: no-store`.

## Requirements

- macOS
- Node.js 24
- pnpm 11
- Codex CLI `0.146.x`
- Claude Code `2.1.222` and `@anthropic-ai/claude-agent-sdk` `0.3.220`
- tmux 3.6 for pane preview/attach
- Tailscale only if private HTTPS access is wanted

Version drift disables the affected semantic plane instead of guessing at protocol parity.

## Develop, verify, deploy

```sh
pnpm install
pnpm dev
```

Run the complete local quality gate:

```sh
pnpm check
```

Build and install/reload the personal LaunchAgent, await health, and open a fresh authenticated
browser session:

```sh
pnpm deploy
```

That is the deployment process. The package is private: no npm publish, release branch, tag,
changelog, GitHub release, version ceremony, or backup/rollback archive is required.

Running `agent-manager` with no arguments opens the cockpit. Useful explicit commands are:

```text
agent-manager serve
agent-manager open [--no-browser]
agent-manager attach <session-id>
agent-manager doctor [--json]
agent-manager hooks status|install|uninstall [--provider claude|codex] [--scope user|project]
agent-manager workspace list|add <path>|remove <id>
agent-manager host list|add <name> <ssh-target>|install <ssh-target>|remove <id>
agent-manager tailscale install|status|off
```

Unknown options fail. There is no standalone listing-script passthrough.

Configuration and SQLite state are private Agent Manager data under
`~/Library/Application Support/agent-manager/`; runtime sockets are under the uid-qualified
private temporary directory. This pre-prototype may cold-reset its own incompatible config/DB
instead of migrating it. It never resets provider settings, transcripts, credentials, tmux, or
worktrees.

## External-session hooks

Hook installation is optional and explicit:

```sh
agent-manager hooks status
agent-manager hooks install --provider claude --scope user
agent-manager hooks install --provider codex --scope user
```

The CLI shows an exact diff and asks before editing. Claude uses a token-authenticated loopback
HTTP handler. Codex uses a pinned command shim and remains `awaiting trust` until the user trusts
its exact hash in Codex `/hooks`. A newly installed Claude handler is `installed, not seen yet`
until a later session event reaches it. Project scope is available but warns that the endpoint
is machine-local.

Held external Claude decisions are limited to exact `PermissionRequest` events. If Agent Manager
times out or exits, the hook returns an empty successful response and the native Claude prompt
continues. Hook installation never grants queue, steer, interrupt, settings, or process ownership.

## Native attach and remote hosts

`attach` is the verbose escape hatch. The browser receives only an owner-socket wrapper, never a
raw provider command. Commands are a closed argv union, use pinned executables with `shell:
false`, and fail closed when ownership/controller state is ambiguous. There is no browser
terminal or tmux `send-keys` fallback.

Remote macOS hosts are explicitly installed:

```sh
agent-manager host install user@remote-mac
agent-manager host add "Remote Mac" user@remote-mac
```

The controller communicates over a BatchMode SSH bridge; the remote HTTP service remains
loopback-only. A wire-epoch mismatch refuses state/control and asks for the same explicit host
install command. Remote transcript search and editor opening are unavailable until their exact
bounded adapters exist.

Optional Tailscale Serve access proxies one private HTTPS route to the loopback service. Agent
Manager never binds directly to a LAN or tailnet address and never uses Funnel.

## Safety limits

- Treat browser-session or owner-socket access as access to the underlying agents.
- Browser mutations are cookie + CSRF + generation + idempotency protected. Short writer leases
  are automatic; only a real competing-window conflict/takeover appears in the product.
- Session creation and ambiguous dispatch are never blindly replayed.
- Elicitation forms remain visible but non-respondable until all provider shapes can be encoded
  faithfully.
- Provider-exposed reasoning means only text/summaries the provider returns. Hidden prompts,
  encrypted/redacted thinking, signatures, raw envelopes, environment values, terminal stdin,
  and internal stack traces are structurally excluded.
- Selected activity is bounded, redacted, and not persisted to SQLite/audit logs. Use the native
  provider history for older/verbose material.
- Stop, interrupt, and end are per-session provider capabilities; the cockpit never claims to
  stop unrelated provider processes.

See [SECURITY.md](./SECURITY.md) and the accepted contracts under `docs/specs/`.
