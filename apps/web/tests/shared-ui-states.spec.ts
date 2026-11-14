import { expect, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * Two shared states (words/look audit 23 and 24, folded into #312): the
 * information notice draws an information glyph, not a document, and a disabled
 * primary button is not the brightest thing in the dark theme.
 */
const luminance = (color: string) => {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3)
    .map((value) => {
      const channel = Number(value) / 255;
      return channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test.describe("shared states", () => {
  test("the information notice draws an information glyph, not a document", async ({ page }) => {
    await mockAuthenticatedSession(page);
    await page.goto("/settings/sessions");
    const notice = page.locator(".ui-inline-notice--information");
    await expect(notice.first()).toBeVisible();
    await expect(
      notice.first().locator('[data-ui-component="iconGlyph"]'),
    ).toHaveAttribute("data-variant", "info");
    await expect(
      notice.first().locator('[data-variant="document"]'),
    ).toHaveCount(0);
    await shot(page, "information-notice");
  });

  test("a disabled primary button is dimmer than the text in the dark theme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await mockAuthenticatedSession(page);
    await page.route("**/v1/me/profile", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          principalId: "00000000-0000-4000-8000-000000000001",
          name: "Alex Morgan",
          firstName: "Alex",
          lastName: "Morgan",
          title: null,
          image: null,
          email: "alex.morgan@example.com",
          emailVerified: true,
          version: 3,
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
      }));
    await page.goto("/settings/profile");
    // Nothing changed yet, so Save is disabled.
    const save = page.getByRole("button", { name: "Save profile" });
    await expect(save).toBeDisabled();
    const [fill, text] = await save.evaluate((node) => [
      getComputedStyle(node).backgroundColor,
      getComputedStyle(document.body).color,
    ]);
    expect(luminance(fill), `${fill} against text ${text}`).toBeLessThan(
      luminance(text),
    );
    await shot(page, "disabled-primary");
  });
});
