# 01 — Control planes and shared contract

**Status:** Accepted · **Depends on:** appendix and spec 02 · **Blocks:** all runtime/UI work

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
  | "full-access";

export type ControlPlane =
  | "codex-private"
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
  | "take-control"
  | "cancel-take-control"
  | "retry-control"
  | "open-editor";
```

`codex-private` is the managed Codex plane. “Private” describes app-server lifecycle and socket
ownership, not exclusive thread ownership: Agent Manager owns one pinned app-server and its
socket, while multiple cockpit clients and native Codex CLI peers may use the same provider
thread on that server. `codex-app-server` is protocol terminology, not a second plane label.
The Codex command-hook plane was retired: its shim discarded every response by construction, so
it could only ever reduce capabilities — the App Server already delivers exact events for managed
threads, and the discovery sweep already enumerates external ones.

`SessionControl` contains `plane`, one authority state (`manager | foreign | none`), required
provider coordination semantics, bounded recovery state, the exact capability list, optional
display-only withheld reasons, and typed takeover state when a standalone process can be
migrated safely. Authorization reads capabilities, never prose, ownership booleans, UI state,
environment IDs, or provider strings.

The required coordination shape is provider-specific:

```ts
interface SessionControlCoordination {
  // `exclusive` is retained in the union but no live plane publishes it: both
  // managed planes are shared. It remains rejectable rather than silently valid.
  mode: "shared" | "exclusive" | "observe-only";
  nativeAttach: "join" | "handoff" | "none";
  responseResolution: "first-response-wins" | "single-controller";
}

interface SessionControlRecovery {
  state: "reconnecting" | "retrying" | "needs-attention";
  attempt: number;
  startedAt: string;
  deadlineAt: string | null;
  nextRetryAt: string | null;
  error: string | null;
}

interface SessionTakeover {
  id: string | null;
  state: "available" | "awaiting-confirmation" | "waiting-for-exit" | "stopping" | "adopting" | "failed";
  methods: Array<"guided-exit" | "graceful-stop">;
  method: "guided-exit" | "graceful-stop" | null;
  requestedAt: string | null;
  deadlineAt: string | null;
  fallbackProfile: ExecutionProfile | null;
  error: string | null;
}
```

Both managed planes are `shared / join`. They differ only in `responseResolution`, and that
difference is a provider mechanism rather than a preference: managed Codex is
`shared / join / first-response-wins` because `serverRequest/resolved` lets two peers race the
same request, while managed Claude is `shared / join / single-controller` because it publishes no
such event — each controller holds its own SDK query and answers only its own requests, so there
is nothing to arbitrate. `single-controller` means one answerer per request, never one writer per
session. Observe-only projections use `observe-only / none / single-controller`.

`peers` publishes the live writers this build can prove, and is empty when there is one. It is
observational: authorization reads `capabilities`, never peer presence. `recovery` is null while provider control is healthy
or no recovery has run. A failed bounded recovery retains transcript access and advertises
`retry-control` only when another safe attempt is available. Recovery never replays work. Every
recovery state is a bounded transient or a dead end: `reconnecting` and `retrying` must leave
their transient phase by the published deadline, and an expired attempt becomes
`needs-attention` with a concrete error and retry/native guidance, never an indefinite
“recovering” or generic read-only state. There is no healthy indefinite wait, because nothing
waits for a native controller to exit.

`resume` is a semantic web mutation, distinct from `attach`. It requires the normal browser
lease, generation and idempotency fences, a complete no-owner scan, exact provider and workspace
validation, and a provider transaction that stays unpublished until its managed identity is
durable. `attach` remains optional advanced native access. Remote `resume` and takeover actions
are proxied to the node that owns the provider boundary rather than reinterpreted locally.

Wire schema 8 is one strict cutover for these fields and for the required per-session
`sandbox`. The envelope includes the required
schema/build identity. A mismatch returns a typed upgrade error and closes the stream. The PWA
hard-reloads; a remote node reports that it needs updating. There are no aliases or compatibility
parsers for earlier takeover, coordination, recovery, archive, or activity shapes.

Every `SessionRecord` carries the required `archived` boolean. Activity items may carry one
provider-scoped `correlationId`; exact hook/API projection atomically replaces its inferred
transcript twin in the same chronological slot, while transcript-only content remains. Missing
correlation means “not correlated,” never permission to text-match unrelated activity.

Every source constructs the same distributed identity: `SessionRecord.id` =
`` `${hostId}:${provider}:${providerThreadId}` ``. `providerThreadId` is the exact
provider identity, `providerTreeId` groups related provider threads, and `parentId` is the stable
composed ID of the parent. Local, remote, hook, scan, SDK, and private app-server projectors may
not use different encodings.

## Capability ceilings

A live adapter may advertise less than its row because of version drift, provider-specific
authority ambiguity, transport loss, or a provider method being absent. It never advertises more.

| Plane | queue/steer | interrupt | respond | profile/model/effort | native/takeover | lifecycle |
| --- | --- | --- | --- | --- | --- | --- |
| `codex-private` | provider | provider | first exact response wins | experimental update, next-turn fallback; idle-only UI | CLI joins the same private server; standalone migration when required | provider RPCs only |
| `claude-sdk` | queue; steer only when pinned | yes | SDK callbacks, one answerer per request | SDK `setModel`, effort flag, permission mode | CLI joins the same conversation as a second controller; no takeover | `Query.close()` for manager-owned end |
| `claude-hook-bridge` | never | never | `PermissionRequest` only | never | join; no handoff | never fabricate |
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

The profile is provider-neutral product intent and maps atomically at the adapter boundary. For
Codex it is the approval axis alone; what a permitted action may reach is the sandbox's business.

| Profile | Claude | Codex |
| --- | --- | --- |
| `ask-first` | default permission mode | default collaboration + approval on request |
| `plan` | plan permission mode | plan collaboration + approval on request |
| `execute` | accept-edits equivalent | default collaboration + approval on request |
| `full-access` | bypass permissions | default collaboration + never approve |

## Sandbox mapping

The sandbox is Codex-only and independent of the profile. `read-only`, `workspace-write` (writable
roots limited to the session's cwd, network access as chosen), and `danger-full-access` map
directly onto the provider's sandbox policy. Creation defaults to workspace-write without network
when the operator requested nothing, so a thread is contained until someone says otherwise.

Both axes are read back independently from `thread/settings/updated`: the sandbox is stated
outright and is taken as evidence, while the profile is inferred from approval and collaboration
alone. A policy this build does not recognize leaves the last known sandbox in place rather than
being read as a permissive one — an unknown sandbox and a wide-open sandbox must never look the
same. Claude has no sandbox and publishes none.

Provider vocabulary is internal. If a provider/version cannot express the whole mapping, that
profile is unavailable; the app does not apply half of it. Codex settings are selected only
while idle. With `experimentalApi: true`, the pinned 0.146 experimental schema exposes
`thread/settings/update`; send that exact request and treat `thread/settings/updated` as the
effective state. On `-32601`, withdraw the live-setting method and use the selected values as
`turn/start` overrides on the next turn — a profile and a sandbox chosen before that turn starts
both survive, in one request. Never optimistically assert effective state. Claude SDK
changes use its real live methods while the UI honours adapter-level capability withdrawal.

## Provenance and arbitration

- Provenance belongs to every activity item. A session may legitimately contain exact hook/API
  items and inferred transcript items.
- Codex execution-environment IDs are observational peer-presence facts, not ownership tokens.
  Another environment joining or leaving the manager-owned private server does not revoke
  semantic capabilities. Cockpit clients use the manager's normal short writer lease for browser
  mutation ordering; native Codex peers remain valid concurrent provider participants.
- When cockpit and native Codex peers can answer the same exact provider request, the provider's
  `serverRequest/resolved` event is authoritative: the first valid response wins, every other
  projection becomes stale, and no answer is replayed.
- Claude has no cross-surface arbitration, because it publishes no equivalent of
  `serverRequest/resolved`. Each controller holds its own SDK query and its own permission
  callbacks, so two surfaces never see the same request. Manager write capabilities appear once
  the exact session identity is revalidated and its own query is live — the other controller is
  never asked to exit. Two surfaces sending at once fork the conversation; the fork is published
  as a lifecycle warning naming the branch shown, never silently rendered as one history.
  A native-origin hook-held request stays visible and non-respondable, because answering it from
  the cockpit would race the terminal with no resolved event and no replay.
- A standalone Codex CLI connected elsewhere also requires one safe, identity-checked exit and
  adoption before it becomes a peer on the manager-owned private server. Once adopted, native
  CLI and web use are shared; takeover is not repeated for every client.
- Selecting a session starts the browser's bounded transcript/activity observer. A managed
  provider subscription is session-owned rather than drawer-owned, so switching tasks or
  closing a drawer cannot silently drop control, live history, or a shared Codex peer. Provider
  subscriptions end only at an explicit lifecycle boundary or runtime recovery.
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
6. Codex environment IDs remain observational and cannot withdraw writes on a healthy private
   thread; exact responses reconcile first-winner outcomes without replay or duplicate prompts.
7. `codex-private` is the only managed Codex plane in production code and tests; neither a
   `codex-daemon` nor a `codex-app-server` plane label remains.
8. Claude admits a second controller without stopping the first, proves exact session/workspace
   identity before publishing its own query, and publishes a fork rather than hiding one. A
   standalone Codex process still proves one-time migration, because its rollout format cannot
   represent two concurrent writers.
9. Wire 8 requires valid coordination, peer and recovery shapes, rejects old aliases, renders bounded
   recovery truthfully, and gates manual retry through `retry-control`.
