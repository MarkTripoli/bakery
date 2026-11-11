import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

const ENROLLMENT_ID = "00000000-0000-4000-8000-0000000000e1";
const EXPIRES_AT = "2026-01-01T01:00:00.000Z";
const SETUP_KEY = "fixture-enrollment-token-0001";

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function adminMachinesFixture(page: Page) {
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: "admin",
        capabilities: [],
      })),
  );
  await page.route(
    (url) => url.pathname === "/v1/workers",
    (route) => route.fulfill(json({ items: [], nextCursor: null })),
  );
  await page.route(
    (url) => url.pathname === "/v1/worker-enrollments",
    (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill(json({
          enrollmentId: ENROLLMENT_ID,
          enrollmentToken: SETUP_KEY,
          expiresAt: EXPIRES_AT,
        }, 201));
      }
      return route.fulfill(json({ items: [], nextCursor: null }));
    },
  );
  await page.route(
    `**/v1/worker-enrollments/${ENROLLMENT_ID}`,
    (route) =>
      route.fulfill(json({
        enrollmentId: ENROLLMENT_ID,
        organizationId: MOCK_ORGANIZATION_ID,
        state: "pending",
        expiresAt: EXPIRES_AT,
        workerHostId: null,
        worker: null,
        version: 1,
        snapshotCursor: null,
      })),
  );
}

test.describe("machine enrollment setup panel", () => {
  test("Admin enrollment reveals the setup panel with its status line", async ({ page }) => {
    await adminMachinesFixture(page);
    await page.goto("/machines");
    const enrollment = page.getByTestId("machine-enrollment");
    await expect(enrollment).toBeVisible();

    const requestPromise = page.waitForRequest((request) =>
      new URL(request.url()).pathname === "/v1/worker-enrollments" &&
      request.method() === "POST"
    );
    await enrollment.getByLabel("Machine name").fill("fixture-machine");
    await enrollment.getByRole("button", { name: "Create enrollment" })
      .click();
    expect((await requestPromise).headers()["idempotency-key"]).toBeTruthy();

    const panel = page.getByTestId("machine-enrollment-token");
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-ui-component="setupKey"]'))
      .toContainText(SETUP_KEY);
    await expect(
      panel.getByRole("status").filter({ hasText: /^Status: / }),
    ).toHaveText("Status: Pending. Worker: Waiting for the worker.");
    const instructions = panel.locator('[data-ui-component="codeBlock"]');
    await expect(instructions).toContainText("BAKERY_CLAUDE_HARNESS=1");
    await expect(instructions).toContainText(
      "BAKERY_CLAUDE_HARNESS_EXECUTABLE=claude",
    );
    await expect(instructions).not.toContainText(/codex|BAKERY_PI_/i);
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
  });
});
