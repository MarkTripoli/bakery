import { expect, test } from "@playwright/test";
import { mockBootstrappedInstallation } from "./helpers/mock-session.ts";

// #241. Someone who cannot get in is told the one thing to do next: a visible
// "Forgot password?" that leads to a page which tells the truth, a register
// page that says an invitation is needed, and a rate limit that says when to
// try again. Fixtures-lane spec: no backend behind the dev server.

const AUTH_REQUIRED_PROBLEM = {
  type: "https://bakery.example/problems/auth-required",
  title: "Authentication required",
  status: 401,
  detail: "Authentication is required.",
  code: "AUTH_REQUIRED",
  requestId: "00000000-0000-4000-8000-000000000210",
  traceId: "00000000-0000-4000-8000-000000000211",
  retryable: false,
};

async function anonymous(page: import("@playwright/test").Page) {
  await mockBootstrappedInstallation(page);
  await page.route(
    "**/v1/me*",
    (route) =>
      route.fulfill({
        status: 401,
        headers: { "content-type": "application/problem+json" },
        body: JSON.stringify(AUTH_REQUIRED_PROBLEM),
      }),
  );
}

test("sign-in offers Forgot password?, and it leads to a page that says what can be done", async ({ page }) => {
  await anonymous(page);
  await page.goto("/sign-in");
  const forgot = page.getByRole("link", { name: "Forgot password?" });
  await expect(forgot).toBeVisible();
  await forgot.click();
  await expect(page).toHaveURL(/\/sign-in\/forgot-password$/);
  await expect(page.getByRole("heading", { name: "Forgot your password?" }))
    .toBeVisible();
  await expect(
    page.getByText("Ask the person who runs your Bakery server to reset it"),
  ).toBeVisible();
  // It never offers a form that would do nothing.
  await expect(page.locator("main form")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("Forgot password? follows the password field in tab order", async ({ page }) => {
  await anonymous(page);
  await page.goto("/sign-in");
  await page.getByLabel("Email").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Forgot password?" }))
    .toBeFocused();
});

test("sign-in says that accounts start from an invitation, and how to get one", async ({ page }) => {
  await anonymous(page);
  await page.goto("/sign-in");
  await expect(
    page.getByText("No account? Bakery accounts start from an invitation."),
  ).toBeVisible();
  await page.getByRole("link", { name: "How to get one" }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByRole("heading", { name: "You need an invitation" }))
    .toBeVisible();
  await expect(
    page.getByText("Ask an administrator of your organization to invite your"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to sign in" }))
    .toBeVisible();
});

// One test per state: a slow first load fails one named case, not a loop of five.
for (
  const [state, message] of [
    ["invalid", "That email and password do not match. Try again."],
    ["rate-limited", "Too many tries. Try again in 3 minutes."],
    [
      "blocked",
      "This account is locked for now. Try again later, or ask an administrator of your organization.",
    ],
    ["offline", "You are offline. Reconnect, then sign in."],
    ["unavailable", "Bakery could not be reached. Try again."],
  ] as const
) {
  test(`a failed sign-in (${state}) says one plain thing under the form`, async ({ page }) => {
    await page.goto(`/__fixtures__/auth/login-${state}`);
    await expect(page.getByTestId("sign-in-failure")).toHaveText(message);
    // The form stays; there is no separate pause screen.
    await expect(page.getByLabel("Email")).toBeVisible();
  });
}

test("the theme switch sits at the top end of the form panel, away from the form", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/__fixtures__/auth/login-github-disabled");
  const toggle = page.getByRole("button", { name: /theme/i }).first();
  const pane = page.locator(".ui-auth-entry__form-pane");
  await expect(toggle).toBeVisible();
  const [toggleBox, paneBox] = await Promise.all([
    toggle.boundingBox(),
    pane.boundingBox(),
  ]);
  expect(toggleBox).not.toBeNull();
  expect(paneBox).not.toBeNull();
  expect(toggleBox!.y - paneBox!.y).toBeLessThan(80);
  expect(paneBox!.x + paneBox!.width - (toggleBox!.x + toggleBox!.width))
    .toBeLessThan(80);
});

test("change password asks for the new password twice and says the rule before typing", async ({ page }) => {
  await page.goto("/__fixtures__/auth/password-default");
  await expect(page.getByText("Use 8 to 128 characters.")).toBeVisible();
  await page.getByLabel("Current password").fill("old-password");
  await page.getByLabel("New password", { exact: true }).fill(
    "a-long-enough-password",
  );
  await page.getByLabel("Confirm new password").fill("a-different-password");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByText("The two passwords do not match.")).toBeVisible();
  await expect(page.getByLabel("Confirm new password")).toBeFocused();
});
