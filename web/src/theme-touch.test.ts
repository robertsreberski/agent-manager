import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
  jsdom evaluates no media query and computes no layout, so these contracts
  cannot be asserted by rendering. They are read off the stylesheet and the
  component source instead — which is also where they were lost: the coarse
  pointer block promoted every opted-in control to a 44px square, and three
  controls never opted in at all.
*/

const styles = readFileSync(resolve(process.cwd(), "web/src/styles.css"), "utf8");

function block(selector: RegExp): string {
  const match = styles.match(selector);
  expect(match?.[0], selector.source).toBeDefined();
  return match![0];
}

const coarse = styles.slice(styles.indexOf("@media (hover: none), (pointer: coarse)"));

describe("touch targets", () => {
  it("grows an icon control in both directions and a labelled control only in height", () => {
    // A text button whose width is its label sits in `overflow-x-auto` rows —
    // the scope tabs and host chips. Forcing 44px of width on each pushed the
    // header filter strip into sideways scrolling on every phone.
    expect(block(/\[data-compact-control\]\s*\{[^}]+\}/u)).toContain("min-width: var(--touch-target)");
    const heightOnly = block(/\[data-compact-control="height"\]\s*\{[^}]+\}/u);
    expect(heightOnly).toContain("min-width: 0");
    expect(heightOnly).toContain("min-height: var(--touch-target)");
  });

  it("gives every control a touch floor of its own", () => {
    for (const [file, marker] of [
      ["web/src/components/session-thread.tsx", "Why is this read-only?"],
      ["web/src/components/system/SystemStates.tsx", 'aria-label="Browse folder path"'],
    ] as const) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      const line = source.split("\n").find((candidate) => candidate.includes(marker));
      expect(line, `${file} · ${marker}`).toContain("data-compact-control");
    }
  });
});

describe("iOS field zoom", () => {
  it("floors every text field at 16px under a coarse pointer", () => {
    // Safari zooms the page when a focused field is under 16px and never zooms
    // back out. Every field in the cockpit was under it — the composer at 15px,
    // a path input at 11.5px — so one tap left the board magnified for good.
    expect(coarse).toContain("font-size: max(16px, 1em)");
    expect(coarse).toMatch(/textarea/u);
    expect(coarse).toMatch(/input:not\(\[type="checkbox"\]\)/u);
  });

  it("leaves the boxes a checkbox and a radio draw alone", () => {
    expect(coarse).toContain('input:not([type="checkbox"]):not([type="radio"])');
  });
});

describe("safe areas on the phone surface", () => {
  it("insets the full-screen drawer itself, since it covers the header that had them", () => {
    const drawer = readFileSync(resolve(process.cwd(), "web/src/components/board/ThreadDrawer.tsx"), "utf8");
    const lines = drawer.split("\n");
    for (const region of ["data-thread-header", "data-thread-content", "data-thread-composer"]) {
      // The attribute and the class list are not always on the same line.
      const at = lines.findIndex((candidate) => candidate.includes(region));
      const element = lines.slice(Math.max(0, at - 2), at + 2).join("\n");
      expect(element, region).toMatch(/env\(safe-area-inset-(left|right|top)\)|safe-area-bottom/u);
    }
    expect(drawer).toContain("env(safe-area-inset-top)");
  });

  it("contains rubber-band inside the two phone scrollers", () => {
    for (const [file, marker] of [
      ["web/src/components/board/ThreadDrawer.tsx", "data-thread-content"],
      ["web/src/components/board/PhoneBoardBands.tsx", "data-phone-board"],
    ] as const) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      const line = source.split("\n").find((candidate) => candidate.includes(marker));
      expect(line, marker).toContain("overscroll-contain");
    }
  });
});
