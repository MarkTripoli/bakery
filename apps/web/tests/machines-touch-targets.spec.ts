import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

const MACHINE_ID = "00000000-0000-4000-8000-0000000000c1";
const NEW_ENROLLMENT_ID = "00000000-0000-4000-8000-0000000000c4";
const MIN_TARGET = 44;
const INTERACTIVE = [
  "a[href]",
  "button",
  "select",
  "input:not([type=hidden])",
  "textarea",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[role=combobox]",
  "[role=switch]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=menuitem]",
  "[role=option]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

function worker(status = "online") {
  return {
    id: MACHINE_ID,
    principalId: "00000000-0000-4000-8000-0000000000c2",
    name: "touch-target-host",
    os: "linux",
    architecture: "x86_64",
    capabilities: ["claude"],
    toolchainVersions: {},
    slots: 1,
    status,
    desiredMode: "accepting",
    connectivity: "online",
    readiness: "ready",
    readinessReason: null,
    failedCheckIds: [],
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    credentialGeneration: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
}

const ENROLLMENT = {
  enrollmentId: "00000000-0000-4000-8000-0000000000c3",
  name: "touch-target-pending",
  state: "pending",
  os: "linux",
  architecture: "x86_64",
  capabilities: ["claude"],
  slots: 1,
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  consumedAt: null,
  canceledAt: null,
  workerHostId: null,
  replacementOfId: null,
  targetWorkerHostId: null,
  version: 1,
};

async function adminMachinesFixture(
  page: Page,
  options: { readonly status?: string; readonly blockersFail?: boolean } = {},
) {
  const status = options.status ?? "online";
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
    (route) =>
      route.fulfill(json({ items: [worker(status)], nextCursor: null })),
  );
  await page.route(`**/v1/workers/${MACHINE_ID}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/dispatch-blockers")) {
      if (options.blockersFail) {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ code: "INTERNAL" }),
        });
      }
      return route.fulfill(json({
        workerHostId: MACHINE_ID,
        reason: null,
        connectivity: "online",
        allBlocked: false,
        blockedCapabilities: [],
        failedChecks: [],
        credentialGeneration: 1,
        inventoryRevision: 1,
      }));
    }
    return route.fulfill(json({ items: [], nextCursor: null }));
  });
  await page.route(
    `**/v1/workers/${MACHINE_ID}`,
    (route) => route.fulfill(json(worker(status))),
  );
  await page.route(
    `**/v1/worker-enrollments/${NEW_ENROLLMENT_ID}`,
    (route) =>
      route.fulfill(json({
        enrollmentId: NEW_ENROLLMENT_ID,
        organizationId: MOCK_ORGANIZATION_ID,
        state: "pending",
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        workerHostId: null,
        worker: null,
        version: 1,
        snapshotCursor: null,
      })),
  );
  await page.route(
    (url) => url.pathname === "/v1/worker-enrollments",
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            enrollmentId: NEW_ENROLLMENT_ID,
            enrollmentToken: "touch-target-enrollment-token-0001",
            expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          }),
        })
        : route.fulfill(json({ items: [ENROLLMENT], nextCursor: null })),
  );
}

type Target = {
  readonly label: string;
  readonly width: number;
  readonly height: number;
};

/** Every visible, enabled interactive element in the document with its box. */
async function measureTargets(page: Page): Promise<Target[]> {
  return await page.locator(INTERACTIVE).evaluateAll((elements) =>
    elements.flatMap((element) => {
      const html = element as HTMLElement;
      if (html.closest("[inert],[aria-hidden=true]")) return [];
      if ((html as HTMLButtonElement).disabled) return [];
      const style = getComputedStyle(html);
      if (style.visibility === "hidden" || style.display === "none") return [];
      // A radio or checkbox inside a label is tapped through the label: the
      // card or row around it is the target, not the 16 px input.
      const tapped = html.matches("input[type=radio],input[type=checkbox]")
        ? html.closest("label") ?? html
        : html;
      const box = tapped.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return [];
      const name = html.getAttribute("aria-label") ??
        html.textContent?.trim().slice(0, 40) ?? "";
      return [{
        label: `${html.tagName.toLowerCase()}#${html.id || "-"} "${name}"`,
        width: Math.round(box.width * 100) / 100,
        height: Math.round(box.height * 100) / 100,
      }];
    })
  );
}

function undersized(targets: readonly Target[]): Target[] {
  return targets.filter((target) =>
    target.width < MIN_TARGET || target.height < MIN_TARGET
  );
}

test.describe("machines touch targets on a coarse phone", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "coarse phone only");
    await adminMachinesFixture(page);
  });

  test("the phone project emulates a 390 px coarse pointer", async ({ page }) => {
    await page.goto("/machines");
    const media = await page.evaluate(() => ({
      width: innerWidth,
      coarse: matchMedia("(pointer: coarse)").matches,
    }));
    expect(media).toEqual({ width: 390, coarse: true });
  });

  test("every /machines target is at least 44 by 44", async ({ page }) => {
    await page.goto("/machines");
    await expect(page.getByRole("list", { name: "Machines" })).toBeVisible();
    // A setup that was left, with its two buttons.
    await expect(page.getByTestId("machines-finishing-setup")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Continue setup of touch-target-pending",
      }),
    ).toBeVisible();
    const toggle = page.getByRole("button", { name: "Open navigation" });
    await expect(toggle).toBeVisible();

    const targets = await measureTargets(page);
    expect(targets.length).toBeGreaterThan(5);
    expect(undersized(targets)).toEqual([]);
  });

  test("every add-a-machine wizard target is at least 44 by 44, on each step", async ({ page }) => {
    await page.goto("/machines/new");
    await expect(page.getByText("Step 1 of 3 · Name and system")).toBeVisible();
    expect(undersized(await measureTargets(page))).toEqual([]);
    await page.getByLabel("Name").fill("touch-target-new");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Step 2 of 3 · Coding agent")).toBeVisible();
    expect(undersized(await measureTargets(page))).toEqual([]);
    await page.getByRole("radio", { name: /Codex/ }).check({ force: true });
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("touch-target-enrollment-token-0001"))
      .toBeVisible();
    expect(undersized(await measureTargets(page))).toEqual([]);
  });

  test("every /machines/$machineId target is at least 44 by 44", async ({ page }) => {
    await page.goto(`/machines/${MACHINE_ID}`);
    await expect(page.getByTestId("machine-detail-page")).toBeVisible();
    await expect(page.getByText("No failed checks reported.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open navigation" }))
      .toBeVisible();

    const targets = await measureTargets(page);
    expect(targets.length).toBeGreaterThan(3);
    expect(undersized(targets)).toEqual([]);
  });

  test("revoked detail with failed blockers keeps 44 by 44 targets", async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await adminMachinesFixture(page, { status: "revoked", blockersFail: true });
    await page.goto(`/machines/${MACHINE_ID}`);
    const detail = page.getByTestId("machine-detail-page");
    await expect(detail.getByRole("button", { name: "Repair enrollment" }))
      .toBeVisible();
    await expect(detail.getByRole("button", { name: "Retry" }).first())
      .toBeVisible();

    expect(undersized(await measureTargets(page))).toEqual([]);
  });

  test("the open navigation drawer keeps 44 by 44 targets", async ({ page }) => {
    await page.goto(`/machines/${MACHINE_ID}`);
    await expect(page.getByTestId("machine-detail-page")).toBeVisible();
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const targets = await page.getByRole("dialog").locator(INTERACTIVE)
      .evaluateAll((elements) =>
        elements.flatMap((element) => {
          const box = element.getBoundingClientRect();
          return box.width === 0 || box.height === 0 ? [] : [{
            label: `${element.tagName.toLowerCase()} "${
              element.textContent?.trim().slice(0, 40) ?? ""
            }"`,
            width: Math.round(box.width * 100) / 100,
            height: Math.round(box.height * 100) / 100,
          }];
        })
      );
    expect(targets.length).toBeGreaterThan(3);
    expect(undersized(targets)).toEqual([]);
  });
});
