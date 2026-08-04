# Agent Manager 0.3.0 release dogfood

Date: 2026-08-04  
Environment: macOS LaunchAgent, loopback HTTP behind private Tailscale Serve HTTPS  
Release candidate: `v0.3.0`

## Automated gate

- Strict application and build-publisher typechecks passed.
- Backend/CLI suite: 196 tests passed.
- Web suite: 123 tests passed.
- Server and production PWA builds passed.
- Staged web publishing retained old hashed assets, switched `index.html`
  atomically, exposed the service worker last, and removed its private stage.

## Deployed service

- The guarded restart found zero manager sessions created by the previous
  service generation and zero pending, dispatching, or queued writes.
- Only `local.agent-manager.cockpit` was restarted; its PID changed from 40208
  to 10182 and it remained bound to `127.0.0.1:43127`.
- Local and Tailscale `/api/v1/healthz` returned healthy responses.
- Root, current hashed JavaScript, manifest, and service worker returned 200.
- The current hashed asset is immutable; HTML and manifest revalidate; the
  service worker is `no-cache` with `Service-Worker-Allowed: /`.
- The production CSP permits only same-origin resources and contains no inline
  script or style exception.

## Managed Codex proof

A fresh standard-access Codex session named `v0.3.0 live proof` was created in
the configured `agent-manager` workspace through the deployed browser UI.

- The initial task was dispatched automatically and appeared in the transcript.
- While the turn was still marked Working, the live activity region was already
  present with a running turn group and shell tool row.
- A steering message sent during `sleep 20` interrupted the wait; the new user
  message appeared and the provider returned the exact `STEERED_OK` final.
- Planning and execution mode switches both round-tripped to the provider.
- In planning mode, a real `request_user_input` call produced a Needs you state
  with exact `provider-api` provenance and enabled Proceed/Stop controls.
- Selecting Proceed and sending the answer cleared Needs you and produced the
  exact `ANSWER_RECEIVED` final.
- The session returned to idle, and its browser control lease was explicitly
  released at the end of dogfooding.

## PWA and responsive proof

- Applying an update from a freshly reloaded tab exercised the lost-local-lease
  case: browser-session leases were released server-side, the waiting worker
  took control, and the update banner cleared only after takeover/reload.
- A warm offline transition retained the already-loaded snapshot as stale and
  disabled the composer with `Reconnect to continue`.
- An offline reload served the public shell with zero session rows. Recovery
  restored the selected session after connectivity returned.
- Cache Storage contained 14 public shell entries and no API, auth, event,
  action, health, source-map, or session route.
- Deployed layouts at 1440x900, 390x844, and 320x700 had no horizontal overflow.
  Navigation, transcript, live activity, composer, and Send remained reachable.
- Mobile action notices render below the safe-area-aware header and do not
  overlap the composer (`noticeBottom=102`, `composerTop=684.5`).

Screenshots:

- [390x844 managed transcript](screenshots/01-managed-mobile.png)
- [1440x900 compact cockpit](screenshots/02-managed-desktop.png)
- [320x700 narrow layout](screenshots/03-managed-narrow.png)

## Known runtime warning

Codex 0.146.0 passed its capability check. The host currently has Claude Code
2.1.221 while the pinned Agent SDK targets Claude Code 2.1.220, so Agent Manager
correctly keeps managed Claude semantic controls blocked until those versions
match. Existing Claude sessions remain discoverable/read-only according to
their reported capabilities.
