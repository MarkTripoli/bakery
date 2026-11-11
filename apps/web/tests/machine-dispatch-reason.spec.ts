import { expect, type Page, test } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./helpers/mock-session.ts";

const MACHINE_ID = "00000000-0000-4000-8000-0000000000a1";

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

type Reason =
  | "revoked"
  | "offline"
  | "stale"
  | "check_failed"
  | "draining"
  | "paused";

async function machineFixture(
  page: Page,
  options: {
    reason: Reason | null;
    readinessReason: string | null;
    connectivity?: "online" | "stale" | "offline";
  },
) {
  await mockAuthenticatedSession(page);
  const connectivity = options.connectivity ?? "online";
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: "member",
        capabilities: [],
      })),
  );
  await page.route(`**/v1/workers/${MACHINE_ID}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/dispatch-blockers")) {
      return route.fulfill(json({
        workerHostId: MACHINE_ID,
        reason: options.reason,
        connectivity,
        allBlocked: options.reason !== null,
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
    (route) =>
      route.fulfill(json({
        id: MACHINE_ID,
        principalId: "00000000-0000-4000-8000-0000000000a2",
        name: "fixture-host",
        os: "linux",
        architecture: "x86_64",
        capabilities: ["claude"],
        toolchainVersions: {},
        slots: 1,
        status: "online",
        desiredMode: "accepting",
        connectivity,
        readiness: options.readinessReason ? "needs_attention" : "ready",
        readinessReason: options.readinessReason,
        failedCheckIds: [],
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        credentialGeneration: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        version: 1,
      })),
  );
}

const cases: readonly {
  reason: Reason;
  banner: string;
  readiness: string | null;
  readinessReason: string | null;
}[] = [
  {
    reason: "revoked",
    banner: "Dispatch blocked: credential revoked",
    readiness: "Credential revoked",
    readinessReason: "revoked",
  },
  {
    reason: "offline",
    banner: "Dispatch blocked: machine offline",
    readiness: "Offline",
    readinessReason: "offline",
  },
  {
    reason: "stale",
    banner: "Dispatch blocked: heartbeat stale",
    readiness: "Heartbeat stale",
    readinessReason: "stale",
  },
  {
    reason: "check_failed",
    banner: "Dispatch blocked: readiness check failed",
    readiness: "Check failed",
    readinessReason: "check_failed",
  },
  {
    reason: "draining",
    banner: "Dispatch blocked: machine draining",
    readiness: null,
    readinessReason: null,
  },
  {
    reason: "paused",
    banner: "Dispatch blocked: machine paused",
    readiness: null,
    readinessReason: null,
  },
];

test.describe("machine detail dispatch block reason", () => {
  for (const item of cases) {
    test(`names ${item.reason} and localizes the readiness row`, async ({ page }) => {
      await machineFixture(page, {
        reason: item.reason,
        readinessReason: item.readinessReason,
      });
      await page.goto(`/machines/${MACHINE_ID}`);
      const detail = page.getByTestId("machine-detail-page");
      await expect(detail).toBeVisible();
      await expect(detail.getByText(item.banner, { exact: true }))
        .toBeVisible();
      if (item.readiness) {
        await expect(detail.getByText(item.readiness, { exact: true }).first())
          .toBeVisible();
      }
      if (item.readinessReason) {
        await expect(detail.getByText(item.readinessReason, { exact: true }))
          .toHaveCount(0);
      }
    });
  }

  test("shows no banner when nothing blocks dispatch", async ({ page }) => {
    await machineFixture(page, { reason: null, readinessReason: null });
    await page.goto(`/machines/${MACHINE_ID}`);
    const detail = page.getByTestId("machine-detail-page");
    await expect(detail).toBeVisible();
    await expect(detail.getByText("No failed checks reported.")).toBeVisible();
    await expect(detail.getByText(/Dispatch blocked/)).toHaveCount(0);
  });
});
