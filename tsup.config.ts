import { defineConfig } from "tsup";
import { computeBuildId } from "./scripts/build-id.ts";

const buildId = computeBuildId();

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
  // The installed LaunchAgent does not enable source-map consumption. Keep
  // source maps out of both the local runtime and remote-host package.
  sourcemap: false,
  // Keep the independently built Vite app when rebuilding only the server.
  // tsup prepends `**/*`; this negation limits its cleanup to non-web output.
  clean: ["!web/**"],
  removeNodeProtocol: false,
  define: {
    __AGENT_MANAGER_BUILD_ID__: JSON.stringify(buildId),
  },
  esbuildOptions(options) {
    // esbuild's feature table predates node:sqlite. Without this override it
    // rewrites the valid built-in specifier to the nonexistent bare `sqlite`.
    options.supported = {
      ...options.supported,
      "node-colon-prefix-import": true,
    };
  },
});
