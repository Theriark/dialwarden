// The Playwright run of the editor (dev-work-plan P5): one browser against
// the real server built from source, started by the CI job with a throwaway
// data dir, a fixture server folder and run-time test keys. One worker and
// no parallelism: the Free walk runs first and the Paid walk adds the
// licence, so the order is part of the test.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
