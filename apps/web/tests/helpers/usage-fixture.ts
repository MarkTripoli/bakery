import type { Page } from "@playwright/test";
import { mockAuthenticatedSession } from "./mock-session.ts";

/** Stubs for the Usage page: the installation's spend by provider, and the budgets. */

const STAMP = "2026-11-20T00:00:00.000Z";

export type UsageOptions = {
  /** No records at all: the empty state. */
  empty?: boolean;
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
    (route) => {
      const query = new URL(route.request().url()).searchParams;
      seen.push(query);
      const provider = query.get("provider");
      const rows = options.empty
        ? []
        : ROWS.filter((row) => provider === null || row.provider === provider);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          from: query.get("from") ?? STAMP,
          to: query.get("to") ?? STAMP,
          knownCostUsd: options.empty ? "0.0000" : "500.5000",
          unverifiedCostUsd: options.empty ? "0.0000" : "37.2000",
          unknownCount: options.empty ? 0 : 1,
          unverifiedCount: options.empty ? 0 : 3,
          completeness: options.empty ? "complete" : "partial",
          byProvider: rows,
          budgetAccounts: options.empty ? [] : [{
            scope: "installation",
            runId: null,
            periodStart: "2026-11-01T00:00:00.000Z",
            periodEnd: "2026-12-01T00:00:00.000Z",
            limitUsd: "1000.0000",
            reservedUsd: "25.0000",
            settledUsd: "500.5000",
            availableUsd: "474.5000",
            unknownCount: 1,
          }],
        }),
      });
    },
  );
  return { seen };
}
