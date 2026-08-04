# Vendored design reference

Source: Claude Design project `a0b32ff3-d4e1-42f0-968a-2f70c933de57`
(`https://claude.ai/design/p/a0b32ff3-d4e1-42f0-968a-2f70c933de57`), fetched 2026-08-04
via the `claude_design` MCP (`DesignSync`).

These files are the **normative acceptance reference**. Every web phase is checked against
its frame here, not against a description of it.

## What is here

| File | What it is |
| --- | --- |
| `Cockpit Redesign.dc.html` | Every screen as a labelled frame, grouped into numbered turns, newest first. Each option carries a badge id (`14a`, `10b`…) and a caption explaining the reasoning. **Truncated — see below.** |
| `Cockpit Prototype.dc.html` | The core loop, clickable: scopes, host filters, board, thread drawer, question answering, approvals, palette, menus, queue, multi-select, shortcuts. Complete. |

Frames are marked in the DOM with `data-screen-label`. Open the files directly in a browser.

## The redesign file is truncated — read this before trusting it

`Cockpit Redesign.dc.html` is **264 KB at source and `DesignSync.get_file` caps at 256 KiB**.
The file is ordered newest-turn-first, so the truncation drops the *tail*, which is the
*oldest* turns. What survived, and what did not:

| Turns | Frames | Status |
| --- | --- | --- |
| 15 → 8 | `15a` `15b` `14a` `14b` `13a-1` `13a-2` `13b` `13c` `12a` `12b` `11a` `11b` `10a` `10b` `9a-1`…`9a-5` `9b` `8a` | Present |
| 7 → 4 | Board (`7a`), composer (`5a`), question/queue (`6a` `6b`), thread drawer (`4a` `4b`) | **Missing — cut by the cap** |

The missing four turns are the most structural screens in the whole redesign. They are
recoverable in full from **`Cockpit Prototype.dc.html`**, which carries the same screens as a
working prototype and is complete at 64 KB. Read the board, drawer, composer and question
markup from the prototype; read everything from turn 8 upward from the redesign file.

Frame `8a` (approvals) sits at the truncation boundary and ends mid-element. Its content is
also present in the prototype.

## Files deliberately not vendored

- **`icons/`** — 70 Lucide SVGs. The handoff says explicitly: *"Use `lucide-react` in the app
  rather than these files."* `lucide-react@1.28.0` is already a dependency. Note that `history`
  no longer exists in Lucide; the revisions affordance uses `rotate-ccw`.
- **`Cockpit Current.dc.html`** — the interface as it is today, rebuilt from `web/src`. It is a
  "before" picture for comparison, and `web/src` itself is a better source of that truth.
- **`support.js`** — the design-canvas rendering runtime (`dc-runtime`). Carries no design
  content; it is the machinery that makes the `.dc.html` files render standalone.
- **`README.md` / `github.md`** — the handoff prose. Its decision-bearing content is distilled
  into `docs/specs/`, which is where it belongs: the specs are the thing implementers work from,
  and duplicating the handoff would create two sources of truth that drift. Fetch the originals
  from the design project when you need the author's exact wording.

## How to read the design files

The handoff states its own fidelity level: **high**. Colours, type, spacing and interaction
states are final and should be recreated closely. Inline styles in these files exist only so
the design streams and renders standalone — they are **not** production code to copy. Build
with the repo's React 19 + Tailwind v4 + shadcn/ui + assistant-ui stack, and use a token from
`web/src/styles.css` wherever one matches rather than pasting a literal.

Two deliberate departures the handoff calls out, both resolved in `docs/specs/12-design-system.md`:

- Type is Instrument Sans + IBM Plex Mono in the mocks; the app used Inter.
- The accent is lime `oklch(0.85 0.16 118)` rather than the previous emerald. The accent
  carries the "wants you" state and must mean exactly one thing.
