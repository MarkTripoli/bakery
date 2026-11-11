import { expect, test } from "@playwright/test";
import {
  ARTIFACT,
  ARTIFACT_ID,
  json,
  PATH,
  stubArtifactPage,
} from "./artifact-page-fixture.ts";
import { MOCK_ORGANIZATION_ID, MOCK_PRINCIPAL_ID } from "./mock-session.ts";

test("Admin pins with If-Match and must confirm the retention warning before unpinning", async ({ page }) => {
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
  let revision = 1;
  let pinned = false;
  const updates: unknown[] = [];
  await page.route(`**/v1/artifacts/${ARTIFACT_ID}`, (route) => {
    if (route.request().method() === "PATCH") {
      expect(route.request().headers()["if-match"]).toBe(`"v${revision}"`);
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      const input = route.request().postDataJSON();
      updates.push(input);
      pinned = input.pinned;
      revision++;
    }
    const metadata = {
      id: ARTIFACT_ID,
      pinnedAt: pinned ? ARTIFACT.createdAt : null,
      pinnedBy: pinned ? MOCK_PRINCIPAL_ID : null,
      version: revision,
    };
    return route.fulfill(
      json(
        route.request().method() === "PATCH"
          ? { ...metadata, pinned, unpinEligible: false }
          : { ...ARTIFACT, ...metadata },
      ),
    );
  });
  await page.goto(PATH);
  await expect(
    page.getByRole("button", { name: "Unpin artifact", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Pin artifact", exact: true }).click();
  await expect.poll(() => updates).toEqual([{ pinned: true }]);
  await page.getByRole("button", { name: "Unpin artifact", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Unpin artifact" });
  await expect(dialog).toContainText(
    "Unpinning allows expired versions to be collected. It does not delete bytes immediately.",
  );
  expect(updates).toEqual([{ pinned: true }]);
  await dialog.getByRole("button", { name: "Unpin artifact", exact: true })
    .click();
  await expect.poll(() => updates).toEqual([{ pinned: true }, {
    pinned: false,
  }]);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pin artifact", exact: true }))
    .toBeEnabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "Pin artifact", exact: true }))
    .toBeEnabled();
});

test("Developer has no pin or unpin controls", async ({ page }) => {
  await stubArtifactPage(page);
  const access = page.waitForResponse((response) =>
    response.url().includes("/effective-access")
  );
  await page.goto(PATH);
  expect((await access).status()).toBe(200);
  await expect(page.getByTestId("artifact-retrieval-download")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pin artifact", exact: true }))
    .toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Unpin artifact", exact: true }),
  ).toHaveCount(0);
});
