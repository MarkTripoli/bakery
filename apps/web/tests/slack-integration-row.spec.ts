import { expect, type Page, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { still } from "./helpers/stills.ts";

const ORGANIZATION_PATH = "/settings/organization/integrations";
const INSTALLATION_PATH = "/settings/installation/integrations";
const SOON = "Connecting Slack is not available in this version of Bakery yet.";

const slackCredentials = {
  provider: "slack",
  configured: false,
  clientId: null,
  clientSecretSavedAt: null,
  callbackUrl:
    "https://bakery.example/v1/integration-auth/slack/install-callback",
  version: 0,
};

const savedSlackCredentials = {
  ...slackCredentials,
  configured: true,
  clientId: "1234567890.0987654321",
  clientSecretSavedAt: "2026-11-24T10:00:00.000Z",
  version: 2,
};

async function fixture(
  page: Page,
  credentials: typeof slackCredentials | typeof savedSlackCredentials =
    slackCredentials,
): Promise<void> {
  await mockAuthenticatedSession(page);
  await page.route(
    "**/v1/integration-client-credentials/slack",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(credentials),
      }),
  );
  await page.route("**/v1/integration-connections", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], nextCursor: null }),
    }));
}

test("the Slack row on the organization integrations page", async ({ page }) => {
  await fixture(page);
  await page.goto(ORGANIZATION_PATH);
  const slack = page.getByTestId("provider-row-slack");
  const row = (await slack.count()) > 0 ? slack : page.getByText("Slack", {
    exact: true,
  }).first();
  await expect(row).toBeVisible();
  await expect(page.getByText(SOON).first()).toBeVisible();
  await still(page, "connections-org");
});

test("the Slack section on the installation integrations page", async ({ page }) => {
  await fixture(page);
  await page.goto(INSTALLATION_PATH);
  const section = page.getByTestId("slack-credentials");
  await expect(section).toContainText(SOON);
  await expect(section).toContainText(
    "Slack is not set up yet. Create a Slack app, then enter its details here.",
  );
  await still(page, "connections-installation", section);
});

test("a saved Slack app says its details are saved, never that Slack is set up", async ({ page }) => {
  await fixture(page, savedSlackCredentials);
  await page.goto(INSTALLATION_PATH);
  const section = page.getByTestId("slack-credentials");
  await expect(section).toContainText("Your Slack app details are saved.");
  await expect(section).not.toContainText("Slack is set up.");
});
