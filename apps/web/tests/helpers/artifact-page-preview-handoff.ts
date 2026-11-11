import { expect, type Page, test } from "@playwright/test";
import {
  ARTIFACT_ID,
  CONTENT,
  json,
  PATH,
  problem,
  stubArtifactPage,
  TASK_ID,
  version,
  VERSION_ID,
} from "./artifact-page-fixture.ts";

const PREVIEW_ORIGIN = "https://preview.example.test";
const EXCHANGE_URL = `${PREVIEW_ORIGIN}/artifact-preview/exchange`;
const GRANT_ID = "00000000-0000-4000-8000-0000000000a1";
const REVISION_PATH =
  `/tasks/${TASK_ID}/artifacts/${ARTIFACT_ID}?version=${VERSION_ID}`;

function newGrant(secret: string, secondsFromNow = 30) {
  return {
    grantId: GRANT_ID,
    grant: secret,
    exchangeUrl: EXCHANGE_URL,
    expiresAt: new Date(Date.now() + secondsFromNow * 1000).toISOString(),
    revisionPath: REVISION_PATH,
  };
}

async function configurePreview(page: Page, secret: string) {
  await page.route(
    "**/v1/artifact-preview-availability",
    (route) => route.fulfill(json({ available: true })),
  );
  await page.route(
    `**/v1/artifact-versions/${VERSION_ID}/preview-grants`,
    (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify(newGrant(secret)),
      }),
  );
}

function secret(): string {
  return crypto.randomUUID().replaceAll("-", "").padEnd(43, "x");
}

test("preview handoff stays hidden behind one note when no preview origin is configured", async ({ page }) => {
  let created = 0;
  await stubArtifactPage(page);
  await page.route(
    `**/v1/artifact-versions/${VERSION_ID}/preview-grants`,
    (route) => {
      created++;
      return route.abort();
    },
  );
  await page.goto(PATH);
  await expect(page.getByTestId("artifact-preview-unavailable")).toHaveText(
    "Previews are not set up for this deployment. Download the file to inspect it.",
  );
  await expect(page.getByTestId("artifact-preview-prepare")).toHaveCount(0);
  expect(created).toBe(0);
});

test("preview handoff posts the grant in a form body to a new tab and drops the secret", async ({ page }) => {
  const grant = secret();
  await stubArtifactPage(page);
  await configurePreview(page, grant);
  const exchanges: { method: string; url: string; body: string | null }[] = [];
  await page.context().route(`${PREVIEW_ORIGIN}/**`, (route) => {
    const request = route.request();
    exchanges.push({
      method: request.method(),
      url: request.url(),
      body: request.postData(),
    });
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<h1>mock isolated preview</h1>",
    });
  });
  await page.goto(PATH);
  await page.getByTestId("artifact-preview-prepare").click();
  const form = page.getByTestId("artifact-preview-form");
  await expect(form).toHaveAttribute("method", "post");
  await expect(form).toHaveAttribute("target", "_blank");
  // No noreferrer: the exchange needs the Origin header; COOP severs the opener.
  await expect(form).not.toHaveAttribute("rel", /noreferrer/);
  await expect(form).toHaveAttribute("action", EXCHANGE_URL);
  await expect(form.locator('input[name="grant"]')).toHaveValue(grant);
  await expect(page.getByRole("timer")).toContainText("expires in");
  // The original revision link stays visible while the preview is open.
  await expect(page.getByTestId("artifact-preview-revision-link"))
    .toHaveAttribute("href", REVISION_PATH);
  const [popup] = await Promise.all([
    page.context().waitForEvent("page"),
    page.getByTestId("artifact-preview-open").click(),
  ]);
  await expect(popup.locator("h1")).toHaveText("mock isolated preview");
  expect(exchanges).toEqual([{
    method: "POST",
    url: EXCHANGE_URL,
    body: `grant=${grant}`,
  }]);
  // The secret leaves the page once the browser has submitted it.
  await expect(page.getByTestId("artifact-preview-form")).toHaveCount(0);
  await expect(page.getByText("Preview opened in a new tab.", { exact: false }))
    .toBeVisible();
  expect(await page.content()).not.toContain(grant);
  expect(page.url()).not.toContain(grant);
  await expect(page.getByTestId("artifact-preview-revision-link"))
    .toHaveAttribute("href", REVISION_PATH);
});

test("closing a preview revokes its grant with an idempotency key", async ({ page }) => {
  await stubArtifactPage(page);
  await configurePreview(page, secret());
  const revocations: { key: string | undefined; url: string }[] = [];
  await page.route(`**/v1/artifact-preview-grants/${GRANT_ID}`, (route) => {
    revocations.push({
      key: route.request().headers()["idempotency-key"],
      url: route.request().url(),
    });
    return route.fulfill({ status: 204 });
  });
  await page.goto(PATH);
  await page.getByTestId("artifact-preview-prepare").click();
  await page.getByTestId("artifact-preview-close").click();
  await expect(page.getByText("Preview closed.", { exact: true }))
    .toBeVisible();
  await expect(page.getByTestId("artifact-preview-form")).toHaveCount(0);
  expect(revocations).toHaveLength(1);
  expect(revocations[0].key).toBeTruthy();
  expect(new URL(revocations[0].url).search).toBe("");
});

test("a failed close says so and can be retried", async ({ page }) => {
  await stubArtifactPage(page);
  await configurePreview(page, secret());
  let attempts = 0;
  await page.route(`**/v1/artifact-preview-grants/${GRANT_ID}`, (route) => {
    attempts++;
    return attempts === 1
      ? route.fulfill(problem(500, "INTERNAL"))
      : route.fulfill({ status: 204 });
  });
  await page.goto(PATH);
  await page.getByTestId("artifact-preview-prepare").click();
  await page.getByTestId("artifact-preview-close").click();
  await expect(page.getByText("The preview could not be closed. Try again."))
    .toBeVisible();
  await page.getByTestId("artifact-preview-close").click();
  await expect(page.getByText("Preview closed.", { exact: true }))
    .toBeVisible();
});

test("an unused grant expires after 30 seconds and the secret is dropped", async ({ page }) => {
  const grant = secret();
  await page.clock.install();
  await stubArtifactPage(page);
  await configurePreview(page, grant);
  await page.goto(PATH);
  await page.getByTestId("artifact-preview-prepare").click();
  await expect(page.getByTestId("artifact-preview-form")).toBeVisible();
  await page.clock.fastForward(31_000);
  await expect(page.getByText("The preview link expired.", { exact: false }))
    .toBeVisible();
  await expect(page.getByTestId("artifact-preview-form")).toHaveCount(0);
  expect(await page.content()).not.toContain(grant);
  // Re-preparing issues a fresh grant; the expired one can still be closed.
  await expect(page.getByTestId("artifact-preview-close")).toBeVisible();
  await page.getByTestId("artifact-preview-prepare").click();
  await expect(page.getByTestId("artifact-preview-form")).toBeVisible();
});

test("a preparation failure is reported and can be retried", async ({ page }) => {
  await stubArtifactPage(page);
  await page.route(
    "**/v1/artifact-preview-availability",
    (route) => route.fulfill(json({ available: true })),
  );
  let attempts = 0;
  await page.route(
    `**/v1/artifact-versions/${VERSION_ID}/preview-grants`,
    (route) => {
      attempts++;
      return attempts === 1
        ? route.fulfill({
          status: 500,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "https://bakery.example/problems/internal",
            title: "Internal",
            detail: "Stubbed failure.",
            status: 500,
            code: "INTERNAL",
            requestId: TASK_ID,
            traceId: ARTIFACT_ID,
            retryable: false,
          }),
        })
        : route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(newGrant(secret())),
        });
    },
  );
  await page.goto(PATH);
  await page.getByTestId("artifact-preview-prepare").click();
  await expect(
    page.getByText("The preview could not be prepared. Try again."),
  ).toBeVisible();
  await page.getByTestId("artifact-preview-prepare").click();
  await expect(page.getByTestId("artifact-preview-form")).toBeVisible();
});

test("a server that lost its preview origin turns the action into the note", async ({ page }) => {
  await stubArtifactPage(page);
  await page.route(
    "**/v1/artifact-preview-availability",
    (route) => route.fulfill(json({ available: true })),
  );
  await page.route(
    `**/v1/artifact-versions/${VERSION_ID}/preview-grants`,
    (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://bakery.example/problems/state-conflict",
          title: "Conflict",
          detail: "Stubbed conflict.",
          status: 409,
          code: "STATE_CONFLICT",
          reason: "preview_origin_not_configured",
          requestId: TASK_ID,
          traceId: ARTIFACT_ID,
          retryable: false,
        }),
      }),
  );
  await page.goto(PATH);
  await page.getByTestId("artifact-preview-prepare").click();
  await expect(page.getByTestId("artifact-preview-unavailable")).toBeVisible();
  await expect(page.getByTestId("artifact-preview-prepare")).toHaveCount(0);
});

test("download-only media never offers a preview", async ({ page }) => {
  let availability = 0;
  await stubArtifactPage(page, {
    current: version(CONTENT, "application/octet-stream"),
  });
  await page.route("**/v1/artifact-preview-availability", (route) => {
    availability++;
    return route.fulfill(json({ available: true }));
  });
  await page.goto(PATH);
  await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
  await expect(page.getByTestId("artifact-preview-handoff")).toHaveCount(0);
  await expect(page.getByTestId("artifact-preview-prepare")).toHaveCount(0);
  expect(availability).toBe(0);
});
