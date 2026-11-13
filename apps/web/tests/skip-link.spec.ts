import { expect, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * The skip link (design-ux, #274) is invisible until it has focus, and when it
 * has focus it sits over the page without moving anything.
 */
for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: skip link`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("is hidden while focus is elsewhere, and overlays the page when focused without moving it", async ({ page }) => {
      await mockAuthenticatedSession(page);
      await page.route("**/v1/me/profile", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            principalId: "00000000-0000-4000-8000-000000000001",
            name: "Mark Tripoli",
            firstName: "Mark",
            lastName: "Tripoli",
            title: null,
            image: null,
            email: "me@marktripoli.com",
            emailVerified: true,
            version: 3,
            updatedAt: "2026-01-02T00:00:00.000Z",
          }),
        }));
      await page.goto("/settings/profile");
      const name = page.getByLabel("Display name");
      await expect(name).toBeVisible();
      const skip = page.getByRole("link", { name: "Skip to content" });
      // Focus is in a form field: the link takes no room and shows nothing.
      await name.focus();
      const hidden = await skip.boundingBox();
      expect(hidden?.width).toBeLessThanOrEqual(1);
      expect(hidden?.height).toBeLessThanOrEqual(1);
      const main = page.locator("main#bakery-main");
      const before = await main.boundingBox();
      const header = page.locator("header").first();
      const headerBefore = await header.boundingBox();
      const logoBefore = await page.getByText("Bakery", { exact: true })
        .first().boundingBox();
      // Keyboard focus reaches it: it shows over the page and moves nothing.
      await skip.focus();
      const shown = await skip.boundingBox();
      expect(shown?.width).toBeGreaterThan(40);
      expect(shown?.height).toBeGreaterThanOrEqual(40);
      expect(shown?.x).toBeGreaterThanOrEqual(0);
      expect(shown?.y).toBeGreaterThanOrEqual(0);
      expect(await main.boundingBox()).toEqual(before);
      expect(await header.boundingBox()).toEqual(headerBefore);
      expect(
        await page.getByText("Bakery", { exact: true }).first().boundingBox(),
      ).toEqual(logoBefore);
      // Evidence: a window-only capture at each size, focusing the link after the
      // resize (a resize can rebuild the shell and drop focus).
      for (
        const [only, size] of [
          ["desktop", { width: 1440, height: 900 }],
          ["mobile", { width: 390, height: 844 }],
        ] as const
      ) {
        await page.setViewportSize(size);
        await skip.focus();
        await shot(page, "skip-link-focused", [], { windowOnly: true, only });
      }
      // Leaving it hides it again.
      await name.focus();
      await expect.poll(async () => (await skip.boundingBox())?.width ?? 0)
        .toBeLessThanOrEqual(1);
    });
  });
}
