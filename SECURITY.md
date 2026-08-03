# Security model

Agent Manager is a single-user, local control plane for processes that may
already have broad filesystem and command access. Treat access to its browser
session or owner control socket as access to the underlying agents.

## Trust boundaries

- The HTTP server binds only to `127.0.0.1`. It refuses other configured bind
  addresses, unknown `Host` values, and mutation requests from unknown origins.
- A local browser starts with a short-lived, single-use secret delivered in the
  URL fragment. The fragment is exchanged for an HttpOnly, SameSite cookie and
  immediately removed from browser history. Bootstrap secrets are held only in
  memory and can be reissued only through the owner-only Unix socket.
- Browser mutations require both the session cookie and a CSRF token. Session
  controls additionally require a short, single-writer lease bound to the auth
  session, actor, browser client ID, and rotating token. The shipped UI requests
  five minutes; other tabs and browsers remain read-only until release or
  expiry. Sessions with full-host access require an explicitly armed lease.
- Tailscale access is opt-in. The server accepts only the exact configured
  device host and login identity relayed by a loopback Tailscale Serve proxy.
  The design assumes the local macOS account and its processes are trusted;
  loopback proxy headers are not a defense against a malicious process already
  running as that local user.
- The owner Unix socket and state directory are mode `0600`/`0700`. It exposes
  a closed command set for bootstrap, panic lock, and native attach lifecycle;
  it is not a shell or generic RPC bridge.

## Provider and terminal safety

- Existing Codex and Claude sessions are observation/attach targets only.
  Attach is offered only for an unambiguous tmux target. Agent Manager does not
  adopt external sessions into its semantic control plane.
- Semantic queue, steer, interrupt, mode, and request-response actions are
  available only for sessions created and owned by this manager process.
- Codex uses a fresh private App Server Unix socket and refuses to connect to or
  replace a pre-existing socket. Claude uses a pinned Agent SDK Query.
- Native commands are a closed, validated argv union and are spawned with
  `shell: false`. No browser-supplied executable, path, or shell fragment is
  accepted.
- Tmux support is read-only pane capture plus native attach. There is no
  `send-keys`, browser terminal, or arbitrary command execution endpoint.
- Claude native attach is allowed only after the managed query is idle and its
  queue is drained. The CLI reports the native child lifecycle through the
  owner socket so the manager can reclaim the session after exit.
- Managed native attach is exclusive: preparation releases any browser lease,
  the browser exposes only the guarded `agent-manager attach` wrapper, and
  semantic writes stay disabled while the native controller owns the session.
  An ambiguous child lifecycle or reclaim fails closed rather than allowing two
  concurrent controllers.

## Persistence and audit

Configuration, SQLite state, and the owner socket live in private user-owned
locations. Session creation and actions are idempotency-keyed before provider
dispatch. Interrupted or ambiguous dispatches become `unknown` and are never
replayed automatically. Audit rows store action metadata, a SHA-256 payload
digest, character count, and a fixed structural summary—not message text,
answers, denial reasons, or arbitrary provider results.

Pane previews, provider requests, messages, reasoning, tool arguments/results,
command output, and diffs can contain sensitive project data. They are allowed
only in the authenticated selected-session detail/activity routes. The global
session collection, global SSE feed and replay ring retain metadata only;
attention records there omit exact questions, options, summaries, and tool
input. Selected activity is bounded and volatile in memory and is never written
to SQLite, action audit rows, or service logs.

Before selected activity reaches the browser, secret-shaped object fields and
recognized bearer/OpenAI/GitHub/Slack/AWS/private-key forms are redacted and
unsafe terminal/bidirectional control characters are stripped. Provider HTML is
never interpreted. Hidden system/developer prompts, signatures,
encrypted/redacted thinking, raw protocol envelopes, environment values,
terminal stdin, and internal stack traces are excluded structurally rather than
depending only on token-pattern scanning.

Provider-marked secret answers use an ephemeral dispatch path. Their values are
not stored in the durable action outbox, idempotency receipts, or audit details;
if acknowledgement is lost, the outcome becomes unknown instead of replaying
the answer. Transcript paths and reader errors are not returned to the browser.
Activity/detail responses use `Cache-Control: no-store`; users should avoid
exposing the cockpit through any proxy other than the exact private Tailscale
Serve route.

## Panic lock

`agent-manager panic-lock` closes the control plane, releases leases, removes
the owner socket, and stops manager-owned provider transports. It first writes
a persistent owner-only sentinel, so startup remains blocked even if live
cleanup is incomplete. It deliberately does not kill native children or type
into unrelated existing agent or tmux sessions. After inspecting the host, the
user must run `agent-manager panic-unlock` to permit startup again.

## Operational trust limits

The Tailscale installer requires its chosen HTTPS port to be unused and scopes
removal to the owned `/` path. It rechecks the persisted device identity and
route after mutation, but the Tailscale CLI does not provide a transactional
compare-and-swap; another trusted local process editing Serve concurrently can
race that operation. Executable paths persisted into the LaunchAgent are
canonicalized and restricted to root/current-user ownership. Administrators
and root remain trusted host principals.
