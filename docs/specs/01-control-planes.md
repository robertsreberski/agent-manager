# 01 — Control planes and shared contract

**Status:** Accepted · **Depends on:** appendix and spec 02 decision · **Blocks:** all runtime/UI work

## Purpose

Represent authority and provider capability directly. “Manager-owned” and “external” are not
authorization shortcuts, and duplicated web/server DTOs are not allowed.

## Shared public types

The server, web client, and remote node import one strict shared contract. The final module name
may follow the repository layout, but there is only one definition and one runtime parser.

```ts
export type ExecutionProfile =
  | "ask-first"
  | "plan"
  | "execute"
  | "full-access"
  | "unknown";

export type ControlPlane =
  | "codex-private"
  | "codex-hook-bridge"
  | "claude-sdk"
  | "claude-hook-bridge"
  | "tmux-attach"
  | "resume-only"
  | "observe-only";

export type ControlCapability =
  | "queue"
  | "steer"
  | "interrupt"
  | "respond"
  | "set-profile"
  | "set-model"
  | "set-effort"
  | "remove-queued"
  | "preview"
  | "attach"
  | "resume"
  | "archive"
  | "delete"
  | "end"
  | "open-editor";
```

`codex-private` is the only managed Codex plane after spec 02's shared-daemon NO-GO. It names
the manager-owned private app-server runtime; `codex-app-server` is protocol terminology, not a
second plane label. `codex-hook-bridge` observes ordinary official CLI sessions and may answer
only request shapes the installed/trusted Codex hook actually exposes.

`SessionControl` contains `plane`, one authority state (`manager | foreign | none`), the exact
capability list, and optional display-only withheld reasons. Authorization reads capabilities,
never prose, ownership booleans, UI state, or provider strings.

The wire envelope includes a required epoch/build identifier. A mismatch returns a typed
upgrade error and closes the stream. The PWA hard-reloads; a remote node reports that it needs
updating. There is no compatibility parser.

Every source constructs the same distributed identity: `SessionRecord.id` =
`` `${hostId}:${provider}:${providerThreadId}` ``. `providerThreadId` is the exact
provider identity, `providerTreeId` groups related provider threads, and `parentId` is the stable
composed ID of the parent. Local, remote, hook, scan, SDK, and private app-server projectors may
not use different encodings.

## Capability ceilings

A live adapter may advertise less than its row because of version drift, controller ambiguity,
transport loss, or a provider method being absent. It never advertises more.

| Plane | queue/steer | interrupt | respond | profile/model/effort | preview/attach/resume | lifecycle |
| --- | --- | --- | --- | --- | --- | --- |
| `codex-private` | provider | provider | provider | experimental update, next-turn fallback; idle-only UI | guarded native handoff | provider RPCs only |
| `codex-hook-bridge` | never | never | trusted hook shapes only | never | tmux-derived only | never fabricate |
| `claude-sdk` | queue; steer only when pinned | yes | SDK callbacks | SDK `setModel`, effort flag, permission mode | guarded handoff/resume | `Query.close()` for manager-owned end |
| `claude-hook-bridge` | never | never | `PermissionRequest` only | never | tmux-derived only | never fabricate |
| `tmux-attach` | never | never | never | never | preview/attach | none |
| `resume-only` | never | never | never | never | attach/resume | none |
| `observe-only` | never | never | never | never | none | none |

Lifecycle actions are exact:

- Codex archive/delete use the corresponding RPC only when advertised. A running delete
  is rejected server-side.
- Codex end means interrupt the active turn, clear only the manager queue, unsubscribe/detach,
  and retain the resumable thread; no nonexistent `thread/close` is claimed.
- Claude end calls `Query.close()` only for a manager-owned SDK query. External Claude sessions
  have no end capability.
- Multi-select invokes the same per-session actions with bounded concurrency and reports every
  success/failure; there is no imaginary batch RPC.

## Execution profile mapping

The profile is provider-neutral product intent and maps atomically at the adapter boundary.

| Profile | Claude | Codex |
| --- | --- | --- |
| `ask-first` | default permission mode | approval on request + workspace-write sandbox |
| `plan` | plan permission mode | plan collaboration mode + safe approval/sandbox |
| `execute` | accept-edits equivalent | on-request approval + workspace-write sandbox |
| `full-access` | bypass permissions | never approve + danger-full-access sandbox |

Provider vocabulary is internal. If a provider/version cannot express the whole mapping, that
profile is unavailable; the app does not apply half of it. Codex settings are selected only
while idle. With `experimentalApi: true`, the pinned 0.146 experimental schema exposes
`thread/settings/update`; send that exact request and treat `thread/settings/updated` as the
effective state. On `-32601`, withdraw the live-setting method and use the selected values as
`turn/start` overrides on the next turn. Never optimistically assert effective state. Claude SDK
changes use its real live methods while the UI honours adapter-level capability withdrawal.

## Provenance and arbitration

- Provenance belongs to every activity item. A session may legitimately contain exact hook/API
  items and inferred transcript items.
- Controller arbitration is one generic state machine, not a copy of wrapper/PID-specific
  native handoff logic. Unknown or multiple foreign environments withdraw all semantic writes
  until a safe reclaim completes.
- Selecting a session is the ref-counted adoption/subscription boundary. Deselecting releases
  the selected stream and daemon subscription.
- A hook event is exact provider evidence. A process/transcript scan remains heuristic and may
  supply visibility, never write authority.

## Acceptance criteria

1. Server, browser, and remote code import the same strict schema; old aliases and duplicate
   fields are deleted.
2. One atomic `set-profile` action replaces `set-mode` and `set-access`; exhaustive action gates
   reject absent capabilities before provider dispatch.
3. Full access is orange, immediate, and represented by the same profile everywhere.
4. Codex settings remain idle-only, use the pinned experimental method when available, and
   fall back to next-turn overrides after exact method withdrawal.
5. Hook planes reject queue/steer, heuristic attention is never respondable, and withheld
   reasons render as plain language.
6. Ambiguous controller state withdraws writes without losing observation.
7. `codex-private` is the only managed Codex plane in production code and tests; neither a
   `codex-daemon` nor a `codex-app-server` plane label remains.
