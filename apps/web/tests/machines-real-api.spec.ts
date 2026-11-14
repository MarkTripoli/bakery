import { type BrowserContext, expect, type Page, test } from "@playwright/test";

/**
 * These cases intentionally exercise the real API boundary. They stay gated
 * because the web origin must be backed by a running Bakery API; fixture
 * responses cannot prove worker authorization, projections, or no-store
 * behavior.
 */
const enabled = process.env.BAKERY_REAL_API === "1";
const email = process.env.BAKERY_REAL_EMAIL?.trim() ?? "";
const password = process.env.BAKERY_REAL_PASSWORD ?? "";
const nonAdminEmail = process.env.BAKERY_MACHINE_NON_ADMIN_EMAIL?.trim() ?? "";
const nonAdminPassword = process.env.BAKERY_MACHINE_NON_ADMIN_PASSWORD ?? "";
const organizationId = process.env.BAKERY_MACHINE_ORGANIZATION_ID?.trim() ?? "";
const offlineMachineId = process.env.BAKERY_MACHINE_OFFLINE_ID?.trim() ?? "";
const failedChecksMachineId =
  process.env.BAKERY_MACHINE_FAILED_CHECK_ID?.trim() ?? "";
const expiredEnrollmentId =
  process.env.BAKERY_MACHINE_EXPIRED_ENROLLMENT_ID?.trim() ?? "";
const forbiddenOrganizationId =
  process.env.BAKERY_MACHINE_FORBIDDEN_ORGANIZATION_ID?.trim() ?? "";

const refused: Readonly<Record<number, true>> = { 401: true, 403: true };

type SessionCookies = Parameters<BrowserContext["addCookies"]>[0];

/**
 * Session cookies per email for this worker process. Better Auth allows about
 * three sign-in attempts per ten seconds, so each credential set signs in
 * through the real form once and later tests restore that session.
 */
const sessions = new Map<string, SessionCookies>();

async function signIn(
  page: Page,
  credentials: Readonly<{ email?: string; password?: string }> = {},
): Promise<void> {
  const account = credentials.email ?? email;
  const saved = sessions.get(account);
  if (saved) {
    await page.context().addCookies(saved);
    await page.goto("/machines");
    await expect(page).not.toHaveURL(/\/sign-in/);
    return;
  }
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(account);
  await page.getByLabel("Password", { exact: true }).fill(
    credentials.password ?? password,
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  sessions.set(account, (await page.context().storageState()).cookies);
}

function organizationHeaders(id = organizationId): Record<string, string> {
  return { "Bakery-Organization-Id": id };
}

test.describe("real API machines unauthenticated cases", () => {
  test.skip(
    !enabled,
    "set BAKERY_REAL_API=1 with the web server proxied to a running API",
  );

  test("unauthenticated workers list is refused and the route keeps its deep link", async ({ page }) => {
    const response = await page.request.get("/v1/workers");
    expect(refused[response.status()]).toBe(true);

    await page.goto("/machines");
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("unauthenticated enrollment cannot issue a setup key", async ({ page }) => {
    const response = await page.request.post("/v1/worker-enrollments", {
      data: {
        name: "unauthorized-machine",
        architecture: "x86_64",
        capabilities: ["codex"],
        slots: 1,
      },
    });
    expect(refused[response.status()]).toBe(true);
    expect(await response.text()).not.toContain("enrollmentToken");
  });
});

test.describe("real API machines authenticated projections", () => {
  const authenticated = enabled && Boolean(email && password && organizationId);
  test.skip(
    !authenticated,
    "set BAKERY_REAL_API, BAKERY_REAL_EMAIL/PASSWORD, and BAKERY_MACHINE_ORGANIZATION_ID",
  );

  test("authenticated owner reaches the live list and detail routes", async ({ page }) => {
    await signIn(page);
    await page.goto("/machines");
    await expect(page.getByRole("heading", { name: "Machines" })).toBeVisible();
    await expect(page.getByTestId("machines-page")).toBeVisible();
    if (!offlineMachineId) return;
    await page.goto(`/machines/${offlineMachineId}`);
    await expect(page).toHaveURL(new RegExp(`/machines/${offlineMachineId}`));
    await expect(page.getByTestId("machine-detail-page")).toBeVisible();
    await expect(
      page.getByTestId("machine-detail-page").getByText("Offline", {
        exact: true,
      }).first(),
    ).toBeVisible();
  });

  test("non-Admin cannot see enrollment controls", async ({ page }) => {
    test.skip(
      !nonAdminEmail || !nonAdminPassword,
      "set BAKERY_MACHINE_NON_ADMIN_EMAIL/PASSWORD",
    );
    await signIn(page, {
      email: nonAdminEmail,
      password: nonAdminPassword,
    });
    await page.goto("/machines");
    await expect(page.getByTestId("machines-page")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add machine", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByTestId("machines-finishing-setup")).toHaveCount(0);
    await page.goto("/machines/new");
    await expect(page.getByText("Only administrators can add machines"))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
  });
  test("Admin enrollment uses idempotency and reveals setup once", async ({ page }) => {
    test.skip(
      process.env.BAKERY_MACHINE_RUN_MUTATIONS !== "1",
      "set BAKERY_MACHINE_RUN_MUTATIONS=1 for isolated real enrollment evidence",
    );
    await signIn(page);
    await page.goto("/machines/new");
    const name = `browser-machine-${crypto.randomUUID().slice(0, 8)}`;
    const requestPromise = page.waitForRequest((request) =>
      request.url().endsWith("/v1/worker-enrollments") &&
      request.method() === "POST"
    );
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("radio", { name: /Codex/ }).check({ force: true });
    await page.getByRole("button", { name: "Continue" }).click();
    const request = await requestPromise;
    expect(request.headers()["idempotency-key"]).toBeTruthy();
    await expect(page.locator('[data-ui-component="setupKey"]')).toBeVisible();
    // Leaving the page loses the code; the setup waits in "Finishing setup".
    await page.goto("/machines");
    const row = page.locator("[data-enrollment-id]").filter({ hasText: name });
    await expect(row).toBeVisible();
    const cancelResponsePromise = page.waitForResponse((response) =>
      response.url().includes("/v1/worker-enrollments/") &&
      response.request().method() === "PATCH"
    );
    await row.getByRole("button", { name: `Cancel setup of ${name}` }).click();
    expect((await cancelResponsePromise).ok()).toBeTruthy();
  });
  test("a non-member organization reads as not found", async ({ page }) => {
    test.skip(
      !forbiddenOrganizationId,
      "set BAKERY_MACHINE_FORBIDDEN_ORGANIZATION_ID",
    );
    await signIn(page);
    const response = await page.request.get("/v1/workers", {
      headers: organizationHeaders(forbiddenOrganizationId),
    });
    // Non-disclosure: an organization the principal does not belong to
    // answers exactly like one that does not exist.
    expect(response.status()).toBe(404);
    const body = await response.json() as Readonly<Record<string, unknown>>;
    expect(body.code).toBe("RESOURCE_NOT_FOUND");
    expect(body).not.toHaveProperty("items");
  });

  test("offline host projection stays explicit", async ({ page }) => {
    test.skip(!offlineMachineId, "set BAKERY_MACHINE_OFFLINE_ID");
    await signIn(page);
    const response = await page.request.get(`/v1/workers/${offlineMachineId}`, {
      headers: organizationHeaders(),
    });
    expect(response.status()).toBe(200);
    const body = await response.json() as {
      readonly connectivity: string;
      readonly name?: string;
    };
    expect(body.connectivity).toBe("offline");
    await page.goto(`/machines/${offlineMachineId}`);
    await expect(page.getByTestId("machine-detail-page")).toBeVisible();
    await expect(
      page.getByTestId("machine-detail-page").getByText("Offline", {
        exact: true,
      }).first(),
    ).toBeVisible();
  });
  test("failed-check reasons are bounded and never credential fields", async ({ page }) => {
    test.skip(!failedChecksMachineId, "set BAKERY_MACHINE_FAILED_CHECK_ID");
    await signIn(page);
    const response = await page.request.get(
      `/v1/workers/${failedChecksMachineId}/dispatch-blockers`,
      { headers: organizationHeaders() },
    );
    expect(response.status()).toBe(200);
    const body = await response.json() as {
      readonly failedChecks: readonly Readonly<
        { readonly checkId: string; readonly reason: string | null }
      >[];
      readonly credentialGeneration?: number;
      readonly allBlocked?: boolean;
      readonly blockedCapabilities?: readonly string[];
      readonly inventoryRevision?: number;
    };
    expect(body.failedChecks.length).toBeGreaterThan(0);
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining([
        "failedChecks",
        "credentialGeneration",
        "inventoryRevision",
      ]),
    );
    for (const check of body.failedChecks) {
      expect(Object.keys(check).sort()).toEqual(["checkId", "reason"]);
      expect(
        check.reason === null ||
          new TextEncoder().encode(check.reason).byteLength <= 8192,
      ).toBe(true);
    }
    expect(body).not.toHaveProperty("credential");
    expect(body).not.toHaveProperty("secret");
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("tokenHash");
    await page.goto(`/machines/${failedChecksMachineId}`);
    await expect(page.getByTestId("machine-detail-page")).toBeVisible();
    const visibleReason = body.failedChecks.find((check) => check.reason)
      ?.reason;
    if (visibleReason) {
      await expect(
        page.getByTestId("machine-detail-page").getByText(visibleReason, {
          exact: true,
        }).first(),
      ).toBeVisible();
    }
  });

  test("expired enrollment status is safe and token-free", async ({ page }) => {
    test.skip(!expiredEnrollmentId, "set BAKERY_MACHINE_EXPIRED_ENROLLMENT_ID");
    await signIn(page);
    const response = await page.request.get(
      `/v1/worker-enrollments/${expiredEnrollmentId}`,
      { headers: organizationHeaders() },
    );
    expect(response.status()).toBe(200);
    const body = await response.json() as {
      readonly state: string;
      readonly name?: string;
    };
    expect(body.state).toBe("expired");
    expect("enrollmentToken" in body).toBe(false);
    expect("tokenHash" in body).toBe(false);
    await page.goto("/machines");
    await expect(page.getByTestId("machines-page")).toBeVisible();
    if (body.name) {
      const row = page.locator(`[data-enrollment-name="${body.name}"]`);
      await expect(row).toContainText("Expired");
    }
  });
});
