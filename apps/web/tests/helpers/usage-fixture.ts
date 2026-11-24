import type { Page } from "@playwright/test";
import { mockAuthenticatedSession } from "./mock-session.ts";

/** Stubs for the Usage page: the installation's spend by provider, and the budgets. */

const STAMP = "2026-11-20T00:00:00.000Z";

export type UsageOptions = {
  /** No records at all: the empty state. */
  empty?: boolean;
  /** Someone who may not see Usage: the server answers 403. */
  forbidden?: boolean;
  twoRoutes?: boolean;
  failing?: boolean;
  delayMs?: number;
};

const ROWS = [
  {
    provider: "anthropic",
    billingType: "api",
    model: null,
    knownCostUsd: "412.5000",
    unverifiedCostUsd: "37.2000",
    unknownCount: 0,
    unverifiedCount: 3,
    inputTokens: "1200000",
    outputTokens: "340000",
  },
  {
    provider: "openai",
    billingType: "api",
    model: null,
    knownCostUsd: "88.0000",
    unverifiedCostUsd: "0.0000",
    unknownCount: 1,
    unverifiedCount: 0,
    inputTokens: "400000",
    outputTokens: "90000",
  },
  {
    provider: "mistral",
    billingType: "api",
    model: null,
    knownCostUsd: "0.0040",
    unverifiedCostUsd: "0.0000",
    unknownCount: 0,
    unverifiedCount: 0,
    inputTokens: "1000",
    outputTokens: "200",
  },
  {
    provider: "google",
    billingType: "subscription",
    model: null,
    knownCostUsd: "0.0000",
    unverifiedCostUsd: "0.0000",
    unknownCount: 0,
    unverifiedCount: 0,
    inputTokens: null,
    outputTokens: null,
  },
];

/** Stubs the session and the usage read; returns the queries it saw. */
export async function usageFixture(page: Page, options: UsageOptions = {}) {
  await mockAuthenticatedSession(page);
  const seen: URLSearchParams[] = [];
  await page.route(
    (url) => url.pathname === "/v1/usage",
    async (route) => {
      const query = new URL(route.request().url()).searchParams;
      seen.push(query);
      if (options.delayMs !== undefined) {
        await new Promise((done) => setTimeout(done, options.delayMs));
      }
      if (options.failing) {
        return route.fulfill({
          status: 500,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "https://bakery.example/problems/test",
            title: "Failed",
            detail: "Failed.",
            status: 500,
            code: "INTERNAL_ERROR",
            retryable: false,
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
        });
      }
      if (options.forbidden) {
        return route.fulfill({
          status: 403,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "https://bakery.example/problems/test",
            title: "Refused",
            detail: "Refused.",
            status: 403,
            code: "AUTH_FORBIDDEN",
            retryable: false,
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
        });
      }
      const provider = query.get("provider");
      const allRows = options.empty ? [] : [
        ...ROWS,
        ...(options.twoRoutes
          ? [{
            ...ROWS[0],
            billingType: "subscription",
            knownCostUsd: "5.0000",
            unverifiedCostUsd: "0.0000",
            unverifiedCount: 0,
          }]
          : []),
      ];
      const rows = allRows.filter((row) =>
        provider === null || row.provider === provider
      );
      const total = (pick: (row: (typeof ROWS)[number]) => number) =>
        rows.reduce((sum, row) => sum + pick(row), 0);
      const known = total((row) => Number(row.knownCostUsd));
      const settled = allRows.reduce(
        (sum, row) => sum + Number(row.knownCostUsd),
        0,
      );
      const unknownCount = total((row) => row.unknownCount);
      const unverifiedCount = total((row) => row.unverifiedCount);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          from: query.get("from") ?? STAMP,
          to: query.get("to") ?? STAMP,
          knownCostUsd: known.toFixed(4),
          unverifiedCostUsd: total((row) => Number(row.unverifiedCostUsd))
            .toFixed(4),
          unknownCount,
          unverifiedCount,
          completeness: unknownCount + unverifiedCount > 0
            ? "partial"
            : "complete",
          byProvider: rows,
          budgetAccounts: options.empty ? [] : [{
            scope: "installation",
            runId: null,
            periodStart: "2026-11-01T00:00:00.000Z",
            periodEnd: "2026-12-01T00:00:00.000Z",
            limitUsd: "1000.0000",
            reservedUsd: "25.0000",
            settledUsd: settled.toFixed(4),
            availableUsd: (1000 - 25 - settled).toFixed(4),
            unknownCount: 1,
          }],
        }),
      });
    },
  );
  return { seen };
}
