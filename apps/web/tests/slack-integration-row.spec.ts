import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";
import { still } from "./helpers/stills.ts";

test.use({
  video: process.env.BAKERY_EVIDENCE_VIDEO === "1"
    ? { mode: "on", size: { width: 1440, height: 900 } }
    : "off",
});

const ORGANIZATION_PATH = "/settings/organization/integrations";
const INSTALLATION_PATH = "/settings/installation/integrations";
const PURPOSE =
  "Send people requests in Slack, and let them approve work there.";

const slackCredentials = {
  provider: "slack",
  configured: false,
  clientId: null,
  clientSecretSavedAt: null,
  signingSecretSavedAt: null,
  callbackUrl:
    "https://bakery.example/v1/integration-auth/slack/install-callback",
  version: 0,
};

const savedSlackCredentials = {
  ...slackCredentials,
  configured: true,
  clientId: "1234567890.0987654321",
  clientSecretSavedAt: "2026-11-24T10:00:00.000Z",
  signingSecretSavedAt: null,
  version: 2,
};

async function signInAsAdmin(page: Page) {
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
}

async function fixture(
  page: Page,
  credentials: typeof slackCredentials | typeof savedSlackCredentials =
    slackCredentials,
): Promise<void> {
  await signInAsAdmin(page);
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

const STAND_IN = "/slack-authorize-stand-in";

async function startsConnect(page: Page, sent: unknown[], status = 201) {
  await page.route("**/v1/integration-auth-attempts", (route) => {
    sent.push(route.request().postDataJSON());
    if (status !== 201) {
      return route.fulfill({
        status,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://bakery.example/problems/test",
          title: "Request refused",
          detail: "Request refused.",
          status,
          code: "STATE_CONFLICT",
          reason: "provider_unregistered",
          retryable: false,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
      });
    }
    return route.fulfill({
      status,
      json: {
        id: "00000000-0000-4000-8000-0000000000aa",
        authorizationUrl: new URL(STAND_IN, route.request().url()).href,
        expiresAt: "2026-11-27T10:15:00.000Z",
      },
    });
  });
}

const leftForSlack = (page: Page) =>
  expect.poll(() => new URL(page.url()).pathname).toBe(STAND_IN);

test("Connect Slack leaves for Slack in the same tab", async ({ page }) => {
  await fixture(page);
  const sent: unknown[] = [];
  await startsConnect(page, sent);
  await page.goto(ORGANIZATION_PATH);
  await page.getByRole("button", { name: "Connect Slack" }).click();
  await leftForSlack(page);
  expect(sent).toEqual([{ provider: "slack" }]);
});

test("Connect Slack without app details says who enters them", async ({ page }) => {
  await fixture(page);
  await startsConnect(page, [], 409);
  await page.goto(ORGANIZATION_PATH);
  await page.getByRole("button", { name: "Connect Slack" }).click();
  const row = page.getByTestId("provider-row-slack");
  await expect(row).toContainText(
    "Slack is not set up for this Bakery installation yet.",
  );
  await expect(
    row.getByRole("link", { name: "Open installation integrations" }),
  ).toBeVisible();
  await still(page, "slack-connect-unregistered");
  await row.getByRole("link", { name: "Open installation integrations" })
    .click();
  await expect(
    page.getByTestId("slack-credentials").getByRole("heading").first(),
  )
    .toBeInViewport();
});

for (
  const [outcome, sentence, retry] of [
    [
      "authorization_denied",
      "Slack was not connected, because the request was cancelled in Slack. Nothing changed.",
      true,
    ],
    [
      "held_elsewhere",
      "Another organization in Bakery already holds this connection, so nothing was connected.",
      false,
    ],
    ["exchange_failed", "Slack could not confirm the connection", true],
  ] as const
) {
  test(
    "a Slack connect that ends " + outcome + " is said on return",
    async ({ page }) => {
      await fixture(page);
      await page.goto(ORGANIZATION_PATH + "?slackConnection=" + outcome);
      const banner = page.getByTestId("github-connection-outcome");
      await expect(banner).toContainText(sentence);
      await expect(banner).not.toContainText("GitHub");
      await expect(
        banner.getByRole("button", { name: "Connect Slack again" }),
      ).toHaveCount(retry ? 1 : 0);
      await still(page, "slack-outcome-" + outcome.replaceAll("_", "-"));
    },
  );
}

test("a Slack connect that worked lands on the connection and says so", async ({ page }) => {
  await connected(page, {});
  await page.goto(
    ORGANIZATION_PATH + "?slackConnection=connected&connectionId=" +
      CONNECTION_ID,
  );
  await expect.poll(() => new URL(page.url()).pathname).toBe(
    ORGANIZATION_PATH + "/" + CONNECTION_ID,
  );
  await expect(page.getByTestId("github-connection-outcome"))
    .toContainText("Bakery was added to your Slack workspace.");
  await still(page, "slack-outcome-connected");
  await page.getByRole("button", { name: "Turn off" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Turn off" })
    .click();
  await expect(page.getByTestId("github-connection-outcome")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(CONNECTION_ID + "$"));
  await page.reload();
  await expect(page.getByRole("button", { name: "Turn off" })).toBeVisible();
  await expect(page.getByTestId("github-connection-outcome")).toHaveCount(0);
});

test("the Slack row on the organization integrations page", async ({ page }) => {
  await fixture(page);
  await page.goto(ORGANIZATION_PATH);
  const row = page.getByTestId("provider-row-slack");
  await expect(row).toContainText(PURPOSE);
  await expect(row.getByRole("button", { name: "Connect Slack" }))
    .toBeEnabled();
  await still(page, "connections-org");
});

test("the Slack section on the installation integrations page", async ({ page }) => {
  await fixture(page);
  await page.goto(INSTALLATION_PATH);
  const section = page.getByTestId("slack-credentials");
  await expect(section).not.toContainText("not available");
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

test("the Slack app form takes the signing secret beside the client pair and says when it was saved", async ({ page }) => {
  await fixture(page);
  const sent: Array<{ body: unknown; ifMatch: string | undefined }> = [];
  await page.route(
    "**/v1/integration-client-credentials/slack",
    (route) => {
      if (route.request().method() !== "PUT") {
        return route.fulfill({ json: slackCredentials });
      }
      sent.push({
        body: route.request().postDataJSON(),
        ifMatch: route.request().headers()["if-match"],
      });
      return route.fulfill({
        json: {
          ...savedSlackCredentials,
          signingSecretSavedAt: "2026-11-25T10:00:00.000Z",
        },
      });
    },
  );
  await page.goto(INSTALLATION_PATH);
  const section = page.getByTestId("slack-credentials");
  const form = section.getByTestId("slack-credentials-form");
  await expect(form).toContainText("Signing secret");
  await expect(form).toContainText(
    "From your Slack app's Basic Information page. Bakery uses it to check that requests really come from Slack.",
  );
  await form.locator('input[name="clientId"]').fill("1234567890.0987654321");
  await form.locator('input[name="clientSecret"]').fill("client-secret-value");
  await form.locator('input[name="signingSecret"]').fill(
    " signing-secret-value \n",
  );
  await still(page, "slack-signing-secret-form", section);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(section).toContainText("Signing secret saved");
  await expect(section).toContainText("Client secret saved");
  await expect(section.locator('input[name="signingSecret"]')).toHaveCount(0);
  expect(sent).toEqual([{
    body: {
      clientId: "1234567890.0987654321",
      clientSecret: "client-secret-value",
      signingSecret: "signing-secret-value",
    },
    ifMatch: undefined,
  }]);
  await still(page, "slack-signing-secret-saved", section);
  await expect(
    page.getByTestId("linear-credentials").locator(
      'input[name="signingSecret"]',
    ),
  ).toHaveCount(0);
});

test("replacing the Slack app details without a new signing secret keeps the saved one", async ({ page }) => {
  await fixture(page, savedSlackCredentials);
  const sent: Array<{ body: unknown; ifMatch: string | undefined }> = [];
  await page.route(
    "**/v1/integration-client-credentials/slack",
    (route) => {
      if (route.request().method() !== "PUT") {
        return route.fulfill({ json: savedSlackCredentials });
      }
      sent.push({
        body: route.request().postDataJSON(),
        ifMatch: route.request().headers()["if-match"],
      });
      return route.fulfill({
        json: { ...savedSlackCredentials, version: 3 },
      });
    },
  );
  await page.goto(INSTALLATION_PATH);
  const section = page.getByTestId("slack-credentials");
  await expect(section).toContainText("No signing secret saved yet");
  await section.getByRole("button", { name: "Replace" }).click();
  const form = section.getByTestId("slack-credentials-form");
  const signing = form.locator('input[name="signingSecret"]');
  await expect(signing).toHaveValue("");
  await form.locator('input[name="clientId"]').fill("1234567890.0987654321");
  await form.locator('input[name="clientSecret"]').fill("next-client-secret");
  await signing.fill("x".repeat(4097));
  await expect(form).toContainText("Use at most 4096 characters.");
  await form.getByRole("button", { name: "Save" }).click();
  expect(sent).toEqual([]);
  await signing.fill("");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(section.getByRole("button", { name: "Replace" })).toBeVisible();
  expect(sent.map((request) => request.body)).toEqual([{
    clientId: "1234567890.0987654321",
    clientSecret: "next-client-secret",
  }]);
  expect(sent[0]?.ifMatch).toContain("2");
});

function failingSave(
  page: Page,
  issues: readonly { path: string[]; code: string; message: string }[] = [],
) {
  const sent: unknown[] = [];
  return page.route(
    "**/v1/integration-client-credentials/slack",
    (route) => {
      if (route.request().method() !== "PUT") {
        return route.fulfill({ json: savedSlackCredentials });
      }
      sent.push(route.request().postDataJSON());
      return route.fulfill({
        status: issues.length > 0 ? 422 : 503,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://bakery.example/problems/test",
          title: "Request refused",
          detail: "Request refused.",
          status: issues.length > 0 ? 422 : 503,
          code: issues.length > 0 ? "UNPROCESSABLE" : "DEPENDENCY_UNAVAILABLE",
          ...(issues.length > 0 ? { issues } : {}),
          retryable: false,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
      });
    },
  ).then(() => sent);
}

async function replaceAll(page: Page) {
  await page.goto(INSTALLATION_PATH);
  const section = page.getByTestId("slack-credentials");
  await section.getByRole("button", { name: "Replace" }).click();
  const form = section.getByTestId("slack-credentials-form");
  await form.locator('input[name="clientId"]').fill("1234567890.0987654321");
  await form.locator('input[name="clientSecret"]').fill("next-client-secret");
  await form.locator('input[name="signingSecret"]').fill("next-signing-secret");
  await form.getByRole("button", { name: "Save" }).click();
  return { section, form };
}

test("a failed save asks for both secrets again, each on its own field", async ({ page }) => {
  await fixture(page, savedSlackCredentials);
  const sent = await failingSave(page);
  const { section, form } = await replaceAll(page);
  await expect(section).toContainText(
    "The details could not be saved. Enter the client secret and the signing secret again, then save.",
  );
  await expect(form).toContainText("Enter the client secret again.");
  await expect(form).toContainText("Enter the signing secret again.");
  await expect(form.locator('input[name="clientSecret"]')).toHaveValue("");
  await expect(form.locator('input[name="signingSecret"]')).toHaveValue("");
  await expect(form.locator('input[name="clientId"]')).toHaveValue(
    "1234567890.0987654321",
  );
  expect(sent).toHaveLength(1);
  await still(page, "slack-signing-secret-save-failed", section);
  await form.locator('input[name="signingSecret"]').fill("again");
  await expect(form).not.toContainText("Enter the signing secret again.");
});

test("a refused signing secret gets its own field error", async ({ page }) => {
  await fixture(page, savedSlackCredentials);
  await failingSave(page, [{
    path: ["signingSecret"],
    code: "invalid_signing_secret",
    message: "invalid signing secret",
  }]);
  const { form } = await replaceAll(page);
  await expect(form).toContainText(
    "Bakery could not accept this signing secret. Copy it again from your Slack app's Basic Information page.",
  );
  await expect(form).not.toContainText("Enter the signing secret again.");
  await expect(form.locator('input[name="signingSecret"]')).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

test.describe("recorded: save, then Replace keeps the saved signing secret", () => {
  test("save the Slack app with a signing secret, then Replace without one", async ({ page }) => {
    await fixture(page);
    let stored: Record<string, unknown> = slackCredentials;
    const sent: unknown[] = [];
    await page.route(
      "**/v1/integration-client-credentials/slack",
      (route) => {
        if (route.request().method() === "PUT") {
          const body = route.request().postDataJSON() as {
            signingSecret?: string;
          };
          sent.push(body);
          stored = {
            ...savedSlackCredentials,
            version: Number(stored.version) + 1,
            signingSecretSavedAt: body.signingSecret === undefined
              ? stored.signingSecretSavedAt
              : "2026-11-25T10:00:00.000Z",
          };
        }
        return route.fulfill({ json: stored });
      },
    );
    await page.goto(INSTALLATION_PATH);
    const section = page.getByTestId("slack-credentials");
    const form = section.getByTestId("slack-credentials-form");
    await form.locator('input[name="clientId"]').fill("1234567890.0987654321");
    await form.locator('input[name="clientSecret"]').fill("client-secret");
    await form.locator('input[name="signingSecret"]').fill("signing-secret");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(section).toContainText("Signing secret saved");
    await section.getByRole("button", { name: "Replace" }).click();
    await form.locator('input[name="clientId"]').fill("1234567890.0987654321");
    await form.locator('input[name="clientSecret"]').fill("next-secret");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(section.getByRole("button", { name: "Replace" }))
      .toBeVisible();
    await expect(section).toContainText("Signing secret saved");
    expect(sent).toEqual([
      {
        clientId: "1234567890.0987654321",
        clientSecret: "client-secret",
        signingSecret: "signing-secret",
      },
      { clientId: "1234567890.0987654321", clientSecret: "next-secret" },
    ]);
  });
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
  await signInAsAdmin(page);
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
  await expect(page.getByTestId("provider-row-slack")).toHaveCount(0);
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
  const [status, sentence, action] of [
    ["revoked", "Bakery was removed from Slack.", "Connect again"],
    ["degraded", "Slack no longer accepts Bakery's access.", "Reconnect"],
  ] as const
) {
  test(
    "a " + status + " Slack connection offers to " + action.toLowerCase(),
    async ({ page }) => {
      await connected(page, { status });
      const sent: unknown[] = [];
      await startsConnect(page, sent);
      await page.goto(ORGANIZATION_PATH + "/" + CONNECTION_ID);
      const problem = page.getByTestId("connection-problem");
      await expect(problem).toContainText(sentence);
      await expect(page.getByTestId("connection-page")).not.toContainText(
        "GitHub",
      );
      await still(page, "slack-" + status);
      await problem.getByRole("button", { name: action }).click();
      await leftForSlack(page);
      expect(sent).toEqual([
        status === "revoked" ? { provider: "slack" } : {
          provider: "slack",
          reconnectConnectionId: CONNECTION_ID,
          returnPath: ORGANIZATION_PATH + "/" + CONNECTION_ID,
        },
      ]);
    },
  );
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
