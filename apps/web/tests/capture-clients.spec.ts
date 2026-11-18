import { expect, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";

// Evidence capture for the clients-move slice at the head under review. Gated
// on BAKERY_EVIDENCE_DIR so it never runs as a gate; it writes what the PR
// shows and nothing else.
const shotDir = process.env.BAKERY_EVIDENCE_DIR;

if (shotDir !== undefined) {
  const shapes = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ] as const;

  const screens = [
    { name: "clients-list", fixture: "/__fixtures__/auth/clients-default" },
    { name: "clients-empty", fixture: "/__fixtures__/auth/clients-empty" },
    { name: "clients-revoked", fixture: "/__fixtures__/auth/clients-revoked" },
  ] as const;

  test.describe("clients evidence", () => {
    for (const shape of shapes) {
      for (const theme of ["light", "dark"] as const) {
        test(`stills (${shape.name}, ${theme})`, async ({ page }) => {
          await page.setViewportSize({
            width: shape.width,
            height: shape.height,
          });
          await mockAuthenticatedSession(page);
          await page.emulateMedia({ colorScheme: theme });
          for (const screen of screens) {
            await page.goto(screen.fixture);
            await expect(page.locator("main h1")).toHaveCount(1);
            await page.waitForTimeout(600);
            await page.screenshot({
              path: `${shotDir}/${screen.name}-${shape.name}-${theme}.png`,
              fullPage: true,
            });
          }
        });
      }
    }

    // The moved route, on the production path, plus the old path redirecting
    // onto it. This is the part a fixture cannot prove.
    test("the moved route and the redirect (desktop, light)", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await mockAuthenticatedSession(page);
      await page.goto("/settings/clients");
      await expect(page).toHaveURL(
        /\/settings\/organization\/integrations\/clients$/,
      );
      await page.locator("main h1").waitFor();
      await page.waitForTimeout(900);
      await page.screenshot({
        path: `${shotDir}/clients-moved-route-desktop-light.png`,
        fullPage: true,
      });
    });

    // Approving a stuck decision and then deleting it: the revoke dialog and
    // the state after the decision is recorded.
    test("the revoke dialog and its result (desktop, light)", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await mockAuthenticatedSession(page);
      await page.goto("/__fixtures__/auth/clients-default");
      await page.locator("main h1").waitFor();
      await page.getByRole("button", { name: /^Revoke access for / }).first()
        .click();
      await page.getByRole("heading", { name: "Revoke client access?" })
        .waitFor();
      await page.waitForTimeout(400);
      await page.screenshot({
        path: `${shotDir}/clients-revoke-dialog-desktop-light.png`,
        fullPage: true,
      });
    });
  });
}
