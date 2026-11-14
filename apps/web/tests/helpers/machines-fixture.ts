import type { Page } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";

/** One machine, one unfinished setup and an administrator, stubbed at the API: what the Machines specs share. */
export const MACHINE_ID = "00000000-0000-4000-8000-0000000000c1";
export const NEW_ENROLLMENT_ID = "00000000-0000-4000-8000-0000000000c4";

export function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

export function worker(status = "online") {
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

export const ENROLLMENT = {
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

export async function adminMachinesFixture(
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
