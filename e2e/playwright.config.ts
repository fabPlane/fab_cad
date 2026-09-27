import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { launchOptions } from "./browser";

/**
 * Smoke tests of apps/web against the in-page mock FreeCAD (`?mock=1`): no server, no bridge.
 *
 *   E2E_BASE_URL=...   test an already running app instead of starting `vite`
 */
const PORT = Number(process.env.E2E_PORT ?? 5191);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const APP_DIR = resolve(import.meta.dirname, "..", "apps", "web");

export default defineConfig({
  testDir: "./tests",
  outputDir: "./output/results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 3,
  reporter: [["list"], ["html", { outputFolder: "output/report", open: "never" }]],
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 }, launchOptions } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `bunx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
        cwd: APP_DIR,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
