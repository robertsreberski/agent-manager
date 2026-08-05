# 13 — Ruthless cutover and simple deployment

**Status:** Accepted · **Applies to:** every implementation slice

## Rule

This is a pre-prototype personal tool with no compatibility obligation. When a slice replaces a
contract, component, storage shape, or control path, delete the old one in that slice. Do not add
deprecation annotations, legacy aliases, dual readers/writers, schema migrations, backup trees,
feature flags, dormant supervisors, or “temporary” second timelines.

## Contract and state reset

- Server, web, and remote nodes use one shared strict wire schema and required epoch. Delete
  duplicated type definitions, defensive old-shape normalization, and aliases for ownership,
  activity/status, lifecycle/runtime, attention/waiting reason, mode/access, and transcript
  messages.
- Delete config v1→v2 and SQLite v1/v2→v3 migrations and all permissive normalization branches.
- On the incompatible cutover, validate and remove only Agent Manager-owned
  `~/Library/Application Support/agent-manager/config.json`, `state.sqlite` plus its SQLite sidecar
  files, and obsolete Agent Manager browser caches. Recreate current state. Do not back it up.
- Never reset provider transcripts, provider settings/hooks, credentials, repositories,
  worktrees, tmux state, or the user's Codex daemon.

## Product code removals

### Web structure

- Delete `session-sidebar.tsx`, sidebar layout tokens/tests, host-grouped list, legacy badges, and
  old rounded/emerald variants. The board and drawer replace them.
- Delete `launch-dialog.tsx`, its tests, advanced launch options, and any duplicate draft/session
  placeholder. Keep only the bounded workspace resolver and idempotent first-send machinery.
- Delete the “Needs you” banner/sheet. Exact request forms live inline; board/mobile state finds
  them.
- Delete the `session.messages`/`ConversationMessage` rendering path, transcript DTO payload, dual
  empty/follow/truncation states, and `hasSnapshot` source switch. Every origin projects into one
  selected-session activity store; transcript failure is a lifecycle item.
- Delete the merged plan/checklist type and `PlanRow`; plan artifacts and todos are distinct.
- Decompose `use-cockpit` before adding board/draft state. Authentication, snapshots/SSE, board
  navigation, selected activity, and mutations each get bounded ownership; no new/modified file
  exceeds roughly 600 lines without a recorded reason.

### Controls and safety surfaces

- Delete `planning | execution`, `set-mode`, `accessMode`, `effectiveAccess`, `set-access`, and
  all mapping/normalization code. One `ExecutionProfile` and `set-profile` replace them. The
  Codex `SandboxPolicy` and `set-sandbox` added later are a distinct containment setting, not a
  revival of the removed access mode: the removed vocabulary stays gone.
- Delete every routine lease affordance/string/disabled condition. Retain only the internal
  writer coordinator and conflict/takeover outcome.
- Delete the obsolete global control-stop feature completely: CLI/parser/help, sentinel and
  persistence, owner-socket request, server middleware/status/error, transport shutdown path,
  UI/banner/style, tests, README, and security claims. Do not replace it with another switch.
- Delete browser-supplied executable/argv editor concepts and any raw provider attach command.

### Discovery and providers

- Move useful bounded observation out of root `agent-sessions.ts` into focused
  `src/discovery/scan/**` modules, split its tests, then delete the root script and
  `agent-manager list` passthrough. The scanner is a real observe-only degradation path, not a
  compatibility CLI.
- Delete `source: "legacy"`; use explicit transcript inferred/heuristic provenance.
- After spec 02's gate, delete either all private Codex supervisor/spawn/socket lifecycle or all
  shared-daemon production code. Exactly one managed Codex authority remains.
- Delete unconditional/fake Codex settings calls and deprecated file-change output-delta
  handling. The experimental settings request exists only behind the pinned experimental schema,
  with method-withdrawal and next-turn fallback tests.
- Delete the public selected-activity REST history endpoint and tests. It only pages the bounded
  in-memory window and cannot provide real backscroll; selected-session SSE plus a retention
  boundary is the contract.

### Repository and dependencies

- Remove tracked `dogfood-output/` and ignore future output. Do not preserve it as a release
  asset or move it elsewhere in the repository.
- Remove every unused dependency, including `@fastify/cookie` and `ws` typings/runtime if the
  final import audit confirms no production import. Re-add only with the first real consumer.
  **The Radix packages are no longer in this set.** They were pruned as unused, which locked the
  app into hand-rolling every overlay; they have since been re-added *with* their consumers, as
  spec 12 R11 requires. Each of `@radix-ui/react-{dropdown-menu,dialog,tooltip,select,checkbox,radio-group,collapsible,slot}`,
  `cmdk` and `class-variance-authority` backs `web/src/components/ui/`, which the app imports
  throughout. An import audit will find them used — do not prune them.
- Remove obsolete generated web asset generations. Fix the PWA asset command to the actual
  `web/src/pwa` location and include woff2 fonts.
- Add an exact package `files` allowlist containing runtime dist/assets, required metadata, and
  nothing else. Source, tests, specs, dogfood, stale assets, and local state never enter the host
  install tarball. The post-build pack gate requires the three bundled font files and their
  licenses, rejects source maps, and caps the compressed tarball at 750,000 bytes.

## CLI, build, and deploy

Keep the personal workflow deliberately small:

```text
pnpm dev       start the development cockpit
pnpm check     typecheck, tests, builds, and static contract/package checks
pnpm deploy    clean build, install/reload the local LaunchAgent, await health, open fresh auth
```

- `agent-manager` with no arguments opens the cockpit. Unknown options fail; there is no
  option-first alias to a list script.
- Web build stages a complete asset directory and atomically replaces the previous one. It never
  overlays new chunks onto old chunks.
- Local and remote startup exchange wire/build epoch before state. Mismatch fails closed and
  tells the owner to run the same simple install/deploy command; there is no rolling-compat mode.
- `host install <target>` may package the current allowlisted build for an explicitly named host.
  It is not a release process.
- Delete publish/tag/changelog/release-branch/version-bump/rollback-archive automation and docs.
  No npm publish or GitHub release is part of completion.

## Acceptance criteria

1. Repository searches find no global stop/sentinel feature, old mode/access contract, migration/legacy alias,
   duplicate timeline, launch dialog/sidebar, root listing script, or fake settings RPC.
2. Reset tests prove only exact Agent Manager-owned config/SQLite/cache targets are removed and
   provider settings/transcripts are untouched.
3. There is one shared strict wire type set, one activity pipeline, and exactly one managed Codex
   authority: `codex-private`.
4. Import/dependency analysis finds no unused direct dependency. `npm pack --dry-run` contains
   only the allowlist and stays below the recorded package budget.
5. Repeated web builds contain one current asset graph and no stale hashed chunks. A client/node
   with the wrong epoch fails closed.
6. `pnpm check` and `pnpm deploy` are sufficient to validate and install the tool locally; health
   and authenticated browser smoke pass without a release ceremony.
7. Static checks inspect AST/rendered strings where appropriate; broad word searches do not fail
   on internal lease implementation or ordinary English words.
