# Appendix — pinned harness capability survey

**Status:** Verified design input · **Observed:** 2026-08-06 · **Policy:** re-probe on pin change

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

**Why migration cannot be replaced by joining, measured rather than asserted.** The sentence
above was for a long time the whole justification, and it answers a narrower question than it
appears to: a *running process* cannot have its socket rewired, which is trivially true and says
nothing about whether Agent Manager's own app-server could `thread/resume` that thread
concurrently. Claude's equivalent claim turned out to be false when probed, so this one was
examined too — at the level of the record format, which is decisive without having to damage a
real conversation:

- A rollout record is exactly `{timestamp, type, payload}`. There are **no parent pointers** —
  nothing corresponding to Claude's `uuid`/`parentUuid`, so no intra-file DAG exists.
- Turn identity is nearly absent. In a real 221-line rollout, **3 of 68** sampled records carry
  `turn_id`: `event_msg/task_started`, `event_msg/task_complete`, and `turn_context`. Every
  content record — `response_item/message`, `reasoning`, `function_call`,
  `function_call_output`, `event_msg/agent_message`, `event_msg/user_message` — carries no turn
  or parent identity at all. Content belongs to a turn only by **position between** the two
  markers.
- Two concurrent writers interleave those markers, so attribution becomes unrecoverable. This
  breaks Codex's own next resume, which replays the rollout to rebuild context — not merely the
  cockpit's projection of it.
- Confirming the design intent: `session_meta` carries `forked_from_id` and `parent_thread_id`.
  Codex represents divergence by writing a **whole new rollout file**. Its fork primitive is
  file-level; intra-file branching is not representable.

So the asymmetry with Claude is a data-model fact, not a preference. Claude can absorb two
writers because a fork is a legible DAG; Codex cannot, so a standalone Codex process keeps its
one-time migration. This records the format argument only — it does not test whether the
app-server would *permit* the concurrent resume, because a format that cannot represent the
result is already sufficient reason not to build it.

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

An arbitrary interactive Claude terminal session exposes no local control socket to connect to —
there is nothing to dial, and Cloud Remote Control is not a local integration path. Writing to it
therefore means becoming a *second controller* rather than a client of the first: Agent Manager
opens its own SDK query on the same session. Registry/Agent View, process/tmux facts, and
transcripts provide discovery and observation of the other controller's side.

**Claude is joined, not taken over.** Agent Manager opens its own SDK query beside whatever is
already writing the conversation. The exact session/workspace identity is still revalidated
before that query is published — what was removed is the requirement that the *other* controller
exit first. A native attach later is another peer, not a handoff.

This was previously exclusive, and the probe below is why it no longer is. A disposable probe
against
`@anthropic-ai/claude-agent-sdk` 0.3.220 and `claude` 2.1.223 measured what a second
controller actually does, because the rule had only ever been asserted in the conditional:

- A second `query({ resume })` against a session a live query already holds **succeeds**. It
  is not refused, and neither client errors.
- An SDK query registers in `~/.claude/sessions/<pid>.json` as `kind: "interactive"` — the
  same kind a terminal session registers. The CLI's own resume guard refuses only sessions
  whose `kind` is *not* `interactive` (background agents, which have a supported `claude
  agents` attach), so the provider deliberately permits this.
- A joined query receives **only its own turns**; the SDK's multi-client fan-out is scoped to
  remote/daemon worker sessions and there is no `socketPath`/`connectTo` option for attaching to
  a locally spawned CLI. The native side of a shared conversation therefore reaches the cockpit
  only through the HTTP hook bridge, or through the transcript poller — which shows one branch.
- `initializationResult()` returns `SDKControlInitializeResponse`, which carries commands,
  agents, output styles, models, account and fast-mode facts — but **no session id**. An exact
  resume cannot be confirmed from that payload; `#connect`'s `system/init` check on the next turn
  remains the identity proof.
- The transcript is not corrupted. Sequential turns from two clients produced one linear
  chain — the second client's user message correctly parented onto the first client's
  assistant reply — with no duplicate or dangling `uuid`s.
- Two *simultaneous* in-flight turns also produced a well-formed transcript, and each client
  received its own correct reply. They **fork**: both user messages parent onto the same
  node, yielding the two-branch DAG `--fork-session` already produces.

So exclusivity was never required to protect the transcript. What it bought was a single linear
conversation, at the price of making the operator kill their own terminal session before the
cockpit would answer. **What was built is the second option this paragraph used to defer:** forks
are a first-class, named outcome. `TranscriptAvailability.forked` reports when any parent on the
rendered chain has more than one identity-matching child, and the activity projector emits one
`transcript:fork` lifecycle warning saying that two surfaces answered the same message and that
the branch shown is the most recently written one. Turn serialization in the manager was not
built, and is not possible in general — the manager cannot observe the peer mid-turn, so it can
neither prevent a fork nor warn before one.

Note what this fixed incidentally: a fork was *already* possible through `--fork-session`, and the
reader has always walked exactly one root-to-latest path. Before this change a forked
conversation silently flipped between branches as each appended, tripping an unexplained
`branch-change` reset. The behaviour is not new; only saying so is.

The per-session cross-session messaging socket (`messagingSocketPath` in the registry, with
`sendToUdsSocket` / `listLivePeerSessions` in the CLI) would have allowed writing into a live
session with no second controller and no possibility of a fork — strictly better than joining. It
**cannot be enabled**, and it is not feature-gated but unimplemented in `2.1.223`:

- The registry writer emits `{pid, sessionId, cwd, startedAt, procStart, version, peerProtocol,
  kind, entrypoint, name, logPath, agent, jobId}` and no `messagingSocketPath` field at all. It
  carries two vestigial `...void 0, ...{}` spreads where optional fields were compiled out.
- The init-context builder declares the value and never assigns it (`let r;` … returning
  `messagingSocketPath: r`), so it is unconditionally `undefined`.
- Only the *reader* references the field. No configuration or environment can turn the writer on.

Re-probe both on any pin change: if the socket lands, it obsoletes shared join entirely.

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
| Can a standalone Codex process be adopted in place? | No, and this is a format fact: a rollout has no parent pointers and no per-record turn identity, so two writers interleave unrecoverably. It exits once through the identity-checked guided or confirmed graceful migration, then the exact thread resumes on the private server. |
| Does Agent Manager use the user-global experimental daemon? | No. The observed version-mismatched daemon and socket are never silently trusted or mutated. |
| Can an ordinary Claude session be seen? | Yes through HTTP hooks plus bounded discovery/transcript fallback. |
| Can external Claude be queued or steered? | Yes, by joining: an identity-checked second SDK query opens beside the running controller, which is never asked to exit. Both may write; simultaneous turns fork, and the fork is published rather than prevented. |
| Can a standalone Claude process be adopted in place? | Yes — that is what joining is. A live process is a peer, not an obstacle. |
| Can external Claude permissions be answered? | Only a live exact `PermissionRequest` held by the bridge. |
| Can settings be changed? | Claude SDK methods where live; Codex next-turn overrides while idle. |
| Does the cockpit own provider history? | No. It keeps one bounded volatile activity window and states the retention boundary. |

Wire schema 8 makes the provider split explicit, and the split is now narrower than it was: both
providers report `shared / join`, and they differ only in how a request is resolved. Managed Codex
reports `shared / join / first-response-wins`, because `serverRequest/resolved` genuinely lets two
peers race one request. Managed Claude reports `shared / join / single-controller`, because it
publishes no such event — each controller holds its own query and answers only its own requests,
so there is nothing to arbitrate. `single-controller` describes a request having one answerer, not
a session having one writer. Observation-only sessions report no native coordination.

`control.peers` publishes the live writers a build can prove, as observational fact only:
authorization keeps reading `capabilities`, exactly as Codex execution-environment IDs are peer
presence rather than ownership tokens.

Bounded `reconnecting`, `retrying`, and `needs-attention` expose truthful timing/error facts.
`waiting-for-native-exit` is gone with exclusivity — nothing waits for a native controller to
leave, so there is no healthy indefinite wait to represent. `retry-control` appears only when a new
safe attempt exists, and no recovery path replays a provider mutation.
