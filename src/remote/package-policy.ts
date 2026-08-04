export const MAX_PACKED_PACKAGE_BYTES = 750_000;

export const PACKAGE_FILE_ALLOWLIST = [
  "dist/chunk-*.js",
  "dist/cli/index.js",
  "dist/discovery/worker.js",
  "dist/server/index.js",
  "dist/web/apple-touch-icon-180x180.png",
  "dist/web/assets/index-*.css",
  "dist/web/assets/index-*.js",
  "dist/web/assets/workbox-window.prod.es5-*.js",
  "dist/web/favicon.ico",
  "dist/web/favicon.svg",
  "dist/web/fonts/ibm-plex-mono-400-latin.woff2",
  "dist/web/fonts/ibm-plex-mono-500-latin.woff2",
  "dist/web/fonts/instrument-sans-latin.woff2",
  "dist/web/fonts/LICENSE",
  "dist/web/fonts/LICENSE-IBM-Plex-Mono.txt",
  "dist/web/fonts/LICENSE-Instrument-Sans.txt",
  "dist/web/icon.svg",
  "dist/web/index.html",
  "dist/web/manifest.webmanifest",
  "dist/web/maskable-icon-512x512.png",
  "dist/web/pwa-64x64.png",
  "dist/web/pwa-192x192.png",
  "dist/web/pwa-512x512.png",
  "dist/web/sw.js",
  "README.md",
  "SECURITY.md",
] as const;

export const REQUIRED_PACKED_FILES = [
  "dist/cli/index.js",
  "dist/discovery/worker.js",
  "dist/server/index.js",
  "dist/web/apple-touch-icon-180x180.png",
  "dist/web/favicon.ico",
  "dist/web/favicon.svg",
  "dist/web/fonts/ibm-plex-mono-400-latin.woff2",
  "dist/web/fonts/ibm-plex-mono-500-latin.woff2",
  "dist/web/fonts/instrument-sans-latin.woff2",
  "dist/web/fonts/LICENSE",
  "dist/web/fonts/LICENSE-IBM-Plex-Mono.txt",
  "dist/web/fonts/LICENSE-Instrument-Sans.txt",
  "dist/web/icon.svg",
  "dist/web/index.html",
  "dist/web/manifest.webmanifest",
  "dist/web/maskable-icon-512x512.png",
  "dist/web/pwa-64x64.png",
  "dist/web/pwa-192x192.png",
  "dist/web/pwa-512x512.png",
  "dist/web/sw.js",
] as const;

const PACKAGE_METADATA_FILES = ["package.json", "README.md", "SECURITY.md"] as const;
const EXACT_PACKED_FILES = new Set<string>([
  ...PACKAGE_METADATA_FILES,
  ...REQUIRED_PACKED_FILES,
]);

const PACKED_FILE_FAMILIES = [
  {
    path: "dist/chunk-<hash>.js",
    pattern: /^dist\/chunk-[A-Z0-9]{8}\.js$/u,
    count: 3,
  },
  {
    path: "dist/web/assets/index-<hash>.css",
    pattern: /^dist\/web\/assets\/index-[A-Za-z0-9_-]{8}\.css$/u,
    count: 1,
  },
  {
    path: "dist/web/assets/index-<hash>.js",
    pattern: /^dist\/web\/assets\/index-[A-Za-z0-9_-]{8}\.js$/u,
    count: 1,
  },
  {
    path: "dist/web/assets/workbox-window.prod.es5-<hash>.js",
    pattern: /^dist\/web\/assets\/workbox-window\.prod\.es5-[A-Za-z0-9_-]{8}\.js$/u,
    count: 1,
  },
] as const;

interface NpmPackFile {
  path?: unknown;
}

interface NpmPackReport {
  filename?: unknown;
  size?: unknown;
  files?: unknown;
}

export interface PackedPackagePolicyViolation {
  kind: "artifact" | "budget";
  path: string;
  message: string;
}

export interface PackedPackageInspection {
  filename: string | null;
  violations: PackedPackagePolicyViolation[];
}

function portablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Validate npm's pack report as the complete installed-runtime manifest.
 * Hashed output families have fixed cardinality so a second build generation
 * cannot silently ride along in a remote-host install.
 */
export function inspectPackedPackage(contents: string): PackedPackageInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return {
      filename: null,
      violations: [{
        kind: "artifact",
        path: "package.json",
        message: "npm pack did not return valid JSON",
      }],
    };
  }

  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
    return {
      filename: null,
      violations: [{
        kind: "artifact",
        path: "package.json",
        message: "npm pack must describe exactly one package",
      }],
    };
  }

  const report = parsed[0] as NpmPackReport;
  const violations: PackedPackagePolicyViolation[] = [];
  if (typeof report.size !== "number" || !Number.isSafeInteger(report.size) || report.size < 0) {
    violations.push({
      kind: "artifact",
      path: "package.json",
      message: "npm pack did not report a valid package size",
    });
  } else if (report.size > MAX_PACKED_PACKAGE_BYTES) {
    violations.push({
      kind: "budget",
      path: "package.json",
      message: `packed runtime is ${String(report.size)} bytes; budget is ${String(MAX_PACKED_PACKAGE_BYTES)}`,
    });
  }

  if (!Array.isArray(report.files)) {
    violations.push({
      kind: "artifact",
      path: "package.json",
      message: "npm pack did not report package files",
    });
    return {
      filename: typeof report.filename === "string" ? report.filename : null,
      violations,
    };
  }

  const files = new Set<string>();
  const familyFiles = PACKED_FILE_FAMILIES.map(() => new Set<string>());
  for (const entry of report.files as NpmPackFile[]) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string") {
      violations.push({
        kind: "artifact",
        path: "package.json",
        message: "npm pack reported an invalid file entry",
      });
      continue;
    }

    const path = portablePath(entry.path);
    if (files.has(path)) {
      violations.push({
        kind: "artifact",
        path,
        message: "npm pack reported the same runtime file more than once",
      });
      continue;
    }
    files.add(path);

    const familyIndex = PACKED_FILE_FAMILIES.findIndex((family) => family.pattern.test(path));
    if (familyIndex >= 0) {
      familyFiles[familyIndex]?.add(path);
      continue;
    }
    if (!EXACT_PACKED_FILES.has(path)) {
      violations.push({
        kind: "artifact",
        path,
        message: "file is outside the exact installed-runtime manifest",
      });
    }
  }

  for (const requiredPath of EXACT_PACKED_FILES) {
    if (!files.has(requiredPath)) {
      violations.push({
        kind: "artifact",
        path: requiredPath,
        message: "required runtime file is missing from npm pack",
      });
    }
  }
  for (const [index, family] of PACKED_FILE_FAMILIES.entries()) {
    const actualCount = familyFiles[index]?.size ?? 0;
    if (actualCount !== family.count) {
      violations.push({
        kind: "artifact",
        path: family.path,
        message: `npm pack must contain exactly ${String(family.count)} matching file(s); found ${String(actualCount)}`,
      });
    }
  }

  return {
    filename: typeof report.filename === "string" ? report.filename : null,
    violations: violations.sort((left, right) =>
      left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)),
  };
}
