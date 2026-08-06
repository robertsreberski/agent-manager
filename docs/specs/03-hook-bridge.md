# 03 — Provider-specific hook bridges

**Status:** Accepted · **Depends on:** 01 · **Design frames:** 6a, 8a, 9b

## Purpose

Observe ordinary terminal sessions through provider-owned event surfaces and answer only the
blocking decisions each provider can faithfully delegate. Claude and Codex have different
transports, schemas, trust, and response semantics; they are two adapters behind one activity
contract, never one “universal hook” implementation.

## Installation contract

- Installation is an explicit CLI operation: `agent-manager hooks status|install|uninstall`
  with provider/scope flags. First run explains the benefit and points at the command; it does
  not write settings from the browser.
- User scope is the default. Project-local scope is optional and warns that the target is a
  machine-local service. Managed-policy settings are never changed or bypassed.
- Before writing, print the exact diff and require terminal confirmation. Edit only Agent
  Manager-owned entries, preserve unrelated settings, and use an atomic replace. Reinstall and
  uninstall are idempotent. Do not create a backup/migration tree.
- `status` distinguishes absent, installed-unseen, active, stale token/schema, untrusted, and
  provider-disabled. Installation is not called active until a later real event arrives.
- Tests use disposable home/settings overlays and real disposable sessions. They never mutate
  global settings, global trust, the shared daemon, or an existing user session.

## Claude HTTP bridge

Claude hooks use a high-entropy per-install token and loopback HTTP:

```text
POST http://127.0.0.1:<port>/api/v1/hooks/claude/<token>
```

The route is outside browser cookie/CSRF auth but remains loopback/Host restricted, bounded by
body size and time, constant-time token checked, no-store, and redacted before logging or
projection. A token is never included in browser state.

Observed pinned behaviour:

- Claude Code `2.1.223` reloads a newly added local settings handler for later events in an
  already-running session. The install edit itself produces no event, hence installed-unseen.
- The hook `session_id` matches the session registry/`claude agents --json --all`, including a
  disposable `--bg` probe, and is the correlation key.
- `PermissionRequest` is the only faithful interactive decision surface for an externally
  started interactive session. `PreToolUse` defer is honoured in print mode but ignored for
  interactive/batch cases, so it is observed only and never presented as respondable.
- `Elicitation` remains visible but non-respondable until every provider form/URL shape can be
  represented without loss.

For each held `PermissionRequest`, allocate an Agent Manager request UUID. Claude does not
provide a tool-use ID on this hook, so `(session, prompt, tool)` is not unique enough. Hold the
HTTP response in memory, publish exact respondable attention, and resolve it once. Allow/deny
uses Claude's exact response shape. Timeout, browser loss, token rotation, server shutdown, or
any exception returns an empty successful response so Claude falls through to its native prompt.
Pending holds are never persisted or replayed.

No Claude hook return is used to queue, steer, end, or inject an operator message. In particular,
`Stop` plus `reason`/`additionalContext` is a system-side instruction, not a user turn.

## Codex command-hook bridge — retired

This plane no longer exists. Its shim discarded every response by construction ("observation-only
until Codex response authority is proven live"), so it could only ever *reduce* a session's
capabilities: for manager-owned threads it bailed out immediately because the App Server already
delivers exact events, and for external threads it duplicated what the discovery sweep already
enumerates. The six modules, the ops install/config pair, the generated shim and its trust flow,
the `codex_hook_installs` table, and the `codex-hook-bridge` control plane were removed, along
with the Codex halves of setup, the CLI, and the hooks E2E gate.

Startup sweeps what it installed, because this wrote into a file the operator also edits by hand:
`sweepRetiredCodexHooks` removes only handlers whose command is our own generated shim, preserves
the surrounding JSONC byte for byte, drops an event key only when we solely occupied it, and
deletes the shim. It takes its home directory as an argument rather than reading `homedir()`.


## Activity projection and source arbitration

Both adapters emit the shared `ActivityMutation` model with provider-api/exact/provider-exposed
provenance, provider IDs when available, and redaction. Typical mappings are session/turn
lifecycle, user prompts/messages, tool start/completion/failure, permission attention,
subagents, tasks/todos, compaction, and warnings. Unsupported/unknown events become bounded
diagnostic lifecycle items, not guessed semantic content.

Source arbitration is de-duplication, not ownership. The manager's own SDK child inherits the owner
marker and its global hook is a duplicate of what the SDK stream already reports, so it stays a
quiet no-op. Every other hook is accepted — **including a markerless one on a session the manager
also holds.** That is a peer turn from the operator's terminal, and it used to be read as an
`ownership-conflict` that tore down the manager's query: joining "worked" until its owner typed.
Dropping such an event would also leave the cockpit blind to half of a shared conversation.

There is one visible timeline:

- For kinds covered by a healthy hook, suppress equivalent transcript projection.
- Transcript observation may fill uncovered kinds with inferred provenance.
- On hook silence or removal, fall back to bounded transcript observation without duplicating
  stable provider IDs.
- Global SSE receives metadata only; exact question/tool content appears only in the
  authenticated selected-session stream.

## Acceptance criteria

1. Install/status/uninstall preserves unrelated settings, shows a diff, is idempotent, and
   correctly reports Claude active versus installed-unseen.
2. A disposable external Claude session emits exact activity and one `PermissionRequest` can be
   allowed/denied from the cockpit; unanswered/server-killed requests fall through promptly.
3. Claude `PreToolUse`, elicitation, Stop, and arbitrary text never become response/steer paths.
4. A disposable Codex CLI session proves the trusted command shim, provider-specific schema,
   supported event projection, and any advertised request response.
5. Unknown tokens, non-loopback traffic, oversized/invalid payloads, stale decisions, and
   duplicate answers are rejected without provider or secret leakage.
6. Hook-derived content is redacted, selected-session only, bounded, and deduplicated against
   transcript observation.
7. External hook sessions reject all actions not present in their live capability list with a
   plain-language reason.
