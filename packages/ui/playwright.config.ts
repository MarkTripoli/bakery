import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 20_000,
  // The lane shares its host with other jobs. When the host swaps, every test
  // in flight misses its budget at once ("specimen never mounted ... browser
  // has been closed"); that is the host, not a story. One retry on CI absorbs
  // such a stall, and a story that is really broken still fails twice.
  retries: process.env.CI ? 1 : 0,
  fullyParallel: true,
  use: {
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:6006",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.BASE_URL ? undefined : {
    command: "pnpm serve:storybook-static",
    url: "http://127.0.0.1:6006",
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
