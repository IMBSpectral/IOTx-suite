import { defineConfig } from "@playwright/test";

// E2E_PORT + E2E_DEV=1 run the tests against a Vite dev server on that port instead of a
// production build, so several people (or agents) can test their own work side by side.
const port = Number(process.env.E2E_PORT ?? 4173);
const dev = process.env.E2E_DEV === "1";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: "chrome",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // The collaboration server, in-memory (no database needed for tests).
      command: "cargo run --release -p sheets-server",
      cwd: "..",
      url: "http://127.0.0.1:8787/api/health",
      env: { SHEETS_BIND: "127.0.0.1:8787" },
      reuseExistingServer: !process.env.CI,
      timeout: 900_000,
    },
    {
      command: dev
        ? `npx vite --port ${port} --strictPort --host 127.0.0.1`
        : "npm run build && npm run preview -- --host 127.0.0.1",
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
