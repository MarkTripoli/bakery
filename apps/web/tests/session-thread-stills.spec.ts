// Capture the session thread as the owner's evidence rule requires: the running
// state first, because that is what design-ux verifies before the rest exists.
//
// Two assertions guard each still. The state must actually be on screen: its
// distinguishing element is visible and inside the viewport, not below the fold.
// And every still is hashed, with the hashes required to differ, so a shot of
// the wrong state cannot pass as a duplicate of another one.
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { laneBudgetMs } from "./helpers/lane-budget.ts";
import { mockAuthenticatedSession } from "./helpers/mock-session.ts";

const OUT = process.env.CAPTURE_OUT ?? "/tmp/session-thread-shots";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

/** Each state names the element that exists only for it. */
const STATES = [
  {
    name: "running",
    marker: '[data-ui-component="sessionNowLine"][data-tone="active"]',
  },
  {
    name: "waiting",
    marker: '[data-ui-component="sessionNowLine"][data-tone="idle"]',
  },
  {
    name: "failed",
    marker: '[data-ui-component="sessionNowLine"][data-tone="danger"]',
  },
  {
    name: "lost",
    marker: '[data-ui-component="sessionNowLine"][data-tone="warning"]',
  },
  { name: "finished", marker: ".ui-session-thread__turn" },
  { name: "empty", marker: '[data-ui-component="emptyState"]' },
  { name: "wide", marker: ".ui-session-thread__usage" },
  { name: "loading", marker: '[data-ui-component="skeleton"]' },
  { name: "error", marker: '[data-ui-component="inlineNotice"]' },
] as const;

for (const theme of ["light", "dark"] as const) {
  for (const viewport of VIEWPORTS) {
    test(`session thread stills ${viewport.name} ${theme}`, async ({ page }) => {
      // Seven states in one still set outlives the default budget.
      test.setTimeout(laneBudgetMs(180_000));
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.emulateMedia({ colorScheme: theme });
      await mockAuthenticatedSession(page);
      await mkdir(OUT, { recursive: true });
      const digests = new Map<string, string>();

      for (const state of STATES) {
        await page.goto(`/__fixtures__/session-thread/${state.name}`);
        await expect(
          page.locator('[data-ui-component="sessionThread"]').or(
            page.locator('[data-ui-component="emptyState"]'),
          ).or(page.locator('[data-ui-component="skeleton"]')).or(
            page.locator('[data-ui-component="inlineNotice"]'),
          ).first(),
        ).toBeVisible({ timeout: 15_000 });

        const marker = page.locator(state.marker).first();
        await expect(marker, `${state.name} never showed its own marker`)
          .toBeVisible({ timeout: 15_000 });
        // Bring the marker into frame: the Now line sits below the fold once
        // the thread is long, which is how an earlier still photographed the
        // wrong state entirely.
        await marker.scrollIntoViewIfNeeded();
        await page.waitForTimeout(250);
        await expect(marker).toBeInViewport();

        const buffer = await page.screenshot();
        const digest = createHash("md5").update(buffer).digest("hex");
        const previous = digests.get(digest);
        expect(
          previous,
          `${state.name} rendered identically to ${previous}, so it has no evidence of its own`,
        ).toBeUndefined();
        digests.set(digest, state.name);
        await writeFile(
          `${OUT}/${state.name}-${viewport.name}-${theme}.png`,
          buffer,
        );
      }
    });
  }
}

/** The work under a message must be visible in one frame, not cut at the fold. */
test("session thread stills running tall light", async ({ page }) => {
  test.setTimeout(laneBudgetMs(120_000));
  await page.setViewportSize({ width: 1440, height: 1400 });
  await mockAuthenticatedSession(page);
  await mkdir(OUT, { recursive: true });
  await page.goto("/__fixtures__/session-thread/running");
  const now = page.locator('[data-ui-component="sessionNowLine"]').first();
  await expect(now).toBeVisible({ timeout: 15_000 });
  await expect(now).toBeInViewport();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/running-tall-light.png` });
});
