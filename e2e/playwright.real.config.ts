import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { launchOptions } from "./browser";

/**
 * apps/web against a real FreeCADApiServer. Skipped unless FREECAD_API_SERVER names the binary;
 * global-setup starts it (`--listen ws://127.0.0.1:0/`) and the tests open `/?ws=<its url>`.
 * SCREENSHOTS=1 also writes docs/screenshots/*.png.
 */
const PORT = Number(process.env.E2E_PORT ?? 5192);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const APP_DIR = resolve(import.meta.dirname, "..", "apps", "web");

export default defineConfig({
  testDir: "./real",
  outputDir: "./output/real-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "output/real-report", open: "never" }]],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  globalSetup: "./real/global-setup.ts",
  globalTeardown: "./real/global-teardown.ts",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 }, launchOptions } }],
  webServer:
    process.env.E2E_BASE_URL || !process.env.FREECAD_API_SERVER
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
