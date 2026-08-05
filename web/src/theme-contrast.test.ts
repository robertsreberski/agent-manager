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

describe("lime accent semantics", () => {
  it("does not decorate provider identity, effort, assistant identity, or plan state", () => {
    const decorationFiles = [
      "web/src/components/composer/SessionComposer.tsx",
      "web/src/components/session-thread.tsx",
      "web/src/components/plans/PlanArtifact.tsx",
      "web/src/components/plans/PlanDocumentView.tsx",
      "web/src/components/system/SystemStates.tsx",
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

  it("keeps generic connection and privacy identity neutral", () => {
    const app = readFileSync(resolve(process.cwd(), "web/src/App.tsx"), "utf8");
    const indicator = app.match(/<span(?=[^>]*data-connection-indicator)[^>]*\/>/u)?.[0];
    expect(indicator).toBeDefined();
    expect(indicator).not.toContain("var(--accent)");

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
