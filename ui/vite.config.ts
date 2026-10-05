/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev` proxies the API to the control plane (backend/, default :3000; override with
// ROTE_API_TARGET), so the browser sees one origin and the session cookies just work.
// `npm run build` writes ui/dist, which the control plane serves in production (UI_DIST_PATH).
const apiTarget = process.env.ROTE_API_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: false },
      "/health": { target: apiTarget, changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
