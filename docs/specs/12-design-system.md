# 12 — Design system

**Status:** Accepted · **Depends on:** nothing · **Blocks:** every web phase
**Design reference:** the token table in the handoff README; values reproduced here.

## Purpose

The token, type, icon and motion layer everything else builds on. First phase, because every
later phase either uses these tokens or hardcodes a literal that has to be found and removed
later.

## Requirements

### R1 — Dark only

The redesign is drawn on a single dark canvas. Retire the light palette and the media-query dark
variant in `web/src/styles.css:3-7`:

```css
@custom-variant dark { @media (prefers-color-scheme: dark) { @slot; } }
```

Delete the variant and the light block (`:9-49`); promote the redesign's values to `:root`.
Update `<meta name="color-scheme">` and the dual `theme-color` tags in `web/index.html:5-8` to
the single dark value.

This is a real reduction in scope, and it is the right one: the design was not drawn for light,
and a derived light palette would be a guess presented as a design.

### R2 — Tokens

Keep Tailwind v4's CSS-first `@theme inline` approach (`styles.css:88-118`) — no JS config. Map
every token below to a `--color-*`.

```
ground            #08080a            document / canvas behind frames
app               oklch(0.12 0 0)
raised            oklch(0.145 0 0) → oklch(0.155 0 0) → oklch(0.165 0 0)
menu              oklch(0.2 0 0)
selected row      oklch(0.21 0 0) / oklch(0.22 0 0) / oklch(0.25 0 0)
hairline          oklch(0.165 0 0) inside · oklch(0.19 0 0) · oklch(0.22 0 0) frame
border            oklch(0.24 0 0) → oklch(0.26 0 0)

text              oklch(0.95 0 0)
text secondary    oklch(0.72 0 0)
text muted        oklch(0.56 0 0) → oklch(0.5 0 0)
text faint        oklch(0.44 0 0) → oklch(0.4 0 0)

accent (lime)     oklch(0.85 0.16 118)    on ink oklch(0.16 0.03 118)
accent quiet      oklch(0.62 0.1 118)     links, inline actions
wants-you field   oklch(0.185 0.022 118)  outline oklch(0.4 0.09 118)

amber (warn)      oklch(0.78 0.13 70)     field oklch(0.17 0.022 70)
amber (dirty)     oklch(0.72 0.12 75)
orange (access)   oklch(0.78 0.14 45)     field oklch(0.2 0.05 40)
red (danger)      oklch(0.62 0.16 25)     field oklch(0.155 0.014 25)
violet (remote)   oklch(0.72 0.11 290)    dim oklch(0.58 0.04 290)
green (added)     oklch(0.78 0.14 145)    field oklch(0.26 0.09 145 / 0.28)
red (removed)                             field oklch(0.3 0.11 25 / 0.24)
```

### R3 — The accent means exactly one thing

Lime is **"wants you"**. It is also the primary-button colour (New thread, Execute this plan,
Send), which is consistent — those are the operator's own actions — but it must never mark
*status* other than wants-you.

Working is grey. Failed is red. Idle is dimmer grey. **Nothing else is lime**, except the tiny
linked-worktree branch glyph specified by frame 7a as a narrow identity marker. The moment lime
appears on a running session, the board stops being scannable, which is its only job.

The previous emerald primary is retired entirely (spec 13).

### R4 — Semantic colours are not decoration

| Colour | Means | Never |
| --- | --- | --- |
| lime | wants you; operator's own primary action | any other status |
| amber | warning; uncommitted changes | errors |
| orange | non-standard access | warnings |
| red | danger; outside the workspace; failed | anything routine |
| violet | remote host; subagent | local anything |
| green | added lines | success generally |

### R5 — Radius

```
0        cards, chips, blocks, diffs
6px      frames
16px     composer
9999px   round buttons and pills
12px     message bubbles, with bottom-right 4px
```

Square-by-default is a deliberate character choice — the current app rounds everything at
`--radius: 0.625rem`. Do not carry that default forward.

### R6 — Type, self-hosted

```
Instrument Sans  400 / 500 / 600
IBM Plex Mono    400 / 500

display     26 / 24 / 20px  600  letter-spacing -0.02em
title       17 / 16 / 15px  600  letter-spacing -0.015em
card title  13.5px          600  letter-spacing -0.01em
body        15 / 14px       400  line-height 22px
secondary   13 / 12.5px     400  line-height 18–20px
mono        12.5 / 11.5 / 11px  400
eyebrow     10px  500 mono, uppercase, letter-spacing 0.14em
```

**Self-host as woff2 in `web/public/fonts/`.** The design files load Google Fonts; the app cannot:

- CSP is `default-src 'self'; connect-src 'self'` (`src/server/server.ts:89-98`) — an external
  stylesheet and font host would be blocked.
- The app is offline-capable, and a font that only loads online is not a font.
- A loopback daemon making requests to a third party on page load is a privacy regression this
  project would not otherwise accept.

Subset to Latin, `font-display: swap`, preload the two weights used above the fold. Check the
licences (both are OFL) and record them in `web/public/fonts/LICENSE`.

The PWA precache route policy and Vite PWA glob must include `.woff2`; today the glob omits fonts.

### R7 — Spacing and targets

```
frames      24–32px
sections    20–28px
rows        6–14px
control gap 14px
chip gap    6–8px

targets     desktop 26–32px · phone 44–48px minimum
```

The coarse-pointer rule already in `styles.css:236-241` (`[data-compact-control]` gets
`--touch-target`) generalises to this and should be kept.

### R8 — Shadows

```
0 30px 100px rgb(0 0 0 / 0.7)    frames
-50px 0 120px rgb(0 0 0 / 0.8)   drawer
0 24px 60px rgb(0 0 0 / 0.65)    menus
0 12px 34px rgb(0 0 0 / 0.55)    toasts, notifications
```

### R9 — Motion is restrained, and respects the setting

```
pIn     0.14–0.18s ease-out   overlays, selection bar — 4–6px rise plus fade
spin    0.9s linear           loaders
pulse   1.6–1.8s ease-in-out  indeterminate progress, skeletons
```

**Nothing else moves.**

The global `prefers-reduced-motion` kill-switch in `styles.css:243-252` stays, and so do its two
JS reinforcements in the thread (`session-thread.tsx:234-235`, `:645-646`) — the drawer and the
board's auto-follow both need the JS check, since scroll behaviour is not covered by CSS.

### R10 — Icons

Lucide, **stroke width 1.75**, via `lucide-react@1.28.0` (already a dependency). Do not inline
the SVGs from the design bundle; they are there so the mocks render standalone
(`docs/design/cockpit/NOTES.md`).

`history` no longer exists in Lucide — the revisions affordance (spec 08 R5) uses `rotate-ccw`.

### R11 — Component layer

**Status: satisfied.** This requirement previously described `web/src/components/ui/` as "a
hand-rolled shadcn-lite (button, badge, input, textarea, alert, dialog, sheet)". That was never
true — the directory existed but was empty, so every menu, dialog, sheet, palette, tooltip,
select and checkbox was hand-rolled in place, along with a private focus trap, a modal-layer
registry and six separate Escape handlers.

`web/src/components/ui/` now holds real Radix-backed shadcn primitives: `button`, `badge`,
`separator`, `collapsible`, `dialog`, `sheet`, `tooltip`, `dropdown-menu`, `select`, `checkbox`,
`radio-group`, `command`. The rule this requirement actually encodes still stands and is
unchanged: **re-add a package in the same slice as its first production import rather than
reserving dependencies for future screens.** Each installed Radix package has a real consumer;
none is reserved.

**Every colour in this layer is a token** — no `amber-500`-style literals. Variants are named for
their *meaning* (`Badge tone="warning" | "danger" | "remote" | "added"`), not their colour, so a
wrong badge reads wrong in review. `Button variant="primary"` is the only lime variant, and R3
governs it: lime is "wants you" and the operator's own action, never any other status.

## Removals (spec 13)

The light palette and `@custom-variant dark` (R1) · sidebar layout tokens `--scope-rail-*`,
`--session-list-width` · every hardcoded Tailwind colour literal · the emerald
primary (R3).

## Acceptance criteria

1. `grep -rE "(amber|red|emerald|blue|green|violet)-[0-9]{3}" web/src` returns nothing.
2. No `@media (prefers-color-scheme` remains in `web/src`; `<meta name="color-scheme">` is `dark`.
3. Fonts load from `web/public/fonts/` with no external request; verified with the CSP enforced
   and the network offline.
4. Fonts are precached by the service worker and the app renders correctly on a cold offline load.
5. Lime appears only on wants-you status and primary actions — auditable by grepping the accent
   token's usages.
6. `prefers-reduced-motion` suppresses `pIn`, spin, pulse, and both JS smooth-scroll paths.
7. `web/src/components/ui/` is internally consistent; no component defines a colour outside the
   token set.
8. A visual pass against `docs/design/cockpit/Cockpit Prototype.dc.html` at 1440 × 900 and
   390 × 844.
9. Ship Instrument Sans 400/500/600 and IBM Plex Mono 400/500 as Latin-subset woff2 files. The
   visual type contract takes precedence over speculative cold-load trimming; package size is
   enforced by the final allowlist instead.
