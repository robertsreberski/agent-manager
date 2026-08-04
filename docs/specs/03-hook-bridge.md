# 03 — Hook bridge

**Status:** Draft · **Depends on:** 01 · **Design frames:** feeds `6a`, `8a`, `9b`

## Purpose

Give externally-started sessions — both harnesses — a faithful live event stream, and let the
operator answer the decisions those sessions are blocked on, without the manager having started
them.

This is the whole of what is possible for external Claude sessions, and a useful complement to
spec 02 for Codex.

## Background

From `appendix-harness-capabilities.md` §2.3 and §1.5:

- Both harnesses support hooks. Claude's set is large: `PreToolUse`, `PostToolUse`,
  `PermissionRequest`, `Elicitation`, `MessageDisplay`, `SubagentStart/Stop`,
  `TaskCreated/TaskCompleted`, `Stop`, `Notification`, `PreCompact`/`PostCompact`,
  `SessionStart`/`SessionEnd`, and more.
- Hooks may be `type: "http"`. The payload arrives as a POST body.
- Hooks are **synchronous by default**, with a 600s default timeout for `command`/`http`.
- `PreToolUse` returns `permissionDecision: allow | deny | ask | defer`;
  `PermissionRequest` returns `decision.behavior: allow | deny` with optional `updatedInput`;
  `Elicitation` returns `action: accept | decline | cancel`.
- Every payload carries `session_id`, `transcript_path`, `cwd`, `permission_mode`,
  `hook_event_name`, and inside a subagent, `agent_id` + `agent_type`.
- **Claude reloads `settings.json` hook config live via file watcher — no session restart.**
  This is the reason the bridge reaches sessions that are already running.
- Hooks from user, project, local and managed sources are **merged, not replaced**, so
  installing ours does not disturb anyone else's.

The repo already *consumes* hook events, but only from its own SDK query: `includeHookEvents:
true` (`src/providers/claude/managed-session.ts:500`), projected to `lifecycle` items with
`event: "hook"` (`src/providers/claude/activity-projector.ts:1265-1290`). There is **no hook
installation code anywhere** — nothing writes `~/.claude/settings.json`, and no hook script ships.

## Requirements

### R1 — Transport: loopback HTTP

New route on the existing server: `POST /api/v1/hooks/:token`.

- `type: "http"` hooks pointing at `http://127.0.0.1:<port>/api/v1/hooks/<token>`.
- The token is per-install, high-entropy, stored with the install record, and rotatable. It
  authenticates the hook, which cannot present the browser's cookie.
- The route is exempt from cookie auth and CSRF (a hook is not a browser) but **not** from the
  Host allowlist, and it binds loopback-only like the rest of the server
  (`src/server/server.ts:442-480`). It must reject any request whose token is unknown, with no
  timing signal about which tokens exist.
- The route is exempt from the panic lock's `423 CONTROL_PLANE_LOCKED` **for reads**, but a
  locked control plane must still refuse to *answer* a decision — a panic lock that stopped
  reporting events would hide the very thing it was pulled for. Locked ⇒ observe and
  auto-defer to the harness.
- A `type: "command"` shim (a tiny script that POSTs stdin to the same route) is the fallback
  for hosts where HTTP hooks are unavailable. Same token, same route.

### R2 — Installation is explicit, marked, and reversible

Agent Manager writes a **marked block** into `~/.claude/settings.json` and `~/.codex/hooks.json`
(or project-scoped equivalents, operator's choice).

- Show the exact diff and require confirmation before writing. Never write silently.
- Delimit the managed region so uninstall is exact and hand edits outside it survive. Preserve
  the rest of the file byte-for-byte — these are the user's settings, containing unrelated
  configuration.
- Back up before first write.
- **Never touch managed-policy settings.** They are an administrator's, and
  `disableAllHooks` at that level is not ours to work around.
- `install` / `uninstall` / `status` are CLI commands, surfaced in `doctor`
  (`src/ops/doctor.ts`): is the block present, is it current, does the token still match.
- Re-install on token rotation or schema change must be idempotent.

### R3 — Event ingestion maps onto the existing activity model

Hook payloads become `ActivityMutation`s (`src/activity/types.ts:303-318`) through a new
projector under `src/providers/hooks/`. Do not invent a parallel item model.

| Hook event | Activity item |
| --- | --- |
| `SessionStart` / `SessionEnd` | `lifecycle` (`status`) |
| `UserPromptSubmit` | `message` (`role: user`) |
| `PreToolUse` | `tool`, state `running` |
| `PostToolUse` / `PostToolUseFailure` | `tool`, state `complete` / `failed` |
| `PermissionRequest` | `attention` (`attentionKind: permission`) |
| `Elicitation` | `attention` (`attentionKind: elicitation`) — **not respondable**, see R5 |
| `MessageDisplay` | `message` (`role: assistant`) |
| `SubagentStart` / `SubagentStop` | `subagent` |
| `TaskCreated` / `TaskCompleted` | todo item (spec 08) |
| `PreCompact` / `PostCompact` | `lifecycle` (`context-compaction`) |
| `Stop` / `StopFailure` | `lifecycle` (`turn-completed` / `turn-failed`) |
| `Notification` | `lifecycle` (`warning`) |

Provenance is `provider-api` / `exact` / `provider-exposed` (spec 01 R5). These are the
harness's own payloads, delivered synchronously by the harness.

`agent_id` / `agent_type` populate `parentId` and the subagent hierarchy, which the contract
supports (`src/activity/types.ts:62-79`) and the UI currently drops.

Two payload rules, both inherited from existing policy:

- **Redaction still applies.** Route hook payloads through `src/activity/redaction.ts` exactly
  as provider streams are. Tool inputs can contain secrets.
- **The global feed stays metadata-only.** `metadataOnly()` (`src/server/state.ts:21-39`)
  strips exact request content from the collection SSE. Hook-derived attention must obey it —
  exact content reaches the selected-session stream only.

### R4 — Blocking decisions

This is the capability that makes the bridge worth building.

Flow for `PermissionRequest` / `PreToolUse`:

1. Hook POSTs. The route registers a pending decision keyed by `(session_id, prompt_id, tool)`
   and **holds the HTTP response open**.
2. An `attention` item with `respondable: true` reaches the selected-session activity stream.
3. The operator answers. The response resolves the held request with the appropriate decision
   shape and the item is marked resolved.
4. If the operator does not answer within the bridge's own deadline, the route returns a
   **defer** — `permissionDecision: "defer"` for `PreToolUse`, or an empty/exit-0 response
   elsewhere — and the harness falls through to its own prompt.

Hard constraints:

- **The bridge deadline must be comfortably under the hook timeout** (600s default; 30s for
  `UserPromptSubmit`, 10s for `MessageDisplay`). Pick per event, not one global number.
- **Fail open to the harness, always.** Manager shutdown, panic lock, browser disconnect, token
  rotation, unhandled exception — every path must release the hook. A wedged terminal because a
  browser tab closed is the worst possible failure of this feature, and it is worse than not
  shipping it.
- Hold state in memory only. A pending decision does not survive a manager restart; on restart,
  release everything.
- Respect the existing exactness gate. The UI only offers inline controls for
  `!resolved && waiting && provider-api && exact && provider-exposed && !truncated`
  (`web/src/components/session-thread.tsx:126-145`). Hook attention satisfies it by construction;
  do not weaken the gate to make it fit.

### R5 — Elicitations stay non-respondable

MCP elicitation forms are visible but deliberately not answerable in the cockpit, in both
providers today (`src/providers/codex/provider-bridge.ts:540-542`,
`src/providers/codex/activity-projector.ts:983-984`,
`src/providers/claude/provider-adapter.ts:542-544`). The stated reason stands:

> `// The current cockpit cannot faithfully encode form or URL elicitations.`

The `Elicitation` hook *could* return `accept` with `content`. Do not use it until the cockpit
can render the form faithfully. Show the elicitation, mark it non-respondable, point at the
native interface — the behaviour the README already promises.

### R6 — No steering

Restated here because the hook API makes it tempting: `Stop` with `decision: "block"` and a
`reason` will make the model continue, acting on that reason. It is not a user message. See
spec 01 R4. A `claude-hook-bridge` session advertises no `queue` and no `steer`.

### R7 — Interaction with the transcript observer

A hook-bridged session should stop being polled for the parts hooks now cover.
`SelectedTranscriptActivityObserver` eligibility (`src/server/server.ts:379-388`) currently keys
on `!managerOwned || nativeHandoffs.has(id)`. Extend it: a session with a healthy bridge
suppresses polling for hook-covered kinds, and falls back the moment the bridge goes quiet.

Do not run both and dedupe — that produces double items with conflicting provenance, which is
precisely the confusion R5 of spec 01 exists to prevent.

## Non-goals

- Installing hooks on remote SSH hosts. Local only in this pass; the install shape should not
  preclude it later.
- Using hooks for manager-owned sessions. They already have the SDK/app-server stream, which is
  richer. Manager-owned sessions must not double-report.
- `WorktreeCreate` interception. Spec 04 reads worktrees from git; it does not need to mediate
  their creation.

## Acceptance criteria

1. `install` writes a marked block, shows the diff first, backs up, and preserves every
   unrelated setting byte-for-byte. `uninstall` restores exactly. Round-trip tested against a
   settings file containing unrelated hooks, MCP servers and permissions.
2. With hooks installed, a Claude session started in a **real terminal** (not by the manager)
   shows tool calls, subagents and messages in the cockpit with `exact` / `provider-exposed`
   provenance.
3. Triggering a permission prompt in that terminal surfaces an answerable request in the
   browser; answering it releases the terminal with the right decision.
4. Not answering it releases the terminal to its own prompt before the hook times out.
5. Killing the manager mid-decision releases every held hook. Verified by test, not by
   inspection.
6. A hook POST with an unknown token is rejected, and no non-loopback origin can reach the route.
7. The session's composer is read-only with a stated reason, and no `send` action is accepted.
8. Panic lock: events keep flowing, decisions auto-defer.
9. Redaction applies to hook payloads; the global SSE carries no exact request content.

## Open questions

- **Q1.** Project-scoped (`.claude/settings.json`, committable) vs user-scoped
  (`~/.claude/settings.json`) install default. Project scope would follow a repo to teammates,
  which is almost certainly wrong for a machine-local daemon URL. **Recommend user scope**, with
  project scope available and warned about.
- **Q2.** How does the bridge correlate a hook `session_id` to an Agent Manager session record
  when the session was discovered by process scan? `session_id` matches the Claude registry's
  `sessionId` (`~/.claude/sessions/<pid>.json`), which discovery already parses
  (`agent-sessions.ts:828-893`) — confirm that holds for every entrypoint, including `--bg`.
- **Q3.** Codex hook payload schema is assumed to mirror Claude's from the shape of
  `~/.codex/hooks.json`. Verify against `hooks/list` on the daemon before implementing R3 for Codex.
