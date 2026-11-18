import { expect, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";

test("redirect resolves once", async ({ page }) => {
  await mockAuthenticatedSession(page);
  await page.goto("/settings/clients");
  await page.waitForTimeout(2000);
  const url = page.url();
  console.log("FINAL_URL", url);
  expect(url).toMatch(/integrations\/clients$/);
  expect(url).not.toMatch(/clients\/settings/);
});
