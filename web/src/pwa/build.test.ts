import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";

function filesBelow(root: string, relative = ""): string[] {
  const directory = join(root, relative);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(relative, entry.name);
    return entry.isDirectory() ? filesBelow(root, path) : [path];
  });
}

function pngSize(path: string): [number, number] {
  const buffer = readFileSync(path);
  expect(buffer.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

it("builds a private prompt-update PWA without production source maps", async () => {
  const output = mkdtempSync(join(tmpdir(), "agent-manager-pwa-build-"));
  try {
    const repositoryConfig = join(process.cwd(), "web", "vite.config.ts");
    await build({
      configFile: existsSync(repositoryConfig)
        ? repositoryConfig
        : join(process.cwd(), "vite.config.ts"),
      logLevel: "silent",
      build: { outDir: output, emptyOutDir: true },
    });

    const files = filesBelow(output);
    expect(files).toContain("index.html");
    expect(files).toContain("manifest.webmanifest");
    expect(files).toContain("sw.js");
    expect(files.some((file) => /^assets\/index-[a-z0-9_-]{8,}\.js$/iu.test(file))).toBe(true);
    expect(files.some((file) => file.endsWith(".map"))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(output, "manifest.webmanifest"), "utf8")) as {
      id: string;
      scope: string;
      start_url: string;
      display: string;
      shortcuts: Array<{ url: string }>;
      icons: Array<{ src: string; sizes: string; purpose: string }>;
    };
    expect(manifest).toMatchObject({ id: "/", scope: "/", start_url: "/", display: "standalone" });
    expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual([
      "/?scope=wants-you",
      "/?draft=1",
    ]);
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: "/icon.svg", sizes: "any" }),
      expect.objectContaining({ src: "/pwa-192x192.png", sizes: "192x192" }),
      expect.objectContaining({ src: "/pwa-512x512.png", sizes: "512x512" }),
      expect.objectContaining({ src: "/maskable-icon-512x512.png", purpose: "maskable" }),
    ]));
    expect(JSON.stringify(manifest)).not.toMatch(/bootstrap|csrf|cwd|session_id|workspace/iu);

    expect(pngSize(join(output, "pwa-192x192.png"))).toEqual([192, 192]);
    expect(pngSize(join(output, "pwa-512x512.png"))).toEqual([512, 512]);
    expect(pngSize(join(output, "maskable-icon-512x512.png"))).toEqual([512, 512]);
    expect(pngSize(join(output, "apple-touch-icon-180x180.png"))).toEqual([180, 180]);
    expect(statSync(join(output, "favicon.ico")).size).toBeGreaterThan(0);

    const worker = readFileSync(join(output, "sw.js"), "utf8");
    expect(worker).not.toContain("__WB_MANIFEST");
    expect(worker).toContain("SKIP_WAITING");
    expect(worker).toMatch(/"url":\s*"index\.html"/u);
    expect(worker).toMatch(/"url":\s*"assets\//u);
    expect(worker).not.toMatch(/"url":\s*"(?:api\/|[^"\n]+\.map")/u);

    const html = readFileSync(join(output, "index.html"), "utf8");
    expect(html).toContain("viewport-fit=cover");
    expect(html).toContain("apple-mobile-web-app-capable");
    expect(html).toContain("manifest.webmanifest");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
