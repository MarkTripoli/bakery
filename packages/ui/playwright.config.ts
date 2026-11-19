import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 20_000,
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
