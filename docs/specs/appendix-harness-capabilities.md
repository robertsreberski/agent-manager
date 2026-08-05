# Appendix — pinned harness capability survey

**Status:** Verified design input · **Observed:** 2026-08-04 · **Policy:** re-probe on pin change

This appendix records the provider facts used by specs 01–03, 06, 08, and 10. It is not a list
of ideas to expose. A schema declaration is weaker than a successful isolated live probe, and a
provider method is not a product capability until controller/security semantics are known.

## Codex 0.146

### Shared app-server

Codex exposes a shared app-server daemon and multi-client protocol surfaces including bounded
`thread/list`, `thread/read`, `thread/loaded/list`, subscription/unsubscription, turn start/steer/
interrupt, server-to-client requests, and `serverRequest/resolved`. Thread metadata includes
source kind, parent relationship, status, cwd, model/provider facts, and update time.

Important identity rule: `Thread.id` identifies one thread and is preserved as
`providerThreadId`. Protocol `sessionId` is shared by a thread tree and becomes `providerTreeId`;
`parentThreadId` provides hierarchy. The app-stable distributed key is always
`${hostId}:${provider}:${providerThreadId}` across local, remote, hook, and daemon discovery.

The host inspected for this redesign has CLI `0.146.x` but a running daemon app-server
`0.145.x`. That canonical daemon is unsupported and must remain untouched. Multi-client request
routing and mid-life environment authority were not established by the isolated gate in spec
02, so shared-daemon adoption is a NO-GO. “A second client can safely control an ordinary
terminal session” is not a product fact.

Agent Manager never connects to or manages the shared daemon lifecycle. The sole managed Codex
plane is the isolated manager-owned private app-server runtime labeled `codex-private`.

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

## Claude Code 2.1.222 and Agent SDK 0.3.220

### Manager-owned SDK query

The pinned SDK Query exposes semantic queue/turn streaming, callbacks for permission/request
handling, interrupt, `setPermissionMode`, `setModel`, `supportedModels`,
`applyFlagSettings({ effortLevel })`, and `close()`. `close()` terminates the underlying process,
pending requests, MCP transports, and CLI subprocess, so product end is restricted to a query
the manager owns. Steering remains gated by the exact SDK/CLI pins.

### Externally started session

An arbitrary interactive Claude terminal session has no local semantic queue/steer/control
socket Agent Manager can join. Registry/Agent View, process/tmux facts, and transcripts provide
discovery/observation; `--resume` would create another controller and is not adoption. Cloud
Remote Control is not a local integration path.

A disposable probe verified that a `--bg` hook `session_id` matches the registry and
`claude agents --json --all` session ID. That ID correlates hook events to discovery.

### Hooks

Claude supports loopback HTTP hooks and reloads a newly added local-settings handler for later
events in an already-running `2.1.222` session. The settings edit itself emits no event, so an
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
| Can it be controlled through the shared daemon? | No. Spec 02 records the NO-GO; ordinary CLI sessions remain hook/observe-only. |
| Can an ordinary Claude session be seen? | Yes through HTTP hooks plus bounded discovery/transcript fallback. |
| Can external Claude be queued or steered? | No. Attach to the native interface. |
| Can external Claude permissions be answered? | Only a live exact `PermissionRequest` held by the bridge. |
| Can settings be changed? | Claude SDK methods where live; Codex next-turn overrides while idle. |
| Does the cockpit own provider history? | No. It keeps one bounded volatile activity window and states the retention boundary. |
