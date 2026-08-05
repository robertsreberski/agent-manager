# Spec parity record

**Method:** each row was checked against the implementation, and where possible against a running
instance (`dist/cli/index.js serve --port 43127`) with Playwright and direct API reads. Rows marked
*verified* were confirmed by running something, not by reading alone. This file records what was
actually checked — it is not a claim that every criterion in every spec has been audited.

## Independently verified — passing

| Spec | Criterion | Result | How it was checked |
| --- | --- | --- | --- |
| 07 | AC5/AC6 — an approval whose paths are unresolvable renders tier 2, and tier 2/3 ignore `↵` | pass | `approvalTier()` (`web/src/components/requests/model.ts`) returns `outside` whenever `workspaceRoot`, `paths` are missing/empty or any path is non-absolute; the `⌘↵` listener in `ApprovalRequest.tsx` returns early unless `tier === "workspace"` |
| 07 | AC7 — the fact row omits `deletes` when the provider gave no such fact | pass | `toolApprovalFacts()` (`src/providers/approval-facts.ts`) reads only a pinned allowlist of Claude built-in tool fields and never tokenizes commands, expands globs, or touches the filesystem |
| 07 | AC2/AC3 — atomic multi-question submit; secrets never echoed | pass | `QuestionRequest.tsx` gates submit on `complete` (every question answered) and emits one `{kind:"answers"}`; `summarizedAnswer()` returns `••••••` for `question.secret` |
| 07 | R2 — described options never truncate into pills | pass | `described` switches the container to `grid gap-2` and each option to a full-width row with `[text-wrap:pretty]` |
| 08 | AC8 — the word "task" appears in no todo surface | pass, verified | `grep -rniE "\btasks?\b"` over `web/src/components/plans/` and `TodoProgressMeter.tsx` returns nothing |
| 08 | R9 — always `n of m`, never a percentage | pass, verified | no percentage formatting in `TodoList.tsx` / `TodoProgressMeter.tsx` (the only `%` is a modulo) |
| 09 | R7/AC8 — diff lines wrap rather than scroll; no page-level horizontal scroll | pass | `DiffViewer.tsx` uses `grid-cols-[30px_13px_minmax(0,1fr)]`, `min-w-0`, `max-w-full`, `whitespace-pre-wrap break-words [overflow-wrap:anywhere]`, and `overflow-hidden` on the article; the raw fallback `<pre>` is contained the same way |
| 10 | AC7 — a selection containing a running session offers no delete, and says why | pass | `SelectionBar.tsx` filters `!(action === "delete" && session.activity === "running")` and renders the visible line `N running (cannot delete)` |
| 10 | AC8/AC11 — mixed selections report per-action outcomes, bounded concurrency | pass | `SelectionBar` renders `Archived n · m not supported · k failed`; `selectionAction` in `App.tsx` uses a 3-worker cursor pool and counts every outcome |
| 05 | R5 — heuristic attention is visually distinct and non-actionable | pass | `SessionCard.tsx` renders `border-l-2 border-dashed border-[var(--accent)]` and `data-attention-confidence="heuristic"` when `boardState === "wants-you" && !attentionExact` |
| 12 | Responsive — board at 320px | pass, verified | at 320×844 `document.documentElement.scrollWidth === 320`; the only elements crossing the viewport edge live inside the header filter row, which is a deliberate `overflow-x: auto` scroller |
| 01 | Wire epoch mechanism — a build/schema mismatch fails closed with a typed upgrade error | historical pass at wire 3; wire 5 cutover pending below | pointing a `development`-build client at the deployed `am-fb0945e6…` server produced the error screen "Agent Manager build mismatch; expected wire 3 / development, received 3 / am-fb0945e6…" instead of degrading into a partially-working cockpit |
| 13 | Removals — no global stop/sentinel, `set-mode`/`set-access`, sidebar, launch dialog, duplicate `session.messages` timeline, migration aliases | pass, verified | repository greps return no matches. `ClaudeManagedSession.setMode()` is the internal SDK permission-mode call reached through the atomic `set-profile` mapping (`profileMode(action.profile)`), which is what spec 01 requires — not the forbidden public action |

## Found and fixed during this pass

| Spec | Criterion | Was | Fix |
| --- | --- | --- | --- |
| 12 | The four-tier text ladder (`0.95 / 0.72 / muted / faint`) | Spec 12 specifies `text muted oklch(0.56→0.50)` and `text faint oklch(0.44→0.40)`. The app shipped `#999999` (≈0.665) and `#8d8d8d` (≈0.625) — the only two tokens not in oklch, measured 7.12 and 6.12 against `--app`, i.e. barely one contrast step apart, collapsing four tiers into three. A contrast test forced it by requiring hex notation and AA against `--surface-selected-active` (`#222`), the lightest surface in the theme, which muted/faint text is almost never rendered on. | Restored the ladder: `--text-muted: oklch(0.58 0 0)` (the darkest value clearing AA on both surfaces it is actually read on — 4.74:1 on `--app`, 4.62:1 on `--surface-raised`) and `--text-faint: oklch(0.44 0 0)` exactly per spec. `theme-contrast.test.ts` now parses oklch, checks each tier against the surfaces it is rendered on, holds faint to a 2.5:1 legibility floor as documented incidental metadata, and asserts each adjacent tier stays ≥1.35:1 apart so the ladder cannot silently flatten again. |
| 09 | AC1–AC3 — correct gutters and `+n −m` counts per file | A blank context line that had lost its leading space (routine after trailing-whitespace stripping) hit the parser's `else` branch and returned `{kind:"raw", reason:"malformed"}`, discarding the whole file's gutters, tinting and counts. AC4's raw fallback is for genuinely malformed input, not for a blank line. | `parseUnifiedDiff` now reads `""` as a blank context line while the hunk still owes lines, and only treats it as the terminating empty tail once `seenOld`/`seenNew` are satisfied. Covered by two tests, including a guard that a trailing empty line is still not counted as context. |

## Design fidelity against the vendored frames

A frame-by-frame pass was run against `docs/design/cockpit/` (the prototype for the board, drawer,
composer and question frames; the redesign file for turns 8 and above). The structural finding:

| Was | Impact | Fix |
| --- | --- | --- |
| The global reset in `web/src/styles.css` was written **unlayered**, so `* { border-color: var(--border) }` outranked every `border-[var(--…)]` utility Tailwind emits into `@layer utilities` — unlayered CSS beats layered CSS regardless of specificity. | **Every border colour in the app was dead.** Verified in a live browser: a synthetic `border-[var(--accent)]` element computed `oklch(0.24 0 0)`. Every hairline, frame, chip outline and dashed edge rendered as the same flat grey no matter what the component asked for — including the spec 05 R5 heuristic-attention edge, whose entire job is to look *visibly inferred*. | The resets moved into `@layer base`, with a comment requiring new global element rules to stay there. `.sr-only` and the `.safe-area-*` helpers stay unlayered on purpose so they keep beating utilities. |

Tokens added, each traceable to a frame or spec line rather than invented: `--board-rule`,
`--selected-field`, `--danger-text` (spec 05 R3), `--danger-pill-field`, `--border-loud`,
`--remote-rule`, `--remote-field`, `--remote-pill-field`, `--added-line-text`,
`--removed-line-text`. The last two exist because frame 10a colours diff *line text* far lighter
and less saturated than the `+`/`−` markers, so a fully-changed line reads as prose rather than
glowing; a test now asserts both halves and that neither carries the other's token.

### Departures from the frames, resolved

All seven recorded departures now follow the frame. Four of them only because
the behaviour the frame assumed has since been built.

| Frame | What it shows | What ships |
| --- | --- | --- |
| `5a`, `9a-2`, `9b` | The composer's harness tile and active effort bars filled with lime | As shown, with the frame's `CodeXml` glyph. Only the bars the effort actually reaches are filled. |
| `9b`, `13c` | Capability ticks in lime, a present harness in green | As shown. |
| `7a` | A lime connection status dot | As shown; anything other than a live connection stays a warning. |
| `8a` | The tier-1 approval hint reads `⏎ allow` | As shown — Enter now allows, guarded exactly as ⌘↵ was: routine tier only, only while exactly one such request is ready, never while typing. ⌘↵ still works. |
| `11b` | Tool-call step indent 24px; tool name `flex-shrink: 0` | As shown, with the name bounded to `max-w-[60%]`. Codex names a `commandExecution` with the whole shell command, and an unbounded `shrink-0` on one of those is what produced a 2551px row inside a 390px viewport. |
| `9a-3` | Headline "Allow this command to delete your cache directory?" | A headline naming the delete target, built from what the provider actually sent. Spec 07 R7 forbids globbing for a count and permits naming a path the tool input gave, so it appears when `deleteCount` is provider-supplied and stays silent otherwise. |
| `5a` | Placeholder "@mention files, run /commands" | As shown. Both affordances exist: `@` completes against the session's own worktree through a bounded, symlink-refusing read that returns workspace-relative paths, and `/` offers commands the provider's CLI accepts. The placeholder names only the half a given session can do. |

The accent rule that motivated the original colour departures is narrowed
rather than dropped. What it still forbids is the accent standing in for state
the board is *scanned* for — a session card, assistant bubble or plan artifact
tinted lime would make "this session wants you" and "this session exists" the
same glance, and that distinction is the board's only job.
`web/src/theme-contrast.test.ts` guards the narrowed rule.

## Current control contract — verification pending

Specs 01 and 02 now define the wire 5 provider split. These rows are release gates, not claims of
completed verification:

| Spec | Contract to verify | Required evidence |
| --- | --- | --- |
| 01 | Every `SessionControl` carries a valid provider-specific `coordination` shape and nullable bounded `recovery`; old wire shapes fail closed | strict shared-schema tests across server/web/remote fixtures, plus a real mismatched wire 4 ↔ wire 5 connection |
| 01 | Managed Codex is `shared / join / first-response-wins`; managed Claude is `exclusive / handoff / single-controller` | adapter projection tests and cockpit action-copy checks for both providers |
| 01 | Manual provider recovery is advertised and accepted only through `retry-control`; exact native Claude ownership is a healthy stable wait; no recovery replays an action | failure-injection tests covering reconnecting, waiting-for-native-exit, retrying, needs-attention, explicit retry, and idempotency logs |
| 02 | A native Codex `--remote` peer and cockpit client use one private-server thread concurrently; environment IDs remain observational | disposable two-client app-server probe covering send, steer, interrupt, request resolution, disconnect, and rejoin |
| 02 | First exact Codex response wins without duplicate requests or replay | two-client request race plus `serverRequest/resolved` timeline assertion |
| 02 | Standalone Codex migration is one-time and identity checked; Claude takeover remains exclusive | guided cancel, server-issued two-action graceful confirmation, one-SIGTERM, PID reuse, identity/workspace drift, timeout, restart recovery, and duplicate-owner rejection tests |
| 02 | The mismatched user-global experimental daemon is neither trusted nor mutated | process/socket provenance assertions and deploy/runtime audit proving only the pinned private child is addressed |

## Not audited

Specs 01–02 have an updated contract and the explicit pending gates above, but have not yet been
re-audited against wire 5. Specs 03–04 (hook bridge, workspace model), 06, 11, and the remaining
criteria of 05 and 07–10 were not walked criterion by criterion in this pass. The defects that
were found and fixed against them are recorded in the branch history rather than here.
