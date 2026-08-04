# Agent Manager 0.3.1 release dogfood

| Field | Value |
|-------|-------|
| **Date** | 2026-08-04 |
| **App URL** | `https://mickey-home.tail8a9beb.ts.net:9443/` |
| **Session** | `agent-manager-v031` |
| **Scope** | Managed Codex structured questions, live transcript delivery, lease handoff, and responsive UI |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| **Total** | **0** |

## Verification log

### Automated release gate

- `pnpm check` passed.
- Backend and CLI suite: 199 tests passed.
- Web suite: 125 tests passed.
- Strict TypeScript checks, server build, production web build, and injected
  PWA service-worker build passed.

### Deployed service

- Only `local.agent-manager.cockpit` was restarted. Its PID changed from
  `10182` to `33164` for live dogfooding, then to final PID `38752` after the
  release was rebuilt from the committed `0.3.1` version.
- The service remained bound to `127.0.0.1:43127`.
- Loopback and Tailscale `/api/v1/healthz` returned
  `{"ok":true,"locked":false}`.
- Loopback and Tailscale served the same current JavaScript asset,
  `assets/index-CS-DhgkM.js`.

### Managed Codex question flow

A fresh standard-access, planning-mode Codex session
`codex:019fcbad-ed96-76b0-82bf-2b408158c48b` was created from the deployed
browser UI in the configured `agent-manager` workspace.

- The initial task was dispatched automatically; the session entered Working
  and the exact user message appeared in live activity.
- Before the turn completed, the session changed to Needs you while its turn
  disclosure remained Running and its provider request showed Waiting.
- The inline card showed the `Random pick` header, the question once within the
  card, all three exact option labels and descriptions, and an explicit Other
  choice. No separate question sheet was required.
- The 390px layout had no horizontal overflow. Measured choice targets were
  56-72px tall, above the 44px touch target.
- Browser control was released before selection. Moon cabin remained
  selectable as a local draft, and the inline action changed to
  `Take control to answer`.
- After control was reacquired, the Moon cabin draft remained checked and the
  explicit Send action became available.
- Native radio keyboard behavior worked: Arrow Down selected Undersea hotel;
  Arrow Up returned selection to Moon cabin.
- Sending cleared the pending banner and inline form immediately. Codex resumed
  and returned exactly `ANSWER_RECEIVED: Moon cabin (Recommended)`.
- A second ordinary message was sent to the same managed session at 320x700.
  Its structured question also streamed inline, had no horizontal overflow,
  and returned exactly `NARROW_ANSWER_RECEIVED: Undersea hotel`.
- The final browser run had no page exceptions or console errors. The control
  lease was explicitly released, and the browser session was closed.

### Responsive evidence

- [Managed-session creation](screenshots/01-create-managed.png)
- [Desktop inline question](screenshots/03-inline-question-desktop.png)
- [390px question before selection](screenshots/04-mobile-question-before-draft.png)
- [390px draft without control](screenshots/05-mobile-draft-without-control.png)
- [390px reacquired control with preserved draft](screenshots/06-mobile-ready-to-send.png)
- [Pending request cleared after Send](screenshots/07-answer-submitted.png)
- [Exact answer received on mobile](screenshots/08-mobile-answer-received.png)
- [320px ordinary managed message](screenshots/09-narrow-message-ready.png)
- [320px inline question](screenshots/10-inline-question-narrow.png)

The retained WebM is a setup-only capture from the browser tool's duplicate-tab
recording probe; it is not issue evidence and was not used for pass/fail.

### Known host warning

Codex 0.146.0 passed its capability check. Claude Code 2.1.221 still differs
from the pinned Agent SDK target of Claude Code 2.1.220, so managed Claude
semantic controls correctly remain fail-closed. The doctor's port warning is
also expected while the healthy LaunchAgent owns `127.0.0.1:43127`.

## Issues

No reproducible issues were found in the scoped 0.3.1 question flow.
