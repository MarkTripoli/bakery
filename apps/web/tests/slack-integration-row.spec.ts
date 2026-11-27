import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
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

const CONNECTION_ID = "00000000-0000-4000-8000-0000000000e1";

const slackConnection = (extra: Record<string, unknown> = {}) => ({
  id: CONNECTION_ID,
  provider: "slack",
  label: "Test Workspace",
  externalAccountId: "T0123456",
  grantedScopes: {
    "channels:read": "granted",
    "groups:read": "granted",
    "chat:write": "granted",
  },
  config: {},
  secretId: null,
  createdBy: "00000000-0000-4000-8000-000000000001",
  status: "enabled",
  version: 3,
  createdAt: "2026-11-24T10:00:00.000Z",
  updatedAt: "2026-11-24T10:00:00.000Z",
  lastCheckedAt: null,
  ...extra,
});

async function connected(page: Page, extra: Record<string, unknown> = {}) {
  await mockAuthenticatedSession(page);
  await page.route(
    "**/v1/organizations/*/effective-access",
    (route) =>
      route.fulfill({
        json: {
          organizationId: MOCK_ORGANIZATION_ID,
          role: "admin",
          capabilities: [],
        },
      }),
  );
  const connection = slackConnection(extra);
  await page.route(
    (url) => url.pathname === "/v1/integration-connections",
    (route) =>
      route.fulfill({ json: { items: [connection], nextCursor: null } }),
  );
  await page.route(
    `**/v1/integration-connections/${CONNECTION_ID}`,
    (route) => route.fulfill({ json: connection }),
  );
  const asked: string[] = [];
  page.on("request", (request) => asked.push(new URL(request.url()).pathname));
  return asked;
}

test("a Slack connection is listed as Slack, not offered as coming soon", async ({ page }) => {
  await connected(page);
  await page.goto(ORGANIZATION_PATH);
  const row = page.getByTestId(`connection-${CONNECTION_ID}`);
  await expect(row).toContainText("Slack · Test Workspace");
  await expect(row).not.toContainText("GitHub");
  await expect(row.getByRole("button", { name: "Manage" })).toBeVisible();
  await expect(page.getByTestId("available-list")).toContainText("GitHub");
  await expect(page.getByText(SOON)).toHaveCount(0);
  await still(page, "slack-connected-list");
});

test("a Slack connection's page speaks only of Slack and offers no GitHub controls", async ({ page }) => {
  const asked = await connected(page);
  await page.goto(`${ORGANIZATION_PATH}/${CONNECTION_ID}`);
  const body = page.getByTestId("connection-page");
  await expect(body.getByRole("heading", { level: 1 }))
    .toHaveText("Slack · Test Workspace");
  await expect(body).toContainText("What Bakery can do on Slack");
  await expect(body).toContainText("Connected");
  await expect(body).not.toContainText("Not checked yet");
  await expect(
    body.getByText(
      "Bakery can read the channels and messages this bot can see in Slack.",
    ),
  ).toHaveCount(1);
  await expect(body).toContainText("Bakery can post messages in Slack.");
  await expect(body).not.toContainText("GitHub");
  await expect(body.getByTestId("repositories")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check now" }))
    .toHaveCount(0);
  await still(page, "slack-connection");
  await body.getByRole("button", { name: "Turn off" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Turn off Slack · Test Workspace?");
  await expect(dialog).toContainText(
    "Work that needs it waits until you turn it on again.",
  );
  expect(asked.filter((path) => path.endsWith("/resources"))).toEqual([]);
});

for (
  const [status, sentence] of [
    [
      "revoked",
      "Access to Slack was removed. Connecting Slack again from Bakery is not available yet.",
    ],
    ["degraded", "Turn the connection off to stop work that needs it."],
  ]
) {
  test(`a ${status} Slack connection says what can be done next`, async ({ page }) => {
    await connected(page, { status });
    await page.goto(`${ORGANIZATION_PATH}/${CONNECTION_ID}`);
    const problem = page.getByTestId("connection-problem");
    await expect(problem).toContainText(sentence);
    await expect(problem.getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("connection-page")).not.toContainText(
      "GitHub",
    );
    await still(page, `slack-${status}`);
  });
}

for (
  const [reason, sentence] of [
    [
      undefined,
      "The connection changed meanwhile. It was reloaded; try again.",
    ],
    [
      "no_selected_resource",
      "Slack could not be turned on because it has nothing Bakery may use yet.",
    ],
  ]
) {
  test(`a turned off Slack connection can be turned on; refusal ${reason ?? "stale"} is said`, async ({ page }) => {
    await turnOnRefused(page, reason, sentence!);
  });
}

async function turnOnRefused(
  page: Page,
  reason: string | undefined,
  sentence: string,
) {
  const asked = await connected(page, { status: "disabled" });
  const sent: unknown[] = [];
  await page.route(
    `**/v1/integration-connections/${CONNECTION_ID}`,
    (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          json: slackConnection({ status: "disabled" }),
        });
      }
      sent.push(route.request().postDataJSON());
      return route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://bakery.example/problems/test",
          title: "Request refused",
          detail: "Request refused.",
          status: 409,
          code: "STATE_CONFLICT",
          ...(reason === undefined ? {} : { reason }),
          retryable: false,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
      });
    },
  );
  await page.goto(`${ORGANIZATION_PATH}/${CONNECTION_ID}`);
  const problem = page.getByTestId("connection-problem");
  await expect(problem).toContainText("This connection is off.");
  await still(page, "slack-turned-off");
  await problem.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText(sentence)).toBeVisible();
  expect(sent).toEqual([{ enabled: true }]);
  expect(asked.filter((path) => path.endsWith("/resources"))).toEqual([]);
}

test("a removed Slack connection is listed once", async ({ page }) => {
  await connected(page, { status: "revoked" });
  await page.goto(ORGANIZATION_PATH);
  await expect(page.getByTestId(`connection-${CONNECTION_ID}`))
    .toContainText("Slack · Test Workspace");
  await expect(page.getByTestId("available-list")).not.toContainText("Slack");
});
