import { randomUUID } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { computeBuildId } from "../scripts/build-id.ts";
import { DEV_BACKEND_ORIGIN, rewriteDevProxyHeaders } from "./src/lib/dev-proxy.ts";

export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  define: {
    __AGENT_MANAGER_BUILD_ID__: JSON.stringify(command === "serve" ? "development" : computeBuildId()),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/pwa",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: null,
      manifestFilename: "manifest.webmanifest",
      manifest: {
        id: "/",
        name: "Agent Manager",
        short_name: "Agents",
        description: "A private cockpit for local agent sessions.",
        lang: "en",
        scope: "/",
        start_url: "/",
        display: "standalone",
        background_color: "#08080a",
        theme_color: "#08080a",
        categories: ["productivity", "utilities"],
        prefer_related_applications: false,
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        shortcuts: [
          {
            name: "Needs attention",
            short_name: "Attention",
            description: "Open sessions that need attention.",
            url: "/?scope=wants-you",
            icons: [{ src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" }],
          },
          {
            name: "New thread",
            short_name: "New thread",
            description: "Start a new agent thread.",
            url: "/?draft=1",
            icons: [{ src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" }],
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest,woff2,txt}"],
        // Manifest icons and the manifest itself are injected by VitePWA.
        // Excluding them from the Workbox glob avoids duplicate precache entries.
        globIgnores: [
          "**/*.map",
          "manifest.webmanifest",
          "icon.svg",
          "pwa-192x192.png",
          "pwa-512x512.png",
          "maskable-icon-512x512.png",
        ],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 43128,
    strictPort: true,
    proxy: {
      "/api": {
        target: DEV_BACKEND_ORIGIN,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", rewriteDevProxyHeaders);
        },
      },
    },
  },
  build: {
    // The package build command overrides this with its own mkdtemp directory.
    // Keep direct Vite invocations safe as well: they may create unpublished
    // staging output, but they must never empty the live dist/web directory.
    outDir: fileURLToPath(new URL(
      `../dist/.web-stage-unpublished-${process.pid}-${randomUUID()}`,
      import.meta.url,
    )),
    emptyOutDir: true,
    sourcemap: false,
  },
}));
