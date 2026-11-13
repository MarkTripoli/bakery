import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

const LONG_NAME = "build-claude-worker-with-a-long-hostname";

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

function worker(id: string, name: string, readiness: string) {
  return {
    id,
    principalId: "00000000-0000-4000-8000-0000000000b0",
    name,
    os: "macos",
    architecture: "arm64",
    capabilities: ["claude", "codex"],
    toolchainVersions: {},
    slots: 1,
    status: "online",
    desiredMode: "accepting",
    connectivity: "online",
    readiness,
    readinessReason: readiness === "ready" ? null : "check_failed",
    failedCheckIds: [],
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    credentialGeneration: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
}

const WORKERS = [
  worker("00000000-0000-4000-8000-0000000000b1", LONG_NAME, "ready"),
  worker(
    "00000000-0000-4000-8000-0000000000b2",
    "linux-builder-x86-02",
    "needs_attention",
  ),
];

const PENDING_ID = "00000000-0000-4000-8000-0000000000e2";
const PENDING_NAME = "mini2-codex-pending-enrollment-host";
const EXPIRED_NAME = "mini3-expired-enrollment-host";

function enrollment(id: string, name: string, state: string) {
  return {
    enrollmentId: id,
    name,
    state,
    os: "macos",
    architecture: "arm64",
    capabilities: ["claude"],
    slots: 1,
    expiresAt: "2026-01-01T01:00:00.000Z",
    consumedAt: null,
    canceledAt: null,
    workerHostId: null,
    replacementOfId: null,
    targetWorkerHostId: null,
    version: 1,
  };
}

const ENROLLMENTS = [
  enrollment(PENDING_ID, PENDING_NAME, "pending"),
  enrollment("00000000-0000-4000-8000-0000000000e3", EXPIRED_NAME, "expired"),
];

async function machinesFixture(page: Page) {
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
    (route) => route.fulfill(json({ items: WORKERS, nextCursor: null })),
  );
  await page.route(
    (url) => url.pathname.startsWith("/v1/workers/"),
    (route) => route.fulfill(json({ items: [], nextCursor: null })),
  );
  await page.route(
    (url) => url.pathname === "/v1/worker-enrollments",
    (route) => route.fulfill(json({ items: ENROLLMENTS, nextCursor: null })),
  );
  await page.route(
    (url) => url.pathname.startsWith("/v1/worker-enrollments/"),
    (route) =>
      route.fulfill(json({
        enrollmentId: PENDING_ID,
        organizationId: MOCK_ORGANIZATION_ID,
        state: route.request().method() === "PATCH" ? "canceled" : "pending",
        expiresAt: "2026-01-01T01:00:00.000Z",
        workerHostId: null,
        worker: null,
        version: 2,
        snapshotCursor: null,
      })),
  );
}

test.describe("machines list layout", () => {
  test(
    "phone width stacks machine rows with readable names",
    async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "phone layout only");
      await machinesFixture(page);
      await page.goto("/machines");
      const machines = page.getByRole("list", { name: "Machines" });
      await expect(machines).toBeVisible();
      await expect(page.getByRole("table", { name: "Machines" })).toHaveCount(
        0,
      );
      const rows = machines.locator('[data-ui-component="stackedRow"]');
      await expect(rows).toHaveCount(WORKERS.length);
      await expect(machines.getByRole("listitem")).toHaveCount(WORKERS.length);

      for (const item of WORKERS) {
        const row = machines.locator(`[data-machine-id="${item.id}"]`);
        await expect(row).toContainText(item.name);
        const button = row.getByRole("button");
        await expect(button).toHaveCount(1);
        const box = await button.boundingBox();
        expect(box?.height ?? 999).toBeGreaterThanOrEqual(44);
        expect(box?.height ?? 999).toBeLessThan(64);
      }
      // One badge, one line and one button per machine, and no second status.
      const first = rows.first();
      await expect(first).toContainText("macOS · Claude Code, Codex · 1 slot");
      await expect(first).toContainText("Ready");
      await expect(first.getByRole("button", { name: `Open ${LONG_NAME}` }))
        .toBeVisible();
      const second = rows.nth(1);
      await expect(second).toContainText("Needs attention");
      await expect(
        second.getByRole("button", { name: "Fix linux-builder-x86-02" }),
      )
        .toBeVisible();
      for (const word of ["Connectivity", "Last heartbeat", "Readiness"]) {
        await expect(machines).not.toContainText(word);
      }

      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);

      await machines.getByRole("button", { name: `Open ${LONG_NAME}` }).click();
      await expect(page).toHaveURL(new RegExp(`/machines/${WORKERS[0]!.id}$`));
    },
  );

  test("desktop keeps the machines table", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop layout only");
    await machinesFixture(page);
    await page.goto("/machines");
    const table = page.getByRole("table", { name: "Machines" });
    await expect(table).toBeVisible();
    await expect(page.locator('[data-ui-component="stackedRow"]'))
      .toHaveCount(0);
    await expect(table.getByRole("link", { name: `Open ${LONG_NAME}` }))
      .toBeVisible();
    await expect(
      table.getByRole("link", { name: "Fix linux-builder-x86-02" }),
    ).toBeVisible();
    // Three columns: the machine and its line, one badge, one button.
    await expect(table.getByRole("columnheader")).toHaveText([
      "Machine",
      "Status",
      "Action",
    ]);
  });

  test(
    "phone width stacks enrollments with whole-word actions",
    async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "phone layout only");
      await machinesFixture(page);
      await page.goto("/machines");
      const list = page.getByRole("list", { name: "Worker enrollments" });
      await expect(list).toBeVisible();
      await expect(page.getByRole("table", { name: "Worker enrollments" }))
        .toHaveCount(0);
      await expect(list.locator('[data-ui-component="stackedRow"]'))
        .toHaveCount(ENROLLMENTS.length);

      const pending = page.locator(`[data-enrollment-name="${PENDING_NAME}"]`);
      const expired = page.locator(`[data-enrollment-name="${EXPIRED_NAME}"]`);
      await expect(pending).toContainText("Pending");
      await expect(pending).toContainText("Expires:");
      await expect(expired).toContainText("Expired");
      await expect(expired.getByRole("button")).toHaveCount(0);

      for (const label of ["Cancel", "Replace"]) {
        const button = pending.getByRole("button", { name: label });
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box?.height ?? 999).toBeGreaterThanOrEqual(44);
        expect(box?.height ?? 999).toBeLessThan(64);
        const fit = await button.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return {
            lines: new Set(
              [...range.getClientRects()].map((rect) => Math.round(rect.top)),
            ).size,
            scroll: element.scrollWidth,
            client: element.clientWidth,
          };
        });
        expect(fit.lines).toBe(1);
        expect(fit.scroll).toBeLessThanOrEqual(fit.client);
      }

      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);

      const cancel = page.waitForRequest((request) =>
        new URL(request.url()).pathname ===
          `/v1/worker-enrollments/${PENDING_ID}` &&
        request.method() === "PATCH"
      );
      await pending.getByRole("button", { name: "Cancel" }).click();
      expect((await cancel).headers()["idempotency-key"]).toBeTruthy();
    },
  );

  test("desktop keeps the enrollments table", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop layout only");
    await machinesFixture(page);
    await page.goto("/machines");
    const table = page.getByRole("table", { name: "Worker enrollments" });
    await expect(table).toBeVisible();
    await expect(
      table.locator(`[data-enrollment-name="${PENDING_NAME}"]`)
        .getByRole("button", { name: "Cancel" }),
    ).toBeVisible();
  });

  test(
    "phone lists hold only list items when ready and loading",
    async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile", "phone layout only");
      const childRoles = () =>
        page.locator('[role="list"][aria-label]').evaluateAll((lists) =>
          lists.map((list) => ({
            name: list.getAttribute("aria-label"),
            roles: [...list.children].map((child) =>
              child.getAttribute("role")
            ),
          }))
        );

      await machinesFixture(page);
      await page.goto("/machines");
      await expect(page.getByRole("list", { name: "Machines" })).toBeVisible();
      await expect(page.getByRole("list", { name: "Worker enrollments" }))
        .toBeVisible();
      const ready = await childRoles();
      expect(ready.map((list) => list.name)).toEqual(
        expect.arrayContaining(["Machines", "Worker enrollments"]),
      );
      for (const list of ready) {
        expect(list.roles.length).toBeGreaterThan(0);
        expect(list.roles.every((role) => role === "listitem")).toBe(true);
      }
      const axe = await new AxeBuilder({ page })
        .withRules(["aria-required-children", "aria-required-parent"])
        .analyze();
      expect(axe.violations).toEqual([]);

      await page.unrouteAll({ behavior: "ignoreErrors" });
      await machinesFixture(page);
      await page.route(
        (url) =>
          url.pathname === "/v1/workers" ||
          url.pathname === "/v1/worker-enrollments",
        () => undefined,
      );
      await page.reload();
      const machines = page.getByRole("list", { name: "Machines" });
      await expect(machines).toHaveAttribute("aria-busy", "true");
      await expect(
        page.getByRole("status").filter({
          hasText: "Loading machine data",
        }).first(),
      ).toBeVisible();
      for (const list of await childRoles()) {
        expect(list.roles.every((role) => role === "listitem")).toBe(true);
      }
    },
  );
});
