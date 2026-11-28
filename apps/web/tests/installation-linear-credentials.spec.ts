import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

/**
 * Linear's OAuth client credentials on the installation Integrations page, and the
 * organization page's row for a provider that cannot be connected yet (#410).
 * The Bakery API is mocked: this proves the states and what the browser sends and
 * keeps. The real-API half is `tests/integration/store-integration-client-credentials_test.ts`.
 */
const INSTALLATION_PATH = "/settings/installation/integrations";
const ORGANIZATION_PATH = "/settings/organization/integrations";
const CALLBACK = "https://bakery.example/v1/integration-auth/linear/callback";
const CLIENT_ID = "linear-client-0123";
const CLIENT_SECRET = "lin_oauth_browser_canary_secret_abcdef";

const unregistered = {
  provider: "linear",
  configured: false,
  clientId: null,
  clientSecretSavedAt: null,
  signingSecretSavedAt: null,
  callbackUrl: CALLBACK,
  version: 0,
};
const registered = {
  provider: "linear",
  configured: true,
  clientId: CLIENT_ID,
  clientSecretSavedAt: "2026-11-19T10:00:00.000Z",
  signingSecretSavedAt: null,
  callbackUrl: CALLBACK,
  version: 3,
};
type Credentials = typeof unregistered | typeof registered;

function problem(status: number, code: string) {
  return {
    status,
    contentType: "application/problem+json",
    body: JSON.stringify({
      type: "https://bakery.example/problems/test",
      title: "Request refused",
      detail: "Request refused.",
      status,
      code,
      retryable: false,
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
    }),
  };
}

async function fixture(
  page: Page,
  initial: Credentials | "forbidden" | "error" = unregistered,
) {
  await mockAuthenticatedSession(page);
  const state = {
    current: initial,
    putAnswer: "ok" as "ok" | number,
    puts: [] as {
      body: Record<string, string>;
      headers: Record<string, string>;
    }[],
  };
  await page.route("**/v1/integration-client-credentials/linear", (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      state.puts.push({
        body: request.postDataJSON(),
        headers: request.headers(),
      });
      if (state.putAnswer !== "ok") {
        return route.fulfill(
          problem(
            state.putAnswer,
            state.putAnswer === 412 ? "PRECONDITION_FAILED" : "INTERNAL",
          ),
        );
      }
      const previous = typeof state.current === "object"
        ? state.current
        : unregistered;
      state.current = {
        ...registered,
        clientId: state.puts.at(-1)!.body.clientId,
        version: previous.version + 1,
      };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(state.current),
      });
    }
    if (state.current === "forbidden") {
      return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
    }
    if (state.current === "error") {
      return route.fulfill(problem(503, "DEPENDENCY_UNAVAILABLE"));
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(state.current),
    });
  });
  return state;
}

const section = (page: Page) => page.getByTestId("linear-credentials");
const form = (page: Page) => page.getByTestId("linear-credentials-form");
const field = (page: Page, name: string) =>
  form(page).locator(`input[name="${name}"]`);
const callbackUrl = (page: Page) => page.getByTestId("linear-callback-url");
const save = (page: Page) => form(page).getByRole("button", { name: "Save" });

test.describe("Linear credentials on installation settings", () => {
  test("not set up: guidance, a guide link, the callback to copy and an empty form", async ({ page }) => {
    await fixture(page);
    await page.goto(INSTALLATION_PATH);
    await expect(section(page)).toContainText(
      "Linear is not set up yet. Create an OAuth application in Linear, then enter its details here.",
    );
    const guide = section(page).getByRole("link", {
      name: "How to create it in Linear",
    });
    await expect(guide).toHaveAttribute(
      "href",
      "https://linear.app/settings/api",
    );
    await expect(guide).toHaveAttribute("target", "_blank");
    await expect(callbackUrl(page)).toHaveText(CALLBACK);
    await expect(field(page, "clientId")).toHaveValue("");
    await expect(field(page, "clientSecret")).toHaveAttribute(
      "type",
      "password",
    );
  });

  test("the callback URL is shown in full, wraps instead of cutting, and Copy puts all of it on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    // A long address, as a real deployment has: it must stay readable by eye.
    const longCallback = `https://bakery.example/${
      "deployment-path/".repeat(8)
    }v1/integration-auth/linear/callback`;
    await fixture(page, { ...unregistered, callbackUrl: longCallback });
    await page.goto(INSTALLATION_PATH);
    const value = callbackUrl(page);
    await expect(value).toHaveText(longCallback);
    // No ellipsis and no horizontal scroll: the value wraps inside its box.
    const overflow = await value.evaluate((element) => ({
      clipped: element.scrollWidth > element.clientWidth + 1,
      ellipsis: getComputedStyle(element).textOverflow === "ellipsis",
    }));
    expect(overflow).toEqual({ clipped: false, ellipsis: false });
    await section(page).getByRole("button", { name: "Copy callback URL" })
      .click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(longCallback);
  });

  test("a pasted secret with surrounding whitespace is trimmed before it is sent, as the client ID is", async ({ page }) => {
    const state = await fixture(page);
    await page.goto(INSTALLATION_PATH);
    // A provider page often hands over a trailing space or newline with the value.
    await field(page, "clientId").fill(`  ${CLIENT_ID} `);
    await field(page, "clientSecret").fill(` ${CLIENT_SECRET}\n `);
    await save(page).click();
    await expect(section(page)).toContainText("Linear is set up.");
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0].body).toEqual({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
  });

  test("both fields are required and say so under the field", async ({ page }) => {
    const state = await fixture(page);
    await page.goto(INSTALLATION_PATH);
    await save(page).click();
    await expect(section(page)).toContainText("Enter the client ID.");
    await expect(section(page)).toContainText("Enter the client secret.");
    expect(state.puts).toHaveLength(0);
  });

  test("a first save sends the pair without If-Match, then shows it saved and keeps no secret", async ({ page }) => {
    const state = await fixture(page);
    await page.goto(INSTALLATION_PATH);
    await field(page, "clientId").fill(CLIENT_ID);
    await field(page, "clientSecret").fill(CLIENT_SECRET);
    await save(page).click();
    await expect(section(page)).toContainText("Linear is set up.");
    await expect(section(page)).toContainText(`Client ID ${CLIENT_ID}`);
    await expect(section(page)).toContainText("Client secret saved");
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0].body).toEqual({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(state.puts[0].headers["if-match"]).toBeUndefined();
    expect(state.puts[0].headers["idempotency-key"]).toBeTruthy();
    // The secret is nowhere in the page or in browser storage.
    const retained = await page.evaluate(() =>
      document.documentElement.outerHTML + JSON.stringify({ ...localStorage }) +
      JSON.stringify({ ...sessionStorage })
    );
    expect(retained).not.toContain(CLIENT_SECRET);
  });

  test("a registered provider shows its ID and when the secret was saved, and Replace opens empty fields", async ({ page }) => {
    const state = await fixture(page, registered);
    await page.goto(INSTALLATION_PATH);
    await expect(section(page)).toContainText("Linear is set up.");
    await expect(section(page)).toContainText(`Client ID ${CLIENT_ID}`);
    await expect(form(page)).toHaveCount(0);
    await section(page).getByRole("button", { name: "Replace details" })
      .click();
    await expect(field(page, "clientId")).toHaveValue("");
    await expect(field(page, "clientSecret")).toHaveValue("");
    await form(page).getByRole("button", { name: "Cancel" }).click();
    await expect(form(page)).toHaveCount(0);
    await section(page).getByRole("button", { name: "Replace details" })
      .click();
    await field(page, "clientId").fill("linear-client-next");
    await field(page, "clientSecret").fill("lin_oauth_next_secret");
    await save(page).click();
    await expect(section(page)).toContainText("Client ID linear-client-next");
    // A replacement carries the version it read.
    expect(state.puts[0].headers["if-match"]).toContain("3");
  });

  test("a refused save keeps the client ID, empties the secret and leaves the form open to try again", async ({ page }) => {
    const state = await fixture(page);
    state.putAnswer = 500;
    await page.goto(INSTALLATION_PATH);
    await field(page, "clientId").fill(CLIENT_ID);
    await field(page, "clientSecret").fill(CLIENT_SECRET);
    await save(page).click();
    await expect(section(page)).toContainText(
      "The details could not be saved. Enter the client secret again, then save.",
    );
    // The client ID is not a secret and stays; the secret never does.
    await expect(field(page, "clientId")).toHaveValue(CLIENT_ID);
    await expect(field(page, "clientSecret")).toHaveValue("");
    await expect(form(page)).toBeVisible();
    // Entering the secret again and saving works.
    state.putAnswer = "ok";
    await field(page, "clientSecret").fill(CLIENT_SECRET);
    await save(page).click();
    await expect(section(page)).toContainText("Linear is set up.");
    expect(state.puts).toHaveLength(2);
    expect(state.puts[1].body.clientId).toBe(CLIENT_ID);
  });

  test("a refused save from Replace details keeps the form open with the client ID", async ({ page }) => {
    const state = await fixture(page, registered);
    state.putAnswer = 500;
    await page.goto(INSTALLATION_PATH);
    await section(page).getByRole("button", { name: "Replace details" })
      .click();
    await field(page, "clientId").fill("replacement-client");
    await field(page, "clientSecret").fill(CLIENT_SECRET);
    await save(page).click();
    await expect(section(page)).toContainText(
      "The details could not be saved. Enter the client secret again, then save.",
    );
    // The form did not close: the person is not sent back to start over.
    await expect(form(page)).toBeVisible();
    await expect(field(page, "clientId")).toHaveValue("replacement-client");
    await expect(field(page, "clientSecret")).toHaveValue("");
    // Cancel closes the form and takes the notice with it: no red message is left
    // over a page that has no form.
    await form(page).getByRole("button", { name: "Cancel" }).click();
    await expect(form(page)).toHaveCount(0);
    await expect(section(page)).not.toContainText("could not be saved");
    await expect(section(page)).toContainText("Linear is set up.");
  });

  test("a stale version closes the form onto the current details and keeps nothing typed", async ({ page }) => {
    const state = await fixture(page, registered);
    state.putAnswer = 412;
    await page.goto(INSTALLATION_PATH);
    await section(page).getByRole("button", { name: "Replace details" })
      .click();
    await field(page, "clientId").fill("x-client");
    await field(page, "clientSecret").fill("x-secret");
    await save(page).click();
    await expect(section(page)).toContainText(
      "These details changed since this page loaded. Nothing was saved. Check the current details, then enter yours again.",
    );
    // What is stored now is shown, not the form, and nothing typed survives.
    await expect(section(page)).toContainText(`Client ID ${CLIENT_ID}`);
    await expect(form(page)).toHaveCount(0);
    await section(page).getByRole("button", { name: "Replace details" })
      .click();
    await expect(field(page, "clientId")).toHaveValue("");
    await expect(field(page, "clientSecret")).toHaveValue("");
    // Cancel from here drops the details-changed notice too.
    await form(page).getByRole("button", { name: "Cancel" }).click();
    await expect(form(page)).toHaveCount(0);
    await expect(section(page)).not.toContainText("details changed");
  });

  test("a failed load can be retried", async ({ page }) => {
    const state = await fixture(page, "error");
    await page.goto(INSTALLATION_PATH);
    await expect(section(page)).toContainText(
      "The Linear details could not be loaded.",
    );
    state.current = unregistered;
    await section(page).getByRole("button", { name: "Try again" }).click();
    await expect(form(page)).toBeVisible();
  });

  test("has no accessibility violations", async ({ page }) => {
    await fixture(page);
    await page.goto(INSTALLATION_PATH);
    await expect(form(page)).toBeVisible();
    const results = await new AxeBuilder({ page }).include(
      '[data-testid="linear-credentials"]',
    ).analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("Linear on the organization Integrations page", () => {
  test("is listed as Soon, with Connect disabled and pointing at the reason", async ({ page }) => {
    await mockAuthenticatedSession(page);
    // The page reads the organization's role and its connections: an administrator
    // with none connected, so only the Available group has anything to show.
    await page.route(
      `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            organizationId: MOCK_ORGANIZATION_ID,
            role: "admin",
            capabilities: [],
          }),
        }),
    );
    await page.route("**/v1/integration-connections", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], nextCursor: null }),
      }));
    await page.goto(ORGANIZATION_PATH);
    const list = page.getByTestId("available-list");
    await expect(list).toContainText("Linear");
    await expect(list).toContainText("Soon");
    await expect(list).toContainText(
      "Connecting Linear is not available in this version of Bakery yet.",
    );
    const connect = list.getByRole("button", { name: "Connect Linear" });
    await expect(connect).toBeDisabled();
    const reason = await connect.getAttribute("aria-describedby");
    await expect(page.locator(`[id="${reason}"]`)).toContainText(
      "Connecting Linear is not available in this version of Bakery yet.",
    );
    await expect(connect).not.toHaveAttribute("title", /.+/);
  });
});
