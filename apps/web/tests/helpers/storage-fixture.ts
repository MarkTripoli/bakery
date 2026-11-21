import type { Page } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";

/** Stubs for the Storage settings page: the organization's limits, usage and every save. */

const GB = 1024 ** 3;
const STAMP = "2026-01-01T00:00:00.000Z";

export type StorageOptions = {
  /** Admins edit; a developer reads. */
  role?: "admin" | "developer";
  /** Used and quota, in GB, to set the state: 75% warns, 90% pauses. */
  usedGb?: number;
  quotaGb?: number;
  /** 0 while the organization uses Bakery's defaults. */
  version?: number;
  /** Status the next save answers with. */
  putStatus?: number;
};

export type SavedPut = {
  ifMatch: string | null;
  key: string | null;
  body: Record<string, number>;
};

const problem = (status: number, code: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: `https://bakery.example/problems/${code.toLowerCase()}`,
    title: code,
    status,
    detail: code,
    code,
    requestId: "00000000-0000-4000-8000-0000000000e1",
    traceId: "00000000-0000-4000-8000-0000000000e2",
    retryable: false,
  }),
});

/** Stubs the session, the role and the settings read and write; returns what it saw. */
export async function storageFixture(page: Page, options: StorageOptions = {}) {
  await mockAuthenticatedSession(page);
  // The shell asks what this person may do to decide which links to draw; an
  // unstubbed read reaches no server here, answers 401 and signs the page out.
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          organizationId: MOCK_ORGANIZATION_ID,
          role: options.role ?? "admin",
          capabilities: [],
        }),
      }),
  );
  const state = {
    workingVersionsKept: 20,
    trashRetentionDays: 30,
    scratchRetentionDays: 30,
    maxFileBytes: 5 * GB,
    organizationQuotaBytes: (options.quotaGb ?? 100) * GB,
    projectQuotaBytes: 50 * GB,
    personalQuotaBytes: 10 * GB,
    stepWriteBytes: 2 * GB,
    stepWriteFiles: 2000,
    organizationUsedBytes: Math.round((options.usedGb ?? 78.2) * GB),
    version: options.version ?? 3,
  };
  let putStatus = options.putStatus ?? 200;
  const puts: SavedPut[] = [];
  const record = () => {
    const share = state.organizationUsedBytes / state.organizationQuotaBytes;
    return {
      ...state,
      organizationQuotaState: share >= 0.9
        ? "paused"
        : share >= 0.75
        ? "warning"
        : "ok",
      customized: state.version > 0,
    };
  };
  await page.route("**/v1/storage/settings", (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      puts.push({
        ifMatch: request.headers()["if-match"] ?? null,
        key: request.headers()["idempotency-key"] ?? null,
        body: request.postDataJSON() as Record<string, number>,
      });
      if (putStatus !== 200) {
        const status = putStatus;
        putStatus = 200;
        return route.fulfill(
          problem(
            status,
            status === 412 ? "PRECONDITION_FAILED" : "INTERNAL",
          ),
        );
      }
      Object.assign(state, request.postDataJSON(), {
        version: state.version + 1,
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(record()),
    });
  });
  if (options.role === "developer") {
    await page.route(
      "**/v1/organizations",
      (route) =>
        route.request().method() !== "GET" ? route.continue() : route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items: [{
              id: MOCK_ORGANIZATION_ID,
              name: "Fixture Org",
              slug: "fixture-org",
              logo: null,
              defaultLocale: null,
              metadata: {},
              createdAt: STAMP,
              updatedAt: STAMP,
              version: 1,
              role: "developer",
            }],
            nextCursor: null,
          }),
        }),
    );
  }
  return { puts, state };
}
