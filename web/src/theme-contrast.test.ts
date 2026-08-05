import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "web/src/styles.css"), "utf8");

/** Linear-light sRGB for either notation the token layer uses. */
function linearRgb(value: string): [number, number, number] {
  const hex = value.match(/^#([0-9a-f]{6})$/iu);
  if (hex?.[1]) {
    const channels = [0, 2, 4].map((offset) => Number.parseInt(hex[1]!.slice(offset, offset + 2), 16) / 255);
    return channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) as [number, number, number];
  }
  const oklch = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/u);
  if (!oklch) throw new Error(`Unsupported colour notation: ${value}`);
  const lightness = Number(oklch[1]);
  const chroma = Number(oklch[2]);
  const hue = Number(oklch[3]) * Math.PI / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const long = (lightness + (0.3963377774 * a) + (0.2158037573 * b)) ** 3;
  const medium = (lightness - (0.1055613458 * a) - (0.0638541728 * b)) ** 3;
  const short = (lightness - (0.0894841775 * a) - (1.2914855480 * b)) ** 3;
  return [
    (4.0767416621 * long) - (3.3077115913 * medium) + (0.2309699292 * short),
    (-1.2684380046 * long) + (2.6097574011 * medium) - (0.3413193965 * short),
    (-0.0041960863 * long) - (0.7034186147 * medium) + (1.7076147010 * short),
  ].map((channel) => Math.min(1, Math.max(0, channel))) as [number, number, number];
}

function token(name: string): string {
  const match = styles.match(new RegExp(`--${name}:\\s*([^;]+);`, "iu"));
  if (!match?.[1]) throw new Error(`Missing token --${name}`);
  return match[1].trim();
}

function relativeLuminance(value: string): number {
  const [red, green, blue] = linearRgb(value);
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrast(foreground: string, background: string): number {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

describe("subdued cockpit text", () => {
  // The handoff's ladder is 0.95 / 0.72 / muted / faint. Anchoring every tier to
  // the lightest surface in the theme forced both subdued tiers so bright that
  // they became indistinguishable, which is a worse readability outcome than the
  // contrast number suggested. Each tier is checked against the surfaces it is
  // actually rendered on instead.
  const readingSurfaces = ["app", "surface-raised"] as const;

  it("keeps muted body text at WCAG AA on the surfaces it is rendered on", () => {
    for (const surface of readingSurfaces) {
      expect(contrast(token("text-muted"), token(surface)), surface).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps faint incidental text legible, and never promotes it to a sole source of a fact", () => {
    // Faint carries timestamps, key hints and counts that always sit beside the
    // same fact in a stronger tier, so it follows the mock rather than AA. It
    // still may not fade into the surface.
    for (const surface of readingSurfaces) {
      expect(contrast(token("text-faint"), token(surface)), surface).toBeGreaterThanOrEqual(2.5);
    }
  });

  it("keeps the four tiers visibly separated", () => {
    const ladder = ["text", "text-secondary", "text-muted", "text-faint"].map((name) => relativeLuminance(token(name)));
    for (let tier = 1; tier < ladder.length; tier += 1) {
      const brighter = ladder[tier - 1]!;
      const dimmer = ladder[tier]!;
      expect(dimmer, `tier ${tier}`).toBeLessThan(brighter);
      // A tier that is merely 1.2x its neighbour reads as the same grey.
      expect((brighter + 0.05) / (dimmer + 0.05), `tier ${tier} separation`).toBeGreaterThanOrEqual(1.35);
    }
  });
});

/*
  The accent's scope was widened deliberately (issue #4). The frames fill the
  composer's harness tile and effort bars lime, tick an offered capability lime,
  and light the connection dot lime; the implementation had held all of them
  neutral on the reading that the accent "must mean exactly one thing".

  What still may not happen is the accent standing in for *state that the board
  is scanned for*. A lime session card, assistant bubble or plan artifact would
  make "this session wants you" and "this session exists" the same glance, and
  the board's only job is that distinction.
*/
describe("lime accent semantics", () => {
  it("does not decorate assistant identity or plan state", () => {
    const decorationFiles = [
      "web/src/components/session-thread.tsx",
      "web/src/components/plans/PlanArtifact.tsx",
      "web/src/components/plans/PlanDocumentView.tsx",
    ];
    for (const file of decorationFiles) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      const nonActionSource = source
        .replaceAll("bg-[var(--accent)]", "")
        .replaceAll("text-[var(--accent-ink)]", "")
        .replaceAll("focus:border-[var(--accent)]", "");
      expect(nonActionSource, file).not.toContain("var(--accent)");
    }
  });

  it("keeps the board's own wants-you signal unambiguous", () => {
    // A card tinted for any reason other than wanting the operator would cost
    // the board the one distinction it exists to make.
    const card = readFileSync(resolve(process.cwd(), "web/src/components/board/SessionCard.tsx"), "utf8");
    const accentUses = card.match(/var\(--accent[^)]*\)/gu) ?? [];
    for (const use of accentUses) {
      expect(card, use).toMatch(/wants-you|attention/u);
    }
  });

  it("keeps privacy identity neutral", () => {
    const privacyMark = styles.match(/\.app-privacy-cover__mark\s*\{[^}]+\}/u)?.[0];
    expect(privacyMark).toBeDefined();
    expect(privacyMark).not.toContain("var(--accent)");

    const thread = readFileSync(resolve(process.cwd(), "web/src/components/session-thread.tsx"), "utf8");
    const assistant = thread.match(/<MessagePrimitive\.Root(?=[^>]*data-assistant-message)[^>]*>/u)?.[0];
    expect(assistant).toBeDefined();
    expect(assistant).not.toContain("var(--accent)");
    const user = thread.match(/<MessagePrimitive\.Root(?=[^>]*data-user-message)[^>]*>/u)?.[0];
    expect(user).toBeDefined();
    expect(user).not.toContain("var(--accent)");
  });
});

/*
  `--text-faint` is deliberately below WCAG AA. That is only defensible while it
  carries incidental metadata — a timestamp, a key hint, a count — that always
  appears beside the same fact in a stronger tier. The numeric test above cannot
  see whether that holds; an audit found roughly thirty-five places where faint
  was in fact the only rendering of a fact an operator had to read, and this is
  the guard that keeps them promoted.
*/
describe("faint is never the sole source of a fact", () => {
  const soleSourceFacts = [
    // Turn end time, duration, tokens and cost exist nowhere else.
    ["web/src/components/thread/TurnMarker.tsx", "border-[var(--border-hairline)] pt-[11px]"],
    // The only statement of what a collapsed tool call touched.
    ["web/src/components/thread/GroupedActivityParts.tsx", "data-tool-detail"],
    // Diff line numbers, hunk position, and the unpressed state of a real control.
    ["web/src/components/diffs/DiffViewer.tsx", 'data-diff-gutter="old"'],
    ["web/src/components/diffs/DiffViewer.tsx", "{hunk.header}"],
    ["web/src/components/diffs/DiffViewer.tsx", "counts unavailable"],
    ["web/src/components/diffs/DiffReview.tsx", "counts unavailable"],
    // What Enter will do, and the queue's semantics.
    ["web/src/components/composer/SessionComposer.tsx", "queues while running"],
    ["web/src/components/composer/QueuedMessages.tsx", "sends when this turn ends"],
    // The keyboard affordance for answering a blocking request.
    ["web/src/components/requests/ApprovalRequest.tsx", "{shortcutHint}"],
    ["web/src/components/requests/QuestionRequest.tsx", "{pickHint}"],
    // The file an operator has to inspect, and why a harness is unavailable.
    ["web/src/components/system/SystemStates.tsx", "{hook.settingsPath}"],
    // "No inline fallback is substituted" is the only explanation on that panel.
    ["web/src/components/plans/PlanDocumentView.tsx", "No inline fallback is substituted"],
    ["web/src/components/plans/PlanDocumentView.tsx", "no preserved revision history reported"],
    // Where to act on a request the cockpit cannot represent.
    ["web/src/components/session-activity.tsx", "Open the native harness to respond"],
    // The browser notification permission state.
    ["web/src/App.tsx", "permission: {permission}"],
    // On a phone this subtitle replaces the desktop badge row entirely.
    ["web/src/components/board/ThreadDrawer.tsx", "fact.label).join"],
    // The only disambiguator between two same-named sessions.
    ["web/src/components/palette/CommandPalette.tsx", "{entry.detail}"],
  ] as const;

  it("renders each audited sole-source fact in a tier that clears AA", () => {
    for (const [file, marker] of soleSourceFacts) {
      const lines = readFileSync(resolve(process.cwd(), file), "utf8").split("\n");
      const at = lines.findIndex((line) => line.includes(marker));
      expect(at, `${file} · ${marker}`).toBeGreaterThanOrEqual(0);
      // JSX here is dense: a wider window would sweep in the neighbouring
      // timestamps and chevrons that are still legitimately faint. Only the
      // marker's own line counts, extended back one line when the class list
      // sits above the text it styles.
      const own = lines[at]!;
      const element = own.includes("className") ? own : `${lines[at - 1] ?? ""}\n${own}`;
      expect(element, `${file} · ${marker}`).not.toContain("var(--text-faint)");
    }
  });
});
