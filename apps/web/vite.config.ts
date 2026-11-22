// The web app build (P1-B, contract C8). Fonts, icons and brand files are
// bundled or served from the app origin; nothing references an outside host
// (the P0 check:assets step guards the build output). The server serves dist
// itself: index.html with no-cache and everything under /assets as immutable.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    assetsDir: "assets",
    // Fonts and images stay files under /assets, never data: URLs, so the
    // Content-Security-Policy font-src and img-src stay 'self'.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    port: 5173,
    // A local run talks to the P1-A server on its default port.
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/healthz": "http://127.0.0.1:8080",
      "/readyz": "http://127.0.0.1:8080",
    },
  },
});
