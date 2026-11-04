import { defineConfig } from "vite";

export default defineConfig({
  worker: { format: "es" },
  build: { target: "es2022" },
  // The collaboration server (apps/sheets/server) handles /api and /ws.
  server: { port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:8787", "/ws": { target: "ws://127.0.0.1:8787", ws: true } } },
  preview: { proxy: { "/api": "http://127.0.0.1:8787", "/ws": { target: "ws://127.0.0.1:8787", ws: true } } },
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
} as never);
