import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_PRINCIPAL_ID,
  mockAuthenticatedSession,
  mockBootstrappedInstallation,
  mockUserPreferences,
} from "./helpers/mock-session.ts";

async function settingsFixture(page: Page) {
  await mockAuthenticatedSession(page);
  const record = {
    registrationMode: "invitation",
    organizationCreationPolicy: "installation_admins",
    version: 1,
    updatedByPrincipalId: MOCK_PRINCIPAL_ID,
    updatedAt: "2026-10-11T14:12:00.000Z",
  };
  const writes: {
    body: unknown;
    version: string | undefined;
    key: string | undefined;
  }[] = [];
  let failure: number | null = null;
  let forbidden = false;
  let delay = 0;
  await page.route("**/v1/installation/settings", async (route) => {
    const request = route.request();
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const patch = request.method() === "PATCH";
    if (patch) {
      writes.push({
        body: request.postDataJSON(),
        version: request.headers()["if-match"],
        key: request.headers()["idempotency-key"],
      });
    }
    const status = forbidden ? 403 : patch
      ? failure ??
        (request.headers()["if-match"] === `"v${record.version}"` ? 200 : 409)
      : 200;
    if (status !== 200) {
      return route.fulfill({
        status,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://bakery.example/problems/test",
          title: "Request refused",
          detail: "Request refused.",
          status,
          code: status === 403
            ? "AUTH_FORBIDDEN"
            : status === 409
            ? "VERSION_CONFLICT"
            : "DEPENDENCY_UNAVAILABLE",
          retryable: status === 503,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
      });
    }
    if (patch) {
      const body = request.postDataJSON();
      record.registrationMode = body.registrationMode;
      record.organizationCreationPolicy = body.organizationCreationPolicy;
      record.version++;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(record),
    });
  });
  return {
    record,
    writes,
    fail: (status: number | null) => {
      failure = status;
    },
    deny: () => {
      forbidden = true;
    },
    wait: (ms: number) => {
      delay = ms;
    },
  };
}

test("development fixture alias keeps the installation session guard", async ({ page }) => {
  await mockBootstrappedInstallation(page);
  await page.route("**/v1/me*", (route) =>
    route.fulfill({
      status: 401,
      headers: { "content-type": "application/problem+json" },
      body: JSON.stringify({
        type: "https://bakery.example/problems/auth-required",
        title: "Authentication required",
        detail: "Sign in to continue.",
        status: 401,
        code: "AUTH_REQUIRED",
        retryable: false,
        requestId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
      }),
    }));

  await page.goto("/__fixtures__/installation/settings");

  await expect(page).toHaveURL("/sign-in");
  await expect.poll(() =>
    page.evaluate(() => sessionStorage.getItem("bakery.auth.returnTo.v1"))
  ).toBe("/__fixtures__/installation/settings");
});

test("development fixture alias preserves controller states and phone navigation", async ({ page }) => {
  const f = await settingsFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/__fixtures__/installation/settings");

  await expect(page.getByRole("heading", { name: "Installation settings" }))
    .toBeVisible();
  await expect(
    page.locator(
      '.bakery-section-navigation a[href="/installation/settings"]',
    ),
  ).toHaveAttribute("aria-current", "page");

  const menu = await page.getByRole("button", { name: "Open navigation" })
    .boundingBox();
  expect(menu?.width).toBeGreaterThanOrEqual(44);
  expect(menu?.height).toBeGreaterThanOrEqual(44);
  const section = await page.locator(".bakery-section-navigation__summary")
    .boundingBox();
  expect(section?.height).toBeGreaterThanOrEqual(44);
  const logo = await page.locator(
    ".bakery-top-bar__title .ui-logo-mark img",
  ).boundingBox();
  expect(logo?.width).toBe(28);
  expect(logo?.height).toBe(28);

  f.fail(503);
  await page.getByRole("radio", { name: /^Closed/ }).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator('[data-ui-component="installationSettingsForm"]'))
    .toHaveAttribute("data-state", "error");
  await page.getByRole("button", { name: "Discard", exact: true }).click();

  f.fail(409);
  await page.getByRole("radio", { name: /^Closed/ }).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator('[data-ui-component="installationSettingsForm"]'))
    .toHaveAttribute("data-state", "conflict");
});

test("installation administrator changes policy with CAS and persisted reload", async ({ page }) => {
  const f = await settingsFixture(page);
  await page.goto("/installation/settings");
  await expect(page.getByRole("heading", { name: "Installation settings" }))
    .toBeVisible();
  const openRegistration = page.getByRole("radio", { name: /^Open/ });
  await expect(openRegistration).toBeDisabled();
  await expect(openRegistration).toHaveAccessibleName(
    /Open registration is not available/,
  );
  await expect(page.getByRole("button", { name: "Save settings" }))
    .toBeDisabled();
  await page.getByRole("radio", { name: /^Closed/ }).check();
  await page.getByRole("radio", { name: /^Any user/ }).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Changes saved.", { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.version).toBe('"v1"');
  expect(f.writes[0]?.body).toEqual({
    registrationMode: "closed",
    organizationCreationPolicy: "any_user",
  });
  expect(f.writes[0]?.key).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("radio", { name: /^Closed/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /^Any user/ })).toBeChecked();
});

test("save error preserves edits and retries identical immutable request", async ({ page }) => {
  const f = await settingsFixture(page);
  f.fail(503);
  await page.goto("/installation/settings");
  await page.getByRole("radio", { name: /^Closed/ }).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText(/Changes couldn’t be saved/)).toBeVisible();
  await expect(page.locator('[data-policy-group="registration"]'))
    .toHaveAttribute("data-policy-value", "closed");
  await expect(page.locator('[data-policy-group="registration"]'))
    .toHaveText("Closed");
  expect(f.writes).toHaveLength(1);
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^Invitation only/ }))
    .toBeChecked();
  expect(f.writes).toHaveLength(1);

  await page.getByRole("radio", { name: /^Closed/ }).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText(/Changes couldn’t be saved/)).toBeVisible();
  await expect(page.locator('[data-policy-group="registration"]'))
    .toHaveAttribute("data-policy-value", "closed");
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1]?.key).not.toBe(f.writes[0]?.key);
  f.fail(null);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Changes saved.", { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(3);
  expect(f.writes[2]).toEqual(f.writes[1]);
});

test("concurrent change requires explicit reload and never silently overwrites", async ({ page }) => {
  const f = await settingsFixture(page);
  await page.goto("/installation/settings");
  await page.getByRole("radio", { name: /^Closed/ }).check();
  f.record.version++;
  f.record.organizationCreationPolicy = "any_user";
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText(/Someone else updated/)).toBeVisible();
  await expect(page.locator('[data-policy-group="registration"]'))
    .toHaveAttribute("data-policy-value", "closed");
  await expect(page.locator('[data-policy-group="registration"]'))
    .toHaveText("Closed");
  await expect(page.getByRole("button", { name: "Save settings" }))
    .toHaveCount(0);
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^Closed/ })).toBeChecked();
  await page.getByRole("radio", { name: /^Any user/ }).check();
  await expect(page.getByRole("button", { name: "Save settings" }))
    .toBeDisabled();
  expect(f.writes).toHaveLength(1);
  await page.getByRole("button", { name: "Reload latest" }).click();
  await expect(page.getByRole("radio", { name: /^Invitation only/ }))
    .toBeChecked();
  await expect(page.getByRole("radio", { name: /^Any user/ })).toBeChecked();
  expect(f.writes).toHaveLength(1);
});

test("discard restores saved policy without sending a request", async ({ page }) => {
  const f = await settingsFixture(page);
  await page.goto("/installation/settings");
  await page.getByRole("radio", { name: /^Closed/ }).check();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^Invitation only/ }))
    .toBeChecked();
  expect(f.writes).toHaveLength(0);
});

test("load denial and later authority revocation hide policy controls", async ({ page }) => {
  const f = await settingsFixture(page);
  await page.goto("/installation/settings");
  await page.getByRole("radio", { name: /^Closed/ }).check();
  f.deny();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByText(
      "Only installation administrators can view or change these settings.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText(
      "Only installation administrators can view or change these settings.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(
    0,
  );
});

test("loading and saving disable duplicate submission", async ({ page }) => {
  const f = await settingsFixture(page);
  f.wait(500);
  await page.goto("/installation/settings");
  await expect(page.getByText("Loading installation settings…")).toBeVisible();
  await page.getByRole("radio", { name: /^Closed/ }).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator('[data-ui-component="installationSettingsForm"]'))
    .toHaveAttribute("data-state", "saving");
  await expect(page.getByRole("radio", { name: /^Closed/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save settings" }))
    .toBeDisabled();
  await expect(page.getByText("Changes saved.", { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1);
});

for (
  const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]
) {
  test(`installation settings keyboard, accessibility and reflow at ${viewport.width}`, async ({ page }) => {
    await settingsFixture(page);
    await page.setViewportSize(viewport);
    await page.goto("/installation/settings");
    const invitation = page.getByRole("radio", { name: /^Invitation only/ });
    const target = await invitation.boundingBox();
    expect(target?.width).toBeGreaterThanOrEqual(44);
    expect(target?.height).toBeGreaterThanOrEqual(44);
    const glyph = await invitation.locator(
      "+ .ui-installation-settings__radio-glyph",
    ).boundingBox();
    expect(glyph?.width).toBe(18);
    expect(glyph?.height).toBe(18);
    await invitation.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio", { name: /^Closed/ })).toBeChecked();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth
      ),
    ).toBe(true);
    if (viewport.width === 390) {
      expect(await page.evaluate(() => document.documentElement.scrollHeight))
        .toBeLessThanOrEqual(viewport.height);
    }
  });
}

test("pseudo RTL uses translated policies and logical layout", async ({ page }) => {
  await settingsFixture(page);
  await mockUserPreferences(page, {
    effectiveLocale: "ar-XB",
    direction: "rtl",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/installation/settings");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByTestId("installation-settings").getByRole("heading", {
      level: 1,
    }),
  ).not.toHaveText("Installation settings");
  await expect(page.getByRole("radio")).toHaveCount(5);
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= innerWidth
    ),
  ).toBe(true);
});
