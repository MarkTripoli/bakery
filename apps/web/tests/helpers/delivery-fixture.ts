import type { Page, Route } from "@playwright/test";
import { projectsFixture, repository, uuid } from "./projects-fixture.ts";

/**
 * Stubs for the Delivery page (#75): the signed-in session, the repositories the
 * reader may open, the five metric series the page reads and the records behind
 * a number. Nothing here is a server: it serves the shapes the server answers,
 * so the page's states can be driven and photographed.
 */
const STAMP = "2026-11-20T09:00:00.000Z";
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

const REPO = repository(1, uuid(100), "web");

export type DeliveryOptions = {
  /** Tasks delivered at a merge, and at a completed run with no pull request. */
  merged?: number;
  runs?: number;
  /** Hours by category; blocked is always unknown. */
  hours?: Record<
    "agentWorking" | "queue" | "review" | "person" | "unaccounted",
    number
  >;
};

const point = (day: number, value: number | null) => ({
  at: `2026-11-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  value,
  unknownReason: value === null ? "no_records" : null,
});

const series = (
  name: string,
  unit: "count" | "hours" | "lines",
  values: (number | null)[],
  extra: Record<string, unknown> = {},
) => ({
  name,
  points: values.map((value, index) => point(index + 1, value)),
  from: "2026-11-01T00:00:00.000Z",
  to: "2026-11-21T00:00:00.000Z",
  resolution: "day",
  unit,
  cohort: "Pull requests merged in the window.",
  sampleCount: values.reduce<number>((sum, value) => sum + (value ?? 0), 0),
  missingCount: 0,
  measurementRevision: "metrics@3",
  lastSyncAt: STAMP,
  completeness: "complete",
  missingReasons: [],
  hiddenCount: 0,
  repositories: [{
    repositoryId: REPO.id,
    state: "connected",
    since: null,
    lastSyncAt: STAMP,
  }],
  summary: null,
  ...extra,
});

export async function deliveryFixture(
  page: Page,
  options: DeliveryOptions = {},
) {
  await projectsFixture(page, { repositories: [REPO], role: "admin" });
  const merged = options.merged ?? 6;
  const runs = options.runs ?? 2;
  const hours = options.hours ?? {
    agentWorking: 14,
    queue: 5,
    review: 3,
    person: 6,
    unaccounted: 8,
  };
  const waits = (extra = 1) => [
    {
      category: "agentWorking",
      hours: hours.agentWorking * extra,
      unknownReason: null,
    },
    { category: "queue", hours: hours.queue * extra, unknownReason: null },
    { category: "review", hours: hours.review * extra, unknownReason: null },
    { category: "person", hours: hours.person * extra, unknownReason: null },
    { category: "blocked", hours: null, unknownReason: "not_recorded" },
    {
      category: "unaccounted",
      hours: hours.unaccounted * extra,
      unknownReason: null,
    },
  ];
  const task = (n: number, point: "merged_pull_request" | "completed_run") => ({
    kind: "task",
    id: uuid(300 + n),
    repositoryId: REPO.id,
    taskId: uuid(300 + n),
    providerNumber: null,
    url: null,
    status: "delivered",
    openedAt: null,
    mergedAt: null,
    closedAt: null,
    countedAt: STAMP,
    value: 20 + n,
    missingReason: null,
    title: `Task ${n}: tidy the settings page`,
    requestedAt: "2026-11-10T09:00:00.000Z",
    deliveredAt: "2026-11-11T09:00:00.000Z",
    deliveryPoint: point,
    waits: waits(0.2),
  });
  const pullRequest = (n: number, missing: boolean) => ({
    kind: "pullRequest",
    id: uuid(400 + n),
    repositoryId: REPO.id,
    taskId: uuid(300 + n),
    providerNumber: 100 + n,
    url: null,
    status: "merged",
    openedAt: `2026-11-${String(2 + n).padStart(2, "0")}T09:30:00.000Z`,
    mergedAt: `2026-11-${String(3 + n).padStart(2, "0")}T14:10:00.000Z`,
    closedAt: null,
    countedAt: STAMP,
    value: missing ? null : 40 + n * 11,
    missingReason: missing ? "no_diff_totals" : null,
    title: [
      "Add the metrics read",
      "Fix the retry window",
      "Show the delivery page",
      "Tidy the settings copy",
      "Count the changed lines",
    ][n],
    requestedAt: null,
    deliveredAt: null,
    deliveryPoint: null,
    waits: null,
  });
  const pullRequests = Array.from(
    { length: 5 },
    (_, i) => pullRequest(i, i === 3),
  );
  const records = [
    ...Array.from(
      { length: merged },
      (_, i) => task(i + 1, "merged_pull_request"),
    ),
    ...Array.from(
      { length: runs },
      (_, i) => task(merged + i + 1, "completed_run"),
    ),
  ];
  await page.route(
    (url) => url.pathname === "/v1/metrics",
    (route) => {
      const metric = new URL(route.request().url()).searchParams.get("metric")!;
      if (metric === "tasks.leadTimeHours") {
        return json(
          route,
          series(metric, "hours", [28, 40, null, 31], {
            sampleCount: merged + runs,
            missingCount: options.leftOut ?? 0,
            summary: {
              median: 30,
              p90: 52,
              mean: 34,
              breakdown: waits(),
              deliveryPoints: [
                { deliveryPoint: "merged_pull_request", count: merged },
                { deliveryPoint: "completed_run", count: runs },
              ],
            },
          }),
        );
      }
      if (metric === "prs.openAtCutoff") {
        return json(route, series(metric, "count", [3, 4, 5, 4]));
      }
      return json(
        route,
        series(metric, metric === "prs.changedLines" ? "lines" : "count", [
          2,
          4,
          0,
          5,
        ]),
      );
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/metrics/sources",
    (route) => {
      const metric = new URL(route.request().url()).searchParams.get("metric");
      return json(route, {
        items: metric === "tasks.leadTimeHours" ? records : pullRequests,
        nextCursor: null,
      });
    },
  );
  return { records, pullRequests };
}
