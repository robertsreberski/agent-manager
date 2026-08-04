import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "web/src/styles.css"), "utf8");

function token(name: string): string {
  const match = styles.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "iu"));
  if (!match?.[1]) throw new Error(`Missing six-digit hex token --${name}`);
  return match[1];
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red = 0, green = 0, blue = 0] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrast(foreground: string, background: string): number {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

describe("subdued cockpit text", () => {
  it("keeps both hierarchy tiers at WCAG AA contrast on the lightest dark surface", () => {
    // --surface-selected-active resolves to #222 at its achromatic OKLCH value.
    expect(contrast(token("text-muted"), "#222222")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("text-faint"), "#222222")).toBeGreaterThanOrEqual(4.5);
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
