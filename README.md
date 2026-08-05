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
| External Claude CLI | Exact installed HTTP-hook events plus bounded transcript fallback | Live held `PermissionRequest` before takeover; exact SDK control only after an exclusive identity-checked handoff |
| Managed Codex | Exact pinned private app-server stream (`codex-private`) | Shared provider methods; cockpit and native `--remote` CLI peers may use one conversation, with first exact response winning |
| Standalone Codex CLI | Trusted command-hook events plus bounded discovery fallback | Read-only until one safe exit/adoption onto `codex-private`; then web and CLI may remain active together |
| tmux/resume/observe-only | Bounded evidence with source/confidence | Native preview/attach/resume only when exact; otherwise read-only |

The live capability list is authoritative. Provider/version or transport failure withdraws the
affected actions and explains why. Codex execution-environment IDs are peer-presence facts, not
writer locks; a healthy manager-owned Codex thread stays writable when another native peer
joins. Claude remains exclusive and withholds manager writes until handoff succeeds. Agent
Manager never fakes a user turn through hook side channels, terminal keystrokes, or
`thread/inject_items`.

Agent Manager launches and owns its pinned private Codex app-server. It does not silently
connect to, trust, upgrade, restart, stop, or mutate the user-global experimental daemon; the
observed host daemon is version-mismatched with the pinned CLI. A standalone Codex process must
exit once before its exact thread is resumed on the private server. After that adoption, a native
CLI joins with `codex resume <thread> --remote unix://<agent-manager-socket>` and can be used
alongside the web cockpit.

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

Running `agent-manager` with no arguments opens the cockpit. Session creation, takeover,
recovery, exact-session resume, messaging, approvals, and archives are all operated in the web
app; they do not require copying or running a command. The explicit commands below are setup,
diagnostic, or advanced native-access tools; ordinary cockpit operation does not depend on them:

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

Hook installation is optional and explicit. Open **Setup and integrations** in
the cockpit, review the redacted exact-file preview, and choose **Install** or
**Update**. Agent Manager applies that one preview under the authenticated
browser session; stale previews are rejected and refreshed before anything is
written.

The equivalent commands are retained only for diagnostics and advanced setup:

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
Codex hooks likewise grant observation, not shared-server membership; takeover is the separate
identity-checked migration boundary.

## Advanced native attach and remote hosts

Normal continuation uses **Resume here** in the web app. It first proves that no standalone
provider owner can race the resume, reopens the exact provider identity and workspace, persists
manager ownership, and only then publishes write capabilities. A failure rolls the provisional
provider client back while leaving history and the prior read-only session intact.

`attach` is an advanced escape hatch, collapsed under **Advanced · CLI access** in the web app.
The browser receives only an owner-socket wrapper, never a
raw provider command. Commands are a closed argv union, use pinned executables with
`shell: false`, and preserve provider-specific coordination: Codex joins the manager-owned
private server, while Claude performs an exclusive handoff. Codex environment IDs are not
treated as controller ambiguity. There is no browser terminal or tmux `send-keys` fallback.

For a CLI that began outside Agent Manager, guided takeover waits for the operator to exit and is
cancellable. The graceful path first pins the exact process and returns a server-issued takeover
ID; only a second action carrying that ID may signal. It then revalidates uid, executable, PID start
identity, provider identity, transcript/registry association, and workspace before sending
exactly one `SIGTERM`; it never uses `SIGKILL`, repeated signals, shell commands, or terminal key
injection. Write capabilities appear only after exact provider adoption succeeds. Recovery is
bounded, never replays mutations, reports an exact native Claude owner as healthy rather than
failed, and exposes a manual retry only when it is safe.

Remote hosts are registered and removed in **Setup and integrations**. The web
form accepts a label and SSH target, refreshes host/workspace state immediately,
and forgets the host without touching files or processes on the remote machine.

Installing the Agent Manager service on a new remote Mac is a separate,
explicit advanced operation because it crosses the remote machine's trust and
authentication boundary:

```sh
agent-manager host install user@remote-mac
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
  are automatic between cockpit windows. They do not turn a native Codex peer into a foreign
  controller; provider request races use first-response-wins reconciliation.
- Claude takeover is exclusive. Codex takeover is only the one-time migration of a standalone
  process; after adoption, native CLI and web are supported concurrent peers.
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
