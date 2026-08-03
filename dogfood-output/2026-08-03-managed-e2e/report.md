# Dogfood Report: Agent Manager

| Field | Value |
|---|---|
| Date | 2026-08-03 |
| App URL | `https://mickey-home.tail8a9beb.ts.net:9443/` via Tailscale Serve |
| Session | agent-manager-managed-e2e and agent-manager-tailscale-final |
| Scope | Desktop/mobile cockpit, live discovery, and a disposable manager-owned Codex workflow |

## Summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 7 |
| Medium | 2 |
| Low | 0 |
| **Total** | **9** |

## Verification log

- Opened a clean production build through its one-time fragment bootstrap and
  confirmed the fragment was removed after cookie exchange.
- Confirmed a stable `text/event-stream; charset=utf-8` connection and live UI
  transitions without manual refresh.
- Created disposable manager-owned Codex sessions in standard/workspace mode.
- Switched execution to planning and back with exact `provider-api` mode
  evidence displayed in the UI.
- Triggered a real Codex `request_user_input`, saw the session enter `Waiting`
  and `Needs you`, selected `Blue`, added free-text context, and submitted one
  atomic response.
- Queued work, steered an active `sleep 20` turn, and verified both durable
  action receipts completed as `succeeded` with live return to idle.
- Verified native access exposes only `agent-manager attach <session-id>` and
  never a raw provider socket or browser-executed command.
- Verified the 390x844 mobile session drawer and control surface.
- Loaded bounded, readable Codex and Claude transcripts on demand at 390x844,
  with no horizontal overflow and explicit unavailable/truncated states.
- Created a fresh standard Codex session from mobile, confirmed its writer
  lease was acquired automatically, then rendered the initial prompt/reply and
  a queued follow-up/reply without a separate control action.
- Confirmed the same stable per-tab EventSource client ID survived full-page
  navigation and replacement streams remained HTTP 200 instead of exhausting
  the per-auth stream limit.
- Confirmed collection REST and SSE state remain transcript-free while the
  selected detail route returns four bounded messages with `Cache-Control:
  no-store`.
- Re-ran axe against the deployed Tailscale URL at 390x844: 30 rules passed,
  zero violations, and zero unresolved ARIA checks.
- Verified the deployed EventSource returned HTTP 200 over the Tailscale URL,
  with no page errors or console messages after a clean reload.
- Verified the live LaunchAgent process contains only the explicit runtime
  allowlist; Todoist, OpenAI, Anthropic, and SSH-agent variables are absent.
- Browser console and page-error checks were empty during the successful run.
- Full automated gate: 138 source tests, 49 web tests, TypeScript, both
  production bundles, and the production dependency audit all pass.

## Issues

### AM-E2E-001 — Live state remained offline

- Severity: High
- Status: Resolved and regression-tested
- Area: SSE / production server
- Reproduction: Open the built app, complete bootstrap, and observe the status
  badge while `/api/v1/events` repeatedly reconnects.
- Expected: A stable Live connection and immediate session updates.
- Actual: Fastify's hijacked reply skipped buffered headers, so Chromium saw
  `text/plain` and rejected the EventSource stream.
- Fix: Copy all accumulated Fastify/security headers to the raw response before
  hijacking. A real TCP test now asserts MIME, cache/proxy headers, and the
  first named snapshot frame.
- Evidence: `videos/managed-codex-workflow.webm` captures the original failure;
  `screenshots/03-live-empty.png` and the final network trace prove the repair.

### AM-E2E-002 — Managed Codex steer failed closed as unknown

- Severity: High
- Status: Resolved and live-verified
- Area: Managed Codex control contract
- Reproduction: Start a long-running managed turn, take control, and choose
  Steer now.
- Expected: The message is applied to the exact active turn.
- Actual: The provider tracked the turn ID but omitted it from the public
  `SessionView`; the browser could not supply `expectedRunId`, so dispatch
  failed closed and the durable outcome became `unknown`.
- Fix: Publish the exact active run ID only while the turn is running, preserve
  it through REST/SSE normalization, and clear it on completion.
- Evidence: `videos/managed-codex-workflow-final.webm` captures the failure;
  `videos/managed-codex-steer-fixed.webm` captures the successful rerun, and
  `screenshots/05-live-steer-queue.png` shows the repaired live control flow.

### AM-E2E-003 — Mobile page semantics and scroll keyboard access

- Severity: Medium
- Status: Resolved and live-verified with zero axe violations
- Area: Accessibility
- Reproduction: Run axe at a 390x844 viewport with a selected session.
- Expected: A discoverable level-one page heading and keyboard-focusable
  scroll region.
- Actual: The desktop sidebar heading was hidden on mobile, the conversation
  viewport had no focus target or landmark role, and class-based `dark:`
  variants did not activate under the app's media-query theme.
- Fix: Add a mobile-only screen-reader H1, make the focusable session viewport
  a named region, and align Tailwind's `dark:` variant with the system dark-mode
  media query so semantic badge colors retain contrast.
- Evidence: `screenshots/07-mobile-cockpit.png` captures the first pass;
  `screenshots/09-tailscale-mobile.png` captures the final deployed result.

### AM-E2E-004 — LaunchAgent inherited unrelated user credentials

- Severity: High
- Status: Resolved and live-verified
- Area: Service/runtime environment
- Reproduction: Bootstrap the installed LaunchAgent and inspect only the names
  of variables in the actual service process environment.
- Expected: Controlled runtime variables and provider prerequisites only.
- Actual: An unrelated Todoist credential was inherited from the user launchd
  domain. Its value is intentionally omitted from this report.
- Fix: Start through `/usr/bin/env -i` with a literal allowlist for the account
  identity, temporary directory, controlled path, and four pinned executables.
  The plist stores no API keys or tokens and does not inherit a transient
  `SSH_AUTH_SOCK`.
- Evidence: The reloaded process listens only on `127.0.0.1:43127`, its health
  endpoint is green locally and through Tailscale, and process-level checks
  confirm Todoist, OpenAI, Anthropic, and SSH-agent variables are absent.

### AM-E2E-005 — External sessions render an empty activity pane

- Severity: High
- Status: Resolved and live-verified on Codex and Claude
- Area: Transcript discovery and responsive session view
- Reproduction: Open the deployed cockpit at 390x844 and select any discovered
  Codex or Claude session after a manager restart.
- Expected: A bounded, readable transcript of the selected session, with the
  newest messages visible and live updates as the provider transcript grows.
- Actual: Discovered sessions carried no messages, so the activity region
  showed only a synthetic status marker. This was not mobile clipping.
- Fix: The authenticated selected-session detail route now resolves exact
  Codex rollout or Claude transcript identity, reads only the newest bounded
  window, reconstructs Claude branches, filters tools/machine traffic, and
  returns explicit available/unavailable/truncated state. Transcript data is
  never inserted into collection state, SSE, the replay ring, audit, or logs.
  The frontend merges transcript detail independently from newer SSE metadata.
- Evidence: `screenshots/10-mobile-transcript-empty.png` reproduces the defect;
  `screenshots/18-mobile-codex-transcript-fixed.png`,
  `screenshots/20-mobile-claude-transcript-fixed.png`, and
  `screenshots/29-final-deployed-mobile-clean.png` prove the deployed repair.

### AM-E2E-006 — Managed creation looked inert and follow-up input looked disabled

- Severity: High
- Status: Resolved and live-verified with two fresh managed Codex sessions
- Area: Managed creation / writer lease / transcript feedback
- Reproduction: Launch a standard managed session with a first message, then
  open its detail view on mobile and try to send a follow-up.
- Expected: The initial exchange is visible and the creating browser can send
  immediately.
- Actual: The provider did receive and answer the first message, but the empty
  transcript hid both. The composer then required a separate header-level
  `Take control` action, making a healthy session appear inert.
- Fix: Standard browser launches automatically acquire a five-minute lease for
  the creating tab; full-host arming remains explicit. Codex creation now also
  fails unless `turn/start` acknowledges the initial message with a turn ID,
  avoiding a separate latent false-success path.
- Evidence: `videos/managed-initial-message-repro-2.webm` captures the hidden
  success; `screenshots/25-final-mobile-managed-initial.png` and
  `screenshots/26-final-mobile-managed-followup.png` show immediate control and
  both rendered exchanges. Exact known E2E tokens were also confirmed in the
  provider rollout.

### AM-E2E-007 — Reconnect exhausted the browser SSE allowance

- Severity: High
- Status: Resolved and regression-tested
- Area: SSE lifecycle / stale generation protection
- Reproduction: Navigate or reload after React/EventSource has opened earlier
  streams, then observe a third `/api/v1/events` request.
- Expected: The current tab replaces its prior stream and remains Live.
- Actual: Stale proxy-visible streams remained counted; the next request
  returned 429, leaving metadata stale and causing a valid send to fail its
  generation check.
- Fix: Each tab persists a validated client ID in `sessionStorage`; the server
  closes and replaces an earlier stream with the same authenticated client ID
  before enforcing stream limits. The identity survives navigation but is not
  shared across tabs.
- Evidence: The reproduction trace contains two 200 streams followed by 429;
  the final trace shows repeated navigation with one stable client ID and only
  replacement 200 responses after authentication recovery.

### AM-E2E-008 — Mobile launch button overlapped the drawer close control

- Severity: Medium
- Status: Resolved and live-verified
- Area: Mobile session drawer
- Reproduction: Open the session drawer at 390x844 and tap the top-right launch
  button.
- Expected: Launch and close are distinct touch targets.
- Actual: The Radix sheet close button covered the launch button.
- Fix: The mobile drawer reserves explicit close-button space and session rows
  now display Manager/External ownership so restarted read-only sessions are
  distinguishable.
- Evidence: `screenshots/19-mobile-sidebar-ownership-launch-fixed.png`.

### AM-E2E-009 — Codex machine context rendered as a human user message

- Severity: High
- Status: Resolved and live-verified
- Area: Transcript privacy and normalization
- Reproduction: Open a newly created managed Codex rollout containing injected
  environment context.
- Expected: Only human user and assistant conversation is visible.
- Actual: A complete `<environment_context>` envelope appeared as a green user
  bubble, exposing internal runtime context and obscuring the actual prompt.
- Fix: The Codex reader removes only complete machine-injected
  `<environment_context>` and `<recommended_plugins>` input blocks while
  preserving real prompts in the same provider message and ordinary human text
  that merely mentions those tag names.
- Evidence: `screenshots/22-mobile-managed-initial-transcript-autocontrol.png`
  reproduces the leak; `screenshots/24-mobile-codex-context-filtered.png` and
  `screenshots/29-final-deployed-mobile-clean.png` prove both E2E exchanges
  render with zero injected envelopes.
