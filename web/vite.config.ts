import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { DEV_BACKEND_ORIGIN, rewriteDevProxyHeaders } from "./src/lib/dev-proxy.ts";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
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
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
