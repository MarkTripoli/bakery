import assert from "node:assert/strict";
import process from "node:process";
import { chromium, expect } from "@playwright/test";

async function readInput() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

async function assertArtifactPage(page, fixture) {
  await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("heading", { name: fixture.artifactName }))
    .toBeVisible();
  const details = page.getByTestId("artifact-retrieval-details-toggle");
  if (await details.getAttribute("aria-expanded") === "false") {
    await details.click();
  }
  await expect(page.getByTestId("artifact-retrieval-metadata"))
    .toContainText(fixture.artifactId);
  await expect(page.getByTestId("artifact-retrieval-metadata"))
    .toContainText(fixture.versionId);
  await expect(page.getByTestId("artifact-version-1")).toContainText(
    "Revision 1",
  );
  await expect(page.getByTestId("artifact-retrieval-provenance"))
    .toContainText(fixture.sha256);
  await expect(page.getByTestId("artifact-retrieval-provenance"))
    .toContainText(String(fixture.sizeBytes));
  await expect(page.getByTestId("artifact-retrieval-version-metadata"))
    .toContainText("seeded/read proof only");
  await expect(page.getByTestId("artifact-retrieval-version-metadata"))
    .toContainText("not-a-coding-result");
}

async function run() {
  const { baseUrl, fixture, sessionCookie } = await readInput();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      await context.addCookies([{
        name: "better-auth.session_token",
        value: sessionCookie.split("=", 2)[1],
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      }]);
      await context.addInitScript((organizationId) => {
        localStorage.setItem(
          "bakery.organization.lastSelected.v1",
          organizationId,
        );
      }, fixture.organizationId);
      const page = await context.newPage();
      const deepLink =
        `${baseUrl}/tasks/${fixture.taskId}/artifacts/${fixture.artifactId}`;

      await page.goto(`${baseUrl}/tasks/${fixture.taskId}`, {
        waitUntil: "domcontentloaded",
      });
      const artifactLink = page.getByRole("link", {
        name: fixture.artifactName,
        exact: true,
      });
      await artifactLink.waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(
        await artifactLink.getAttribute("href"),
        `/tasks/${fixture.taskId}/artifacts/${fixture.artifactId}`,
      );
      await artifactLink.click();
      await expect(page).toHaveURL(deepLink);
      await assertArtifactPage(page, fixture);

      await page.reload({ waitUntil: "domcontentloaded" });
      await assertArtifactPage(page, fixture);

      await page.goto(deepLink, { waitUntil: "domcontentloaded" });
      await assertArtifactPage(page, fixture);

      const extractionResponse = page.waitForResponse((response) =>
        response.url().includes(
          `/v1/artifact-versions/${fixture.versionId}/extract?`,
        )
      );
      await page.getByLabel("Start byte").fill("7");
      await page.getByTestId("artifact-retrieval-extract").click();
      const extracted = await extractionResponse;
      assert.equal(extracted.status(), 200);
      const extractionBody = await extracted.json();
      assert.equal(extractionBody.versionId, fixture.versionId);
      assert.equal(extractionBody.sha256, fixture.sha256);
      assert.equal(extractionBody.startByte, 7);
      assert.equal(extractionBody.endByteExclusive, fixture.sizeBytes);
      assert.equal(extractionBody.text, fixture.contentText.slice(7));
      await expect(page.getByTestId("artifact-retrieval-extraction-text"))
        .toContainText(fixture.contentText.slice(7));

      await page.goto(
        `${baseUrl}/tasks/${fixture.wrongTaskId}/artifacts/${fixture.artifactId}`,
        { waitUntil: "domcontentloaded" },
      );
      await expect(page.getByTestId("artifact-retrieval-unavailable"))
        .toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(fixture.contentText)).toHaveCount(0);

      console.log("ARTIFACT_PHONE_BROWSER_PROOF=passed");
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
