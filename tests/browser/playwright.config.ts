import { randomUUID } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

const port = process.env.BAKERY_BROWSER_PORT ?? "18788";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error("BAKERY_BROWSER_PORT_INVALID");
}
// `localhost`, not the loopback IP: Chromium refuses WebAuthn on IP hosts.
const baseURL = `http://localhost:${port}`;
const runId = process.env.BAKERY_BROWSER_RUN_ID ?? randomUUID();
process.env.BAKERY_BROWSER_RUN_ID = runId;
process.env.BAKERY_BROWSER_BASE_URL ??= baseURL;
process.env.BAKERY_BROWSER_EMAIL ??= `browser-${runId}@example.test`;
process.env.BAKERY_BROWSER_PASSWORD ??= `Browser-${randomUUID()}`;
process.env.BAKERY_BROWSER_AUTH_SECRET ??= `${randomUUID()}${randomUUID()}`;

export default defineConfig({
  outputDir: "../../artifacts/auth-browser/test-results",
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 20_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [["list"], ["html", {
      outputFolder: "../../artifacts/auth-browser/report",
      open: "never",
    }]]
    : "list",
  use: {
    baseURL,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command:
      "deno run --allow-env --allow-net --allow-read=tests/browser/fixtures,docs/technical-design/auth-mocks,docs/technical-design/enterprise-mocks/fonts,apps/server/src/platform/migrations,apps/server/src/modules/auth/migrations,apps/server/src/modules/work/migrations,apps/server/src/modules/projects/migrations,apps/server/src/modules/agents/migrations,apps/server/src/modules/repository-rules/migrations,apps/server/src/modules/integrations/migrations,apps/server/src/modules/delivery/migrations tests/browser/server.ts",
    url: `${baseURL}/__test__/auth`,
    cwd: process.cwd(),
    reuseExistingServer: false,
    timeout: 30_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
});
