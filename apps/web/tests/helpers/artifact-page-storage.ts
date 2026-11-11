import { expect, test } from "@playwright/test";
import {
  json,
  PATH,
  problem,
  stubArtifactPage,
} from "./artifact-page-fixture.ts";
import { MOCK_ORGANIZATION_ID } from "./mock-session.ts";

for (const state of ["warning", "paused", "unavailable"] as const) {
  test(`Admin sees ${state} capacity without losing verified content`, async ({ page }) => {
    await stubArtifactPage(page);
    await page.route(
      "**/v1/organizations/*/effective-access",
      (route) =>
        route.fulfill(json({
          organizationId: MOCK_ORGANIZATION_ID,
          role: "admin",
          capabilities: [],
        })),
    );
    await page.route("**/v1/artifact-storage", (route) =>
      route.fulfill(json({
        state,
        totalBytes: 1000,
        availableBytes: 20,
        usedPercent: 98,
        retainedBytes: 400,
        pinnedBytes: 100,
      })));
    await page.goto(PATH);
    const banner = page.locator('[data-ui-component="capacityBanner"]');
    await expect(banner).toHaveAttribute(
      "data-state",
      state === "warning" ? "warning" : "paused",
    );
    await expect(banner).toContainText(
      "Retained: 400 bytes · Pinned: 100 bytes",
    );
    await expect(page.locator('[data-ui-component="artifactViewer"]'))
      .toBeVisible();
    await expect(page.getByTestId("artifact-retrieval-download")).toBeEnabled();
    await page.route("**/v1/artifact-storage", (route) =>
      route.fulfill(json({
        state: "normal",
        totalBytes: 1000,
        availableBytes: 600,
        usedPercent: 40,
        retainedBytes: 400,
        pinnedBytes: 100,
      })));
    await banner.getByRole("button", { name: "Refresh storage" }).click();
    await expect(banner).toHaveCount(0);
  });
}

test("failed capacity lookup can retry without blocking artifact content", async ({ page }) => {
  await stubArtifactPage(page);
  await page.route(
    "**/v1/organizations/*/effective-access",
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: "admin",
        capabilities: [],
      })),
  );
  await page.route(
    "**/v1/artifact-storage",
    (route) => route.fulfill(problem(503, "DEPENDENCY_UNAVAILABLE")),
  );
  await page.goto(PATH);
  await expect(page.getByText("Storage capacity could not be loaded."))
    .toBeVisible();
  await expect(page.locator('[data-ui-component="artifactViewer"]'))
    .toBeVisible();
  await page.route("**/v1/artifact-storage", (route) =>
    route.fulfill(json({
      state: "unmonitored",
      totalBytes: 0,
      availableBytes: 0,
      usedPercent: 0,
      retainedBytes: 400,
      pinnedBytes: 100,
    })));
  await page.getByRole("button", { name: "Refresh storage" }).click();
  await expect(page.getByText("Storage capacity could not be loaded."))
    .toHaveCount(0);
  await expect(page.locator('[data-ui-component="capacityBanner"]'))
    .toHaveCount(0);
});

test("Developer never requests Admin storage totals", async ({ page }) => {
  await stubArtifactPage(page);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/artifact-storage")) {
      requests.push(request.url());
    }
  });
  await page.goto(PATH);
  await expect(page.locator('[data-ui-component="artifactViewer"]'))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh storage" }))
    .toHaveCount(0);
  expect(requests).toEqual([]);
});
