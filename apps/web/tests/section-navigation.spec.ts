import { expect, type Page, test } from "@playwright/test";
import { mockBootstrappedInstallation } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";

registerPageHealth(test);

function settingsNavigation(page: Page) {
  return page.getByRole("navigation", { name: "Settings sections" }).first();
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() =>
    page.evaluate(() =>
      document.documentElement.scrollWidth <=
        document.documentElement.clientWidth
    )
  ).toBe(true);
}

test.describe("routed Settings navigation", () => {
  for (
    const path of [
      "/__fixtures__/settings/security",
      "/__fixtures__/settings/security/password?from=profile#password",
      "/__fixtures__/settings/security/email?from=profile#email",
    ]
  ) {
    test(`keeps one order and selects security detail routes: ${path}`, async ({ page }) => {
      await mockBootstrappedInstallation(page);
      await page.setViewportSize({ width: 1280, height: 960 });
      await page.goto(path);
      const navigation = settingsNavigation(page);
      await expect(navigation.getByRole("link")).toHaveText([
        "Profile",
        "Account & security",
        "Active sessions",
        "Connected clients",
        "Appearance",
        "Your access",
      ]);
      await expect(
        navigation.getByRole("link", { name: "Account & security" }),
      ).toHaveAttribute("aria-current", "page");
    });
  }

  test("uses a narrow index at Settings and a menu on child routes", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.setViewportSize({ width: 640, height: 844 });
    await page.goto("/__fixtures__/settings");
    await expect(page.locator("nav.bakery-section-navigation__narrow-index"))
      .toBeVisible();
    await expect(page.locator("details.bakery-section-navigation__mobile"))
      .toHaveCount(0);

    await page.goto("/__fixtures__/settings/profile");
    await expect(page.locator("details.bakery-section-navigation__mobile"))
      .toBeVisible();
  });

  test("prevents dirty navigation, closes the menu, and returns focus", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.setViewportSize({ width: 640, height: 844 });
    await page.goto("/__fixtures__/settings/security?draft=dirty");
    const details = page.locator("details.bakery-section-navigation__mobile");
    const summary = details.locator("summary");
    await summary.click();
    await details.getByRole("link", { name: "Profile" }).click();
    await expect(details).toHaveJSProperty("open", false);
    await expect(summary).toBeFocused();
    await expect(page.getByTestId("navigation-status")).toHaveText(
      "Navigation prevented because the profile draft is dirty.",
    );
    await expect(page).toHaveURL(
      /\/__fixtures__\/settings\/security\?draft=dirty$/,
    );
  });

  test("supports keyboard operation and does not overflow at 320px or 200% zoom", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto("/__fixtures__/settings/security/password");
    const details = page.locator("details.bakery-section-navigation__mobile");
    const summary = details.locator("summary");
    await summary.focus();
    await summary.press("Enter");
    await summary.press("Tab");
    await expect(
      details.getByRole("link", { name: "Profile" }),
    ).toBeFocused();
    await details.getByRole("link", { name: "Appearance" }).press("Enter");
    await expect(page).toHaveURL("/__fixtures__/settings/appearance");
    await expect(page.getByRole("heading", { name: "Appearance", exact: true }))
      .toBeFocused();
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 640, height: 844 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("coarse Settings targets", () => {
  test.use({ hasTouch: true });

  test("keeps phone controls at least 44px tall", async ({ page }) => {
    await mockBootstrappedInstallation(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/__fixtures__/settings/profile");
    const details = page.locator("details.bakery-section-navigation__mobile");
    await details.locator("summary").click();
    const heights = await details.locator("summary, a").evaluateAll((
      elements,
    ) => elements.map((element) => element.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(1);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
    await expect.poll(() =>
      page.evaluate(() => matchMedia("(pointer: coarse)").matches)
    ).toBe(true);
  });
});
