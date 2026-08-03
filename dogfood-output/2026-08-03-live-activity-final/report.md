# Agent Manager 0.2.0 dogfood report

Date: 2026-08-03  
Environment: macOS, local LaunchAgent, loopback HTTP behind Tailscale Serve  
Release candidate: `v0.2.0`

## Outcome

The cockpit was exercised end to end against real manager-owned Codex and Claude sessions. Managed creation sends the first prompt, subsequent queue/steer controls remain usable, provider activity streams before the turn completes, structured pending requests can be answered, and the transcript is readable on desktop and mobile.

The final UI uses assistant-ui's external-store runtime and thread/message/composer primitives while keeping Agent Manager's SSE reducer authoritative. Assistant output is rendered with the ready Markdown renderer, queued work uses the assistant-ui queue primitives, and the implementation uses the current v0.15 child-render APIs. Cockpit-specific session, access, mode, activity, and multi-question request surfaces remain custom because they carry provider semantics that generic chat components do not represent.

## Automated verification

The release candidate passed:

- 185 backend tests
- 71 web tests
- TypeScript checks
- server production build
- web production build
- the aggregate `pnpm check` command

## Real managed Codex verification

The browser launched an execution-mode Codex session through the UI with an initial prompt. At 500 ms the session was already `running`, the Interrupt control was visible, and live activity existed before the answer completed. The final session returned to `idle` and removed Interrupt.

The final assistant message was requested as Markdown and rendered as a semantic `h2` plus two list items:

```text
Assistant UI Ready
- live
- responsive
```

A second message was entered through the managed composer and queued normally. It produced `FOLLOWUP_OK`, left the authoritative queue at zero, and returned the session to idle. This verifies both the formerly missing first-message path and normal post-create messaging.

Earlier in the same run, a deliberately slow shell command demonstrated incremental tool activity and progressive output while the turn was still running. A planning-mode turn raised a native `request_user_input`, rendered its pending question, accepted the selected answer, and continued the same session.

## Real managed Claude verification

The browser launched a Claude SDK session, received a native Bash permission request, rendered it as pending, accepted **Allow once**, streamed the tool lifecycle, and received the final response.

Dogfooding exposed three runtime edge cases and drove fixes:

1. Claude Code 2.1.220 can emit a terminal SDK result without a later `session_state_changed(idle)` event. Agent Manager now uses a guarded terminal fallback only when pending requests, queued/outstanding input, buffered input, queue uncertainty, and background tasks are all clear.
2. Claude rate-limit reset values can arrive as epoch seconds. They are now normalized before creating the ISO timestamp, so the UI shows the real 2026 reset time instead of 1970.
3. The SDK can omit the matching `status=null` event after reporting `status=requesting`. A terminal result now settles that stable activity item, so an idle session cannot retain a misleading Running card.

The Claude account reached its session limit during the final replay, which intentionally exercised the failure boundary. The terminal rate-limit result settled the managed session and every open activity item to idle/complete, removed Interrupt, preserved the failure details, and displayed `2026-08-04T00:20:00.000Z` as the reset time.

## Live transcript behavior

The activity stream was verified for:

- initial user and assistant messages
- partial assistant text
- reasoning summaries exposed by the provider
- command/tool start, progressive output, success, failure, and terminal turn state
- file changes and patches
- plan changes
- token and cost usage
- queue transitions
- subagent and lifecycle events
- pending permissions and structured user questions

Events are revisioned and replayable. The client applies immutable upserts, retains scroll position while the user reads older output, and offers **Jump to live** when new activity arrives below the viewport.

Hidden provider chain-of-thought is not exposed. The cockpit renders only reasoning or summaries the provider actually publishes.

## Mobile verification

At a 390 x 844 viewport, the browser verified:

- the transcript remains visible instead of collapsing to an empty pane
- Markdown headings and lists render correctly
- the composer remains reachable
- a pending multi-choice question fits in a scrollable tray above the composer
- new live updates do not pull the reader away from older content
- **Jump to live** moves to the latest queued follow-up and its response

## Security and operational checks

- The service binds only to `127.0.0.1`; remote access is provided by Tailscale Serve.
- Browser control is authenticated, session leases are explicit, and control was released after dogfooding.
- Provider response bodies remain ephemeral rather than being written to SQLite.
- Streaming redaction handles secrets split across provider chunks and uses separate source/display offsets.
- Replay cursors are session-bound and the SSE client cap prevents accidental duplicate live consumers.
- No browser console errors were present in the final desktop or mobile pass.

## Evidence

Selected screenshots:

- `screenshots/02-codex-launch-dialog.png` - managed launch form
- `screenshots/05-codex-live-turn-started.png` - activity visible before completion
- `screenshots/06-codex-live-tool-running.png` - live tool lifecycle
- `screenshots/07-codex-progressive-output.png` - progressive command output
- `screenshots/08-codex-final-expanded.png` - completed verbose turn
- `screenshots/09-mobile-pending-answer.png` - structured answer UI on mobile
- `screenshots/10-mobile-live-transcript.png` - mobile live transcript
- `screenshots/11-claude-tool-running.png` - Claude permission/tool execution
- `screenshots/14-assistant-ui-ready-codex.png` - assistant-ui Markdown on desktop
- `screenshots/16-mobile-assistant-ui-markdown.png` - assistant-ui Markdown on mobile
- `screenshots/17-mobile-managed-followup.png` - preserved scroll position and new-update affordance
- `screenshots/18-mobile-followup-live.png` - successful managed follow-up
- `screenshots/19-claude-idle-rate-limit-fixed.png` - regression capture that exposed the last stale request-status card while the session itself was already idle
- `screenshots/20-claude-terminal-fully-settled.png` - final replay with the session and all request activity fully settled

`videos/codex-live.webm` and `screenshots/03-codex-midrun.png` preserve an earlier harness mistake where a second tab exceeded the deliberate one-SSE-client limit. They are retained as diagnostic evidence and are not used as release proof.

## Known boundary

Manager-owned provider processes are currently held in the cockpit service's memory. A full cockpit service restart does not yet rehydrate control of those processes, although provider transcript sessions remain discoverable as external sessions. Normal browser reloads and reconnects do not require a service restart.
