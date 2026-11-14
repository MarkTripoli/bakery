import { expect, type Page, test } from "@playwright/test";
import {
  adminMachinesFixture,
  MACHINE_ID,
} from "./helpers/machines-fixture.ts";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * The trail in the top bar (design-ux, #56 part 3): every crumb except the
 * last leads to its page, the last is the current page, and the first crumb
 * leads to its area's first page. A click moves within the app.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const trail = (page: Page) =>
  page.getByRole("navigation", { name: "Breadcrumb" });

test("Machines: Workspace leads to Work, the last crumb is the current page", async ({ page }) => {
  await adminMachinesFixture(page);
  await page.goto("/machines");
  await expect(trail(page).getByText("Machines")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(trail(page).getByRole("link")).toHaveText(["Workspace"]);
  await expect(trail(page).getByRole("link", { name: "Workspace" }))
    .toHaveAttribute("href", "/tasks");
  await page.mouse.move(900, 600);
  await shot(page, "breadcrumbs-machines");
});

test("a machine's page links to Workspace and Machines, and a click moves without a page load", async ({ page }) => {
  await adminMachinesFixture(page);
  await page.goto(`/machines/${MACHINE_ID}`);
  const links = trail(page).getByRole("link");
  await expect(links).toHaveText(["Workspace", "Machines"]);
  await expect(links.nth(1)).toHaveAttribute("href", "/machines");
  await expect(trail(page).locator("[aria-current=page]")).toHaveCount(1);
  // A page load would drop this marker.
  await page.evaluate(() => {
    (globalThis as unknown as { __kept: number }).__kept = 1;
  });
  await links.nth(1).click();
  await expect(page).toHaveURL(/\/machines$/);
  expect(
    await page.evaluate(() =>
      (globalThis as unknown as { __kept: number }).__kept
    ),
  ).toBe(1);
});

test("a settings sub-page: Settings leads to the first settings page, the section to its own", async ({ page }) => {
  await mockAuthenticatedSession(page);
  await page.goto("/settings/security/passkeys");
  await expect(trail(page).getByRole("link", { name: "Settings" }))
    .toHaveAttribute("href", "/settings/profile");
  await expect(
    trail(page).getByRole("link", { name: "Account & security" }),
  ).toHaveAttribute("href", /\/settings\/security$/);
  await expect(trail(page).locator("[aria-current=page]")).toHaveCount(1);
  await page.mouse.move(900, 600);
  await shot(page, "breadcrumbs-settings");
});

test("a crumb takes keyboard focus with a visible ring and opens with Enter", async ({ page }) => {
  await adminMachinesFixture(page);
  await page.goto(`/machines/${MACHINE_ID}`);
  const machines = trail(page).getByRole("link", { name: "Machines" });
  await machines.focus();
  await expect(machines).toBeFocused();
  const ring = await machines.evaluate((node) => {
    const style = getComputedStyle(node);
    return { outline: style.outlineStyle, width: style.outlineWidth };
  });
  expect(ring.outline).not.toBe("none");
  await page.mouse.move(900, 600);
  await shot(page, "breadcrumbs-focus");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/machines$/);
});
