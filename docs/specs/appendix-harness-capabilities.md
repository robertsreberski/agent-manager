# Appendix — pinned harness capability survey

**Status:** Verified design input · **Observed:** 2026-08-04 · **Policy:** re-probe on pin change

This appendix records the provider facts used by specs 01–03, 06, 08, and 10. It is not a list
of ideas to expose. A schema declaration is weaker than a successful isolated live probe, and a
provider method is not a product capability until controller/security semantics are known.

## Codex 0.146

### Multi-client app-server

The pinned Codex app-server exposes multi-client protocol surfaces including bounded
`thread/list`, `thread/read`, `thread/loaded/list`, subscription/unsubscription, turn start/steer/
interrupt, server-to-client requests, and `serverRequest/resolved`. Thread metadata includes
source kind, parent relationship, status, cwd, model/provider facts, and update time.

Important identity rule: `Thread.id` identifies one thread and is preserved as
`providerThreadId`. Protocol `sessionId` is shared by a thread tree and becomes `providerTreeId`;
`parentThreadId` provides hierarchy. The app-stable distributed key is always
`${hostId}:${provider}:${providerThreadId}` across local, remote, hook, and daemon discovery.

The pinned app-server supports more than one client on a thread. Agent Manager therefore treats
its own `codex-private` server as a shared provider connection: its backend and native
`codex resume <thread> --remote unix://<socket>` peers may remain active together. Execution
environment notifications report peer presence; they do not identify a controlling writer and
must not be used to revoke healthy thread capabilities.

Server requests carry exact identities and publish `serverRequest/resolved`. That notification
is the authoritative first-response-wins reconciliation surface when a cockpit client and a
native peer see the same question or approval. A losing response becomes stale; it is not
retried, converted, or shown as a second request.

This result does not approve the user-global experimental daemon. The host inspected for this
redesign has CLI `0.146.x` but a running global daemon app-server `0.145.x`. That endpoint is
unsupported by the pinned integration and remains untouched. Agent Manager never connects to,
trusts, upgrades, restarts, stops, repairs, mutates, or silently adopts it. The sole managed
Codex plane remains the isolated manager-owned app-server labeled `codex-private`; multi-client
support applies inside that trust boundary.

A CLI already running on a different connection cannot be rebound in place. Exact
process/provider/workspace identity plus one guided exit or separately confirmed single-SIGTERM
stop is required before Agent Manager resumes that same thread on its private server. After that
one-time migration, CLI and cockpit clients join as ordinary peers rather than transferring
exclusive ownership back and forth.

### Settings and lifecycle

- The standard schema omits `thread/settings/update`, but the pinned `0.146` experimental schema
  exposes it when experimental API is enabled. A live probe reached the method and returned
  `thread-not-found`, not method-not-found, proving dispatch. Product use remains idle-only.
- `thread/settings/updated` is the effective-state notification. `-32601` withdraws experimental
  live update, after which `turn/start` carries model, effort, approval, sandbox, and
  collaboration overrides for the next turn.
- Current RPCs include thread name, archive/unarchive/delete and model/profile/account lists, but
  every one remains live-capability/version gated.
- There is no `thread/close`. Product “end” is interrupt active work, clear manager queue,
  unsubscribe/detach, and retain the resumable thread.
- `item/fileChange/outputDelta` is deprecated/not emitted. Current file changes arrive as full
  changing upserts and/or a final aggregate turn diff.
- `thread/inject_items` is not a user steering channel and is never used as one.

### Hooks

Codex 0.146 currently runs trusted **command** handlers. It does not offer the Claude-style HTTP
hook transport. `prompt` and `agent` handler shapes may parse but are skipped. Non-managed hooks
must be trusted through `/hooks`, and changing the hook hash requires renewed trust.

The input is Codex-specific (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
turn ID, and event/tool fields). `PreToolUse` supports allow/deny, not `ask`.
`PermissionRequest` supports allow/deny/no decision. A command shim may post its stdin payload to
Agent Manager loopback, but the Claude parser/response schema must not be reused.

## Claude Code 2.1.223 and Agent SDK 0.3.220

### Manager-owned SDK query

The pinned SDK Query exposes semantic queue/turn streaming, callbacks for permission/request
handling, interrupt, `setPermissionMode`, `setModel`, `supportedModels`,
`applyFlagSettings({ effortLevel })`, and `close()`. `close()` terminates the underlying process,
pending requests, MCP transports, and CLI subprocess, so product end is restricted to a query
the manager owns. Steering remains gated by the exact SDK/CLI pins.

### Externally started session

An arbitrary interactive Claude terminal session has no local semantic queue/steer/control
socket Agent Manager can join. Registry/Agent View, process/tmux facts, and transcripts provide
discovery/observation. Cloud Remote Control is not a local integration path.

Claude takeover is exclusive: the original controller must exit first, the exact
session/workspace identity must be revalidated, and only a successful SDK resume may enable
manager writes. A native attach later is another handoff, not a concurrent peer join.

**This is a product decision, not a provider constraint.** A disposable probe against
`@anthropic-ai/claude-agent-sdk` 0.3.220 and `claude` 2.1.223 measured what a second
controller actually does, because the rule had only ever been asserted in the conditional:

- A second `query({ resume })` against a session a live query already holds **succeeds**. It
  is not refused, and neither client errors.
- An SDK query registers in `~/.claude/sessions/<pid>.json` as `kind: "interactive"` — the
  same kind a terminal session registers. The CLI's own resume guard refuses only sessions
  whose `kind` is *not* `interactive` (background agents, which have a supported `claude
  agents` attach), so the provider deliberately permits this.
- The transcript is not corrupted. Sequential turns from two clients produced one linear
  chain — the second client's user message correctly parented onto the first client's
  assistant reply — with no duplicate or dangling `uuid`s.
- Two *simultaneous* in-flight turns also produced a well-formed transcript, and each client
  received its own correct reply. They **fork**: both user messages parent onto the same
  node, yielding the two-branch DAG `--fork-session` already produces.

So exclusivity is not required to protect the transcript. What it buys is a single linear
conversation. Making Claude `shared / join` like Codex would not risk corruption, but Codex's
app server *serializes* concurrent turns onto one thread while Claude branches them, so a
shared Claude session would need turn serialization in the manager — or would have to present
forks as a first-class outcome. Neither is in scope here; the point of recording this is that
the constraint is ours to revisit rather than the provider's to enforce.

There is also a per-session cross-session messaging socket (`messagingSocketPath` in the
registry, with `sendToUdsSocket` / `listLivePeerSessions` in the CLI) that would allow writing
into a live session with no second controller at all. It is feature-gated: live interactive
sessions on this machine advertise `peerProtocol: 1` but carry no `messagingSocketPath`.
Whether it can be enabled for interactive sessions is unprobed.

A disposable probe verified that a `--bg` hook `session_id` matches the registry and
`claude agents --json --all` session ID. That ID correlates hook events to discovery.

### Hooks

Claude supports loopback HTTP hooks and reloads a newly added local-settings handler for later
events in an already-running `2.1.223` session. The settings edit itself emits no event, so an
installation is installed-unseen until the next provider event.

Hook payloads include session/transcript/cwd/event/permission facts plus event-specific prompt,
tool, agent, task, or lifecycle data. Useful observation events include session/turn lifecycle,
prompts/messages, tools, permissions, subagents, tasks/todos, and compaction.

For external interactive control:

- `PermissionRequest` is the faithful held decision surface and returns Claude's allow/deny
  shape.
- The hook lacks a unique tool-use ID, so Agent Manager allocates its own UUID per held POST.
- `PreToolUse` defer works in print mode but is ignored in interactive/batch contexts; it is not
  exposed as an answerable external-session request.
- Elicitation stays visible and non-respondable until the UI can encode all forms/URLs exactly.
- `Stop`/`additionalContext` is a system-side continuation, not an operator message.
- Timeout, shutdown, or error returns empty HTTP 2xx so the native interface continues. Held
  state is memory-only and never replayed.

### Plans

Observed Claude `ExitPlanMode` input contains plan markdown and may contain `planFilePath`. The
path is used only when supplied and then read through the hardened, session-scoped file reader.
Claude does not inherently expose preserved revision history; render one current document unless
the provider supplies distinct versions. Codex structured plan updates remain todos, not a plan
file.

## Product conclusions

| Question | Contract |
| --- | --- |
| Can an ordinary Codex CLI session be seen? | Yes through a trusted command hook, otherwise bounded heuristic discovery. |
| Can Codex CLI and web control the same conversation? | Yes after the thread is on Agent Manager's pinned private app-server. Native CLI joins it with the exact `--remote` command; first exact response wins. |
| Can a standalone Codex process be adopted in place? | No. It exits once through the identity-checked guided or confirmed graceful migration, then the exact thread resumes on the private server. |
| Does Agent Manager use the user-global experimental daemon? | No. The observed version-mismatched daemon and socket are never silently trusted or mutated. |
| Can an ordinary Claude session be seen? | Yes through HTTP hooks plus bounded discovery/transcript fallback. |
| Can external Claude be queued or steered? | Only after an exclusive, identity-checked takeover succeeds; native and manager controllers never write concurrently. |
| Can external Claude permissions be answered? | Only a live exact `PermissionRequest` held by the bridge. |
| Can settings be changed? | Claude SDK methods where live; Codex next-turn overrides while idle. |
| Does the cockpit own provider history? | No. It keeps one bounded volatile activity window and states the retention boundary. |

Wire schema 5 makes the provider split explicit: managed Codex reports
`shared / join / first-response-wins`, managed Claude reports
`exclusive / handoff / single-controller`, and observation-only sessions report no native
coordination. Bounded `reconnecting`, `waiting-for-native-exit`, `retrying`, and
`needs-attention` states expose truthful ownership/timing/error facts. Native Claude ownership is
a stable healthy wait without retry churn. `retry-control` appears only when a new safe attempt
exists, and no recovery path replays a provider mutation.
