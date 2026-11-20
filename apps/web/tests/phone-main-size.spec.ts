import { expect, test } from "@playwright/test";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";

// PR 535 compares four phone screens pixel for pixel. This navigation change
// must not touch the compared box, so each <main> keeps its exact size
// (issue 233, design-ux row 88eaf525, qa-qa constraint).
// These are the sizes this navigation change measured before and after itself.
// Changing one means the control moved into or out of the compared box.
const regions = [
  { path: "/settings/security/passkeys", size: { width: 390, height: 397 } },
  { path: "/settings/security", size: { width: 390, height: 656 } },
  { path: "/settings/sessions", size: { width: 390, height: 350 } },
  { path: "/settings/password", size: { width: 390, height: 322 } },
] as const;

test.use({ viewport: { width: 390, height: 844 } });

for (const region of regions) {
  test(`phone main keeps its compared box: ${region.path}`, async ({ page }) => {
    await mockAuthenticatedSession(page);
    await page.goto(region.path);
    const main = page.locator("main");
    await expect(main).toBeVisible();
    const box = await main.boundingBox();
    expect(box).not.toBeNull();
    console.log();
    expect({
      width: Math.round(box?.width ?? 0),
      height: Math.round(box?.height ?? 0),
    }).toEqual(region.size);
  });
}
