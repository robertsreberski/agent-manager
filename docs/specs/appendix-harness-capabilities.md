# Appendix — harness capability survey

Surveyed 2026-08-04 against the versions installed on the development machine. Specs 01–03
rest on this; if it goes stale, they go wrong. **Re-run this survey before starting Part A.**

| Component | Version surveyed | Pinned in repo |
| --- | --- | --- |
| Claude Code | `2.1.221` | `2.1.220` (`src/providers/claude/types.ts:9`) |
| `@anthropic-ai/claude-agent-sdk` | — | `0.3.220` (`src/providers/claude/types.ts:8`) |
| Codex CLI | `0.146.0` | `0.146.x` (`src/providers/codex/adapter.ts:44`) |

Claude Code is one patch ahead of the pin. `canSteer` requires both pins to match exactly
(`src/providers/claude/managed-session.ts:593-595`), so this drift already disables steering
today. Worth confirming as part of the survey refresh.

---

## 1. Codex — the shared app-server daemon

### 1.1 It exists and it is already running here

```
~/.codex/app-server-control/app-server-control.sock   srw-------  (unix socket, 0600)
~/.codex/app-server-control/app-server-startup.lock
~/.codex/app-server-control/app-server.log
```

CLI surface:

| Command | Purpose |
| --- | --- |
| `codex app-server daemon start \| restart \| stop` | Lifecycle of the shared daemon |
| `codex app-server daemon bootstrap` | "Install durable local app-server management for SSH-driven use" |
| `codex app-server daemon enable-remote-control \| disable-remote-control` | Toggles remote control **on a currently running daemon** |
| `codex app-server daemon version` | Local CLI and running app-server versions as JSON |
| `codex app-server proxy --sock <PATH>` | Proxy stdio bytes to the running control socket |
| `codex app-server --listen <URL>` | `stdio://`, `unix://`, `unix://PATH`, `ws://IP:PORT`, `off` |
| `codex --remote <ADDR>` | Point the **TUI** at a remote app server (`ws://`, `wss://`, `unix://`) |
| `codex --remote-auth-token-env <ENV_VAR>` | Bearer token for a remote app-server websocket |
| `codex remote-control start \| stop \| pair` | Daemon with remote control; `pair` prints a short-lived pairing code |

The significance: a user running `codex --remote unix://…` gets a normal TUI whose thread lives
**in the daemon, not in the terminal process**. Agent Manager can be a second client of that
same daemon and speak the protocol `src/providers/codex/adapter.ts` already implements.

### 1.2 The protocol is built for multiple clients

Generated with `codex app-server generate-json-schema --out <dir>`; the v2 bundle is vendored at
`docs/design/codex-app-server-protocol.v2.schemas.json`. Counts: **90 client requests, 10 server
requests, 70 server notifications**.

Three primitives make multi-client adoption a designed-for case rather than a hack:

- **`thread/list`** (client request) — a paginated, filterable index of threads: `cwd` filter,
  `archived`, `isPinned`, `sourceKinds`, opaque cursor, `backwardsCursor`. Response items are
  `Thread` records carrying `id`, `sessionId`, `cwd`, `status`, `turns`, `preview`, `createdAt`,
  `updatedAt`, `cliVersion`, `ephemeral`, `modelProvider`, plus `agentRole` / `agentNickname`
  for spawned sub-agents.
- **`thread/unsubscribe`** (client request) — subscription is per-client and explicitly
  revocable. A protocol with unsubscribe has subscribe, and subscribe-per-client means
  multi-client.
- **`serverRequest/resolved`** (server notification) — the server tells clients that a
  server→client request was resolved. This is the arbitration primitive for two clients racing
  the same approval. `src/providers/codex/activity-projector.ts` **already handles it**.

`ThreadSourceKind` is the "started elsewhere" discriminator:

```
cli | vscode | exec | appServer | subAgent | subAgentReview
   | subAgentCompact | subAgentThreadSpawn | subAgentOther | unknown
```

A thread with `source: "cli"` is one someone started in a terminal. That is exactly the
population this project has never been able to control.

### 1.3 Server→client requests (the 10 that need a controller)

```
item/commandExecution/requestApproval   item/fileChange/requestApproval
item/tool/requestUserInput              item/permissions/requestApproval
mcpServer/elicitation/request           item/tool/call
account/chatgptAuthTokens/refresh       attestation/generate
applyPatchApproval (legacy)             execCommandApproval (legacy)
```

`src/providers/codex/adapter.ts:164-175` already maps six of these. **Unresolved and load-bearing:
which client receives these when two are subscribed.** See spec 02 §Prerequisite.

### 1.4 Protocol surface the cockpit does not use yet

Directly relevant to the redesign, and currently unexploited:

| Method | Redesign use |
| --- | --- |
| `model/list` | Composer's model picker — a real source instead of a hardcoded list |
| `permissionProfile/list` | Composer's access control |
| `thread/archive` / `unarchive` / `delete` | Multi-select bar (design `12a`) — native, no invention needed |
| `thread/name/set` / `thread/name/updated` | Session rename |
| `account/usage/read`, `account/rateLimits/read` | Session panel cost facts (design `9b`) |
| `thread/fork`, `thread/rollback`, `thread/compact/start` | Not in the redesign; noted so they are not reinvented |
| `hooks/list`, `skills/list`, `plugin/list` | Session panel "what it may do" |
| `thread/inject_items` | **Do not use as a steering channel** — see spec 01 §Honesty rules |

Two server notifications the projector does **not** currently handle, both of which are real
harness activity the cockpit is dropping today:

- `item/autoApprovalReview/started` / `item/autoApprovalReview/completed`
- `item/fileChange/outputDelta`

### 1.5 Codex hooks

`~/.codex/hooks.json` exists and is already in use on this machine by an unrelated tool
(`~/.orca/agent-hooks/codex-hook.sh`), which proves the pattern. Events observed in that file:
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`SubagentStart`, `SubagentStop`, `Stop`. Shape mirrors Claude Code's: `{type, command, timeout}`
under a `hooks` map.

---

## 2. Claude Code — hooks are the whole lever

### 2.1 There is no local control channel for an arbitrary session

Checked and confirmed negative:

- `find ~/.claude -type s` returns **nothing**. No session listens on a socket.
- `lsof` on a live interactive session shows only *outbound* unix connections.
- `~/.claude/daemon/roster.json` lists **daemon-spawned workers only**, each with
  `rendezvousSock` and `ptySock` under `/tmp/cc-daemon-<uid>/…`. Interactive sessions are absent.
- `~/.claude/ide/` is empty; IDE integration makes Claude Code an MCP *client* of the editor,
  which grants no control over the session.
- **Remote Control is cloud-routed.** `claude --remote-control` / `claude remote-control` register
  with the Anthropic API and poll for work over outbound HTTPS; the docs are explicit that it
  "never opens inbound ports on your machine". claude.ai and the mobile app are the clients.
  There is no local endpoint for Agent Manager to attach to. It is also unavailable on
  Bedrock/Vertex/Foundry, with a custom `ANTHROPIC_BASE_URL`, or with an API-key login.

Conclusion: **Claude external sessions cannot be queued or steered.** Any design that implies
otherwise is describing something that does not exist.

### 2.2 What discovery gives

`~/.claude/sessions/<pid>.json`, already read by `agent-sessions.ts:828-893`:

```json
{"pid":38396,"sessionId":"…","cwd":"…","startedAt":…,"procStart":"…",
 "version":"2.1.221","peerProtocol":1,"kind":"interactive","entrypoint":"cli",
 "name":"agent-manager-6f","nameSource":"derived","status":"busy","updatedAt":…}
```

`kind` distinguishes `interactive` from background. `claude agents --json [--all]` lists active
sessions (interactive **and** background) without requiring a TTY.

### 2.3 Hooks — the full picture

**Events.** Far beyond what the repo assumes:

- *Session*: `SessionStart`, `Setup`, `SessionEnd`
- *Turn*: `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`
- *Tool loop*: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`,
  **`PermissionRequest`**, `PermissionDenied`
- *Agents*: `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`
- *Files/config*: `FileChanged`, `CwdChanged`, `DirectoryAdded`, `ConfigChange`, `InstructionsLoaded`
- *Context/display*: `PreCompact`, `PostCompact`, **`MessageDisplay`**, `Notification`
- *MCP*: **`Elicitation`**, `ElicitationResult`
- *Worktree*: `WorktreeCreate`, `WorktreeRemove`

**Input** (stdin for command hooks, POST body for HTTP hooks) carries `session_id`, `prompt_id`,
`transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `effort.level`, and inside a
subagent, `agent_id` + `agent_type`.

**Decision output** — the part that makes remote answering possible:

| Event | Field | Values |
| --- | --- | --- |
| `PreToolUse` | `hookSpecificOutput.permissionDecision` | `allow` \| `deny` \| `ask` \| `defer` |
| `PermissionRequest` | `hookSpecificOutput.decision.behavior` | `allow` \| `deny` (+ `updatedInput`) |
| `Elicitation` | `hookSpecificOutput.action` | `accept` \| `decline` \| `cancel` (+ `content`) |
| `PostToolUse` | `decision: "block"` | + `reason`, `updatedToolOutput` |
| `UserPromptSubmit` | `decision: "block"` | + `reason`, `additionalContext` |
| `Stop`, `SubagentStop` | `decision: "block"` | + `reason`, `additionalContext` |
| `MessageDisplay` | `hookSpecificOutput.displayContent` | display-only, not in transcript |

Universal fields: `continue`, `stopReason`, `suppressOutput`, `systemMessage`, `terminalSequence`.

**Transport.** Hook `type` may be `command`, **`http`**, `mcp_tool`, `prompt`, or `agent`.
HTTP hooks receive the same payload as a POST body — a loopback daemon is a first-class target.

**Timing.** Synchronous by default. Default timeout **600s** for `command`/`http`/`mcp_tool`
(exceptions: `UserPromptSubmit` 30s, `MessageDisplay` 10s, `SessionEnd` 1.5s budget).
`"async": true` / `"asyncRewake": true` opt out.

**Configuration and live reload.** Hooks are defined in `~/.claude/settings.json`,
`.claude/settings.json`, `.claude/settings.local.json`, managed policy settings, plugin
`hooks/hooks.json`, or skill/agent frontmatter. Hooks from all sources are **merged, not
replaced**. Critically:

> Direct edits to `.claude/settings.json` and `~/.claude/settings.json` are picked up
> automatically via file watcher. **No session restart required.**

That single line is why the hook bridge works on sessions that are *already running*.

`disableAllHooks: true` disables user-level hooks; only admin-level `disableAllHooks` disables
managed ones. `--bare` and `--safe-mode` skip hooks entirely.

---

## 3. What this changes

| Question | Before | After this survey |
| --- | --- | --- |
| Can Agent Manager control a Codex session started in a terminal? | No — control was bound to the private socket it spawned | **Yes, if the daemon is in use.** `thread/list` finds it, the existing adapter drives it. Approval routing needs the spec 02 spike. |
| Can Agent Manager see faithfully into an external Claude session? | Only polled transcript text, `inferred` confidence, `message` items only | **Yes.** Hooks give exact, provider-exposed events across the tool loop, subagents, tasks, compaction and display. |
| Can Agent Manager answer a permission prompt it did not originate? | No | **Yes, both harnesses**, by holding a synchronous hook open while the operator decides. |
| Can Agent Manager send a message to an external Claude session? | No | **Still no.** No local channel exists. Do not fake one. |
| Does adopting a session risk two controllers? | Avoided by never adopting | **Real and must be arbitrated.** `serverRequest/resolved` and the existing native-handoff state machine are the tools. |
