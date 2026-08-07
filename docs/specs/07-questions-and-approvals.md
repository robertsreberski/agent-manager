# 07 — Questions and approvals

**Status:** Accepted · **Depends on:** 03, 05 · **Design frames:** `6a` (question), `8a` (approvals),
`9a-3` `9a-4` `9a-5` (phone)

## Purpose

The moment the cockpit exists for: an agent has stopped and only the operator can restart it.
Everything here is about making that moment exact and answerable — and about refusing to fake it
when it is not.

## Requirements — questions (`6a`)

### R1 — The disclosure

Lime: alert glyph, `Needs action: **<request name>**`, a duration at 0.7 opacity, and a chevron.
Content indents 24px.

The request name is the provider's own (`request_user_input`, a tool name). Do not prettify it —
the operator is looking at the harness, and a renamed request is a request they cannot correlate
with what their terminal or transcript shows.

### R2 — Option shape follows the option, not the layout

- **Short options** render as suggestion pills, 32px, fully round: the recommended one filled
  lime, the rest 1px outlined, plus a dashed pill for "Something else…".
- **Options with descriptions must become full-width rows.** 1px border, 10px/12px padding, a
  16px radio circle, label 500 14px, hint 12.5px/18px muted, `text-wrap: pretty`. Selected takes
  the wants-you fill and a lime outline.

> **Never truncate a described option into a pill.** The design states this explicitly. An option
> the operator cannot read is an option they cannot choose, and truncating the description turns
> an informed decision into a guess.

### R3 — Multiple questions, answered one at a time

The backend already models this atomically: `RequestResponse` includes
`{ kind: "answers", answers[] }` (`web/src/types.ts:255-273`), and the existing form has tests
for atomic multi-question submit (`pending-requests.test.tsx`).

- The disclosure carries `3/5` and five 13px × 3px segment ticks.
- Answered questions collapse to `question (12.5px muted) → answer (500 13.5px near-white)` with
  a pencil to revisit.
- **The open question is the only card with a fill** (13px/14px padding).
- Unanswered ones wait as numbered rows carrying their input type.
- **Nothing sends until the last is answered** — the response is atomic, and a partial answer is
  not a thing the provider can receive.
- On mobile the **Send N answers** button moves to a sticky footer (`9a-4`).

Keys: `1`–`9` pick, `↵` sends, `E` writes a custom answer.

### R4 — The exactness gate is not negotiable

Inline answer controls appear only for an item that is
`!resolved && state === "waiting" && source === "provider-api" && confidence === "exact" &&
exposure === "provider-exposed" && !truncated`
(`web/src/components/session-thread.tsx:126-145`), and
`mergePendingAttentionRequests` (`:147-190`) must keep refusing to synthesise controls from
session metadata — it deliberately merges with `prompt: null, options: [], multiple: false`.

The redesign makes the answer affordance prettier and more prominent. That is exactly when this
gate matters most. **Do not weaken it to make a frame render.**

A heuristic or metadata-only attention shows *that* something is wanted and points at the native
interface. It does not offer buttons that cannot work.

### R5 — Secrets

The existing form masks secret inputs and has a test for it. `ActivityAttentionItem.isSecret`
(`src/activity/types.ts:134-150`) carries the flag. A secret answer must not enter the activity
stream as plain text, must not appear in the global SSE (already true —
`src/server/state.ts:21-39`), and must not be echoed back into the collapsed
`question → answer` summary of R3. Collapse to `question → ••••••` instead.

## Requirements — approvals (`8a`)

### R6 — Three tiers, one grammar

| Tier | Field | Buttons | Keyboard |
| --- | --- | --- | --- |
| **Inside the workspace** | No tint. Grey disclosure, command in a raised mono block 12.5px/20px | `Deny` / `Always allow <class>` / `Allow` | `↵` allows |
| **Outside the workspace** | 2px red left tick on a red-tinted field | `Deny and explain` / `Allow once` (red pill) | **None — this one requires a click** |
| **On a remote host** | Same shape in violet | `Allow on <host>`, plus how many other sessions share it | **None** |

The absence of a shortcut on tiers 2 and 3 is a feature. The design says so, and the reason is
that a muscle-memory `↵` should never authorise something outside the workspace.

### R7 — The three facts, and the limit of honesty

Tier 2 "states what it will touch in three facts (writes, deletes, network)".

**No provider payload contains "deletes 412 files".** Codex sends the command, cwd and a reason;
Claude sends `tool_input`. So:

| Fact | Derivable? | Rule |
| --- | --- | --- |
| Inside vs outside the workspace | **Yes** — compare resolved paths against the workspace root | This is what *selects* the tier |
| `writes <path>` | **Sometimes** — when the tool input names a path | Show the path the provider gave. Never a count. |
| `deletes N files` | **No** | **Omit.** Do not glob the filesystem to produce a number; that is the cockpit doing work the agent has not been authorised to do. |
| network | **Sometimes** — from an explicit provider network policy/request field | Show only when the provider's own policy says so; never classify command text or a custom tool's lookalike field |

The fact row shrinks to what is true. One honest fact beats three where two are invented.

### R8 — Tier selection must be conservative

If the paths in a request cannot be resolved confidently — a shell command with substitutions,
an unparseable input — **treat it as outside the workspace**. The cheap error is an extra click;
the expensive error is a silent `↵`.

### R9 — Elicitations are shown, not answered

Unchanged from today, and deliberate: MCP elicitation forms appear in the timeline marked
non-respondable, pointing at the native provider interface
(`src/providers/codex/provider-bridge.ts:540-542`,
`src/providers/claude/provider-adapter.ts:542-544`). The stated reason —
*"The current cockpit cannot faithfully encode form or URL elicitations"* — still holds.

The hook bridge's `Elicitation` event could return `accept` with content (spec 03). It must
not, until the cockpit can render the form faithfully.

### R10 — Losing the race

With adoption (spec 02) and the hook bridge (spec 03), a request may be answered in the terminal
while the cockpit is showing it. On `serverRequest/resolved`, or on a `409 REQUEST_STALE` from
`POST /actions` (`src/server/server.ts:1434-1439`), the controls disappear and the item shows how
it was resolved. **This is a normal outcome, not an error toast.**

## Requirements — where these live

### R11 — Inline first, banner second

Today there is both a "Needs you" banner with a Sheet (`pending-requests.tsx:335`) and an inline
form in the timeline (`session-activity.tsx:590-614`). The redesign puts the request **in the
thread, at the point it happened** — that is what makes it a faithful depiction.

The board's "Wants you" scope and card state replace the banner's job of *finding* the session.
Delete the banner and Sheet; keep the form, in the timeline, and keep every test that covers its
semantics (radio/checkbox, "Other" exclusivity, secret masking, offline disabling, metadata-only
read-only).

The questionnaire or approval is the sole inline **needs-you** indicator. When the request names a
parent tool call, that call and its group read `waiting for answer` or `waiting for approval` with
no spinner. A completed group before the request is settled even though the provider turn remains
open; resolving the request does not make old completed work look active again. If the parent call
itself is still running after the answer, its real running state may resume, and any later tool call
starts a new run after the request boundary.

## Removals (spec 13)

The "Needs you" banner and its Sheet from `pending-requests.tsx` (R11). The question form itself
survives, relocated.

## Acceptance criteria

1. Options with descriptions render as full-width rows at every viewport; no description is
   truncated anywhere.
2. A 5-question form answers one at a time, shows `n/5` and segment ticks, sends nothing until
   the last, and submits atomically as `{kind: "answers"}`.
3. A secret answer never appears in the collapsed summary, the activity stream, or the global SSE.
4. An attention item failing any part of the R4 gate renders with no answer controls, and states
   where to answer instead. Existing gate tests pass unmodified.
5. An approval touching a path outside the workspace renders tier 2 and **does not respond to
   `↵`**. Verified by test.
6. An approval whose paths cannot be resolved renders tier 2, not tier 1.
7. The fact row omits `deletes` when the provider gave no such fact — no filesystem is walked to
   produce one.
8. A request answered elsewhere resolves the cockpit's copy quietly.
9. `Always allow` appears only when the provider itself supplies a persistence choice. Agent
   Manager never creates a shadow allow-rule.
10. The remote tier's count means active sessions on that host and is derived from the current
    collection; it is omitted when the collection is stale.
11. Repository searches find no global stop command, state, middleware, sentinel, banner, or
    documentation. Approval safety relies on exact capability/request gates.
12. A parented open request replaces the parent tool's active spinner with a static waiting label;
    after resolution, completed pre-request work remains settled.
