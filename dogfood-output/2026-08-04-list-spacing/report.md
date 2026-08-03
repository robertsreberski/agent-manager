# Markdown list-spacing regression

Date: 2026-08-04  
Severity: low  
Category: visual / responsive typography

## Issue

Assistant Markdown lists showed excessive blank space before, after, and between bullets. The message wrapper used `white-space: pre-wrap`; the Markdown renderer's formatting newlines therefore became visible line boxes between `<li>` elements. List and item margins added further spacing.

Evidence: `screenshots/01-before-desktop.png`

## Fix

The assistant-ui Markdown root now restores normal HTML whitespace collapsing. List block margins were reduced from 8px to 4px, item margins from 4px to 2px, and paragraph margins inside list items are suppressed.

For the same seven-item desktop list:

- Before: 488px list height
- After: 252px list height
- Wrapped list-item text retains the existing 24px line height

Evidence:

- `screenshots/02-browser-style-probe.png` - browser-only whitespace probe
- `screenshots/03-after-desktop.png` - rebuilt desktop result
- `screenshots/04-after-mobile.png` - rebuilt 390 x 844 result

## Verification

- 71 web tests pass, including assertions for the compact Markdown classes
- TypeScript check passes
- Production server and web builds pass
- Browser console and page errors are empty
- Local health endpoint returns healthy
- Tailscale health endpoint returns HTTP 200
