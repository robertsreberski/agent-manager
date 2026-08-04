import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "cli/index": "src/cli/index.ts",
    "server/index": "src/server/index.ts",
    "discovery/worker": "src/discovery/worker.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  sourcemap: true,
  // Keep the independently built Vite app when rebuilding only the server.
  // tsup prepends `**/*`; this negation limits its cleanup to non-web output.
  clean: ["!web/**"],
  removeNodeProtocol: false,
  esbuildOptions(options) {
    // esbuild's feature table predates node:sqlite. Without this override it
    // rewrites the valid built-in specifier to the nonexistent bare `sqlite`.
    options.supported = {
      ...options.supported,
      "node-colon-prefix-import": true,
    };
  },
});
