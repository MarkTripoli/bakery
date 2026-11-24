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
  /** Every task's recorded intervals cover all of its time: nothing is unaccounted for. */
  allAccountedFor?: boolean;
  /** The definitions version the series report; null when the server serves none. */
  revision?: string | null;
};

const point = (day: number, value: number | null) => ({
  at: `2026-11-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  value,
  unknownReason: value === null ? "no_records" : null,
});

const series = (
  revision: string | null | undefined,
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
  measurementRevision: revision === undefined ? "metrics@3" : revision,
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
  // Every task adds up: the four waits and what no record covers sum to its
  // Total, which is Delivered minus Requested; the bar is the column sums, and
  // Typical is the middle row.
  const totalsHours = [10, 14, 18, 22, 26, 30, 34, 46, 50, 62];
  const count = merged + runs;
  const totals = totalsHours.slice(0, count);
  const split = (total: number) => {
    const queue = Math.round(total * 0.15);
    const review = Math.round(total * 0.08);
    const person = Math.round(total * 0.17);
    const rest = total - queue - review - person;
    // What no record covers is the remainder, or nothing when all is covered.
    const agentWorking = options.allAccountedFor === true
      ? rest
      : Math.round(total * 0.5);
    return {
      agentWorking,
      queue,
      review,
      person,
      unaccounted: rest - agentWorking,
    };
  };
  const rowsWaits = totals.map(split);
  const sums = rowsWaits.reduce(
    (sum, row) => ({
      agentWorking: sum.agentWorking + row.agentWorking,
      queue: sum.queue + row.queue,
      review: sum.review + row.review,
      person: sum.person + row.person,
      unaccounted: sum.unaccounted + row.unaccounted,
    }),
    { agentWorking: 0, queue: 0, review: 0, person: 0, unaccounted: 0 },
  );
  const sorted = [...totals].sort((a, b) => a - b);
  const median = sorted[Math.ceil(sorted.length / 2) - 1] ?? null;
  const p90 = sorted[Math.ceil(sorted.length * 0.9) - 1] ?? null;
  const share = (
    category: string,
    hours: number | null,
  ) => ({
    category,
    hours,
    unknownReason: hours === null ? "not_recorded" : null,
  });
  const breakdown = [
    share("agentWorking", sums.agentWorking),
    share("queue", sums.queue),
    share("review", sums.review),
    share("person", sums.person),
    share("blocked", null),
    share("unaccounted", sums.unaccounted),
  ];
  const TITLES = [
    "Tidy the settings page",
    "Add the delivery metrics read",
    "Fix the retry window",
    "Move the usage link",
    "Show where the time went",
    "Rename the queue states",
    "Count changed lines once",
    "Explain a disconnected source",
    "Read the records table",
    "Cache the repository list",
  ];
  const task = (n: number, point: "merged_pull_request" | "completed_run") => {
    const total = totals[n - 1]!;
    const requested = Date.parse("2026-11-10T09:00:00.000Z") +
      n * 3_600_000 * 5;
    const row = rowsWaits[n - 1]!;
    return {
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
      value: total,
      missingReason: null,
      title: TITLES[n - 1],
      requestedAt: new Date(requested).toISOString(),
      deliveredAt: new Date(requested + total * 3_600_000).toISOString(),
      deliveryPoint: point,
      waits: [
        share("agentWorking", row.agentWorking),
        share("queue", row.queue),
        share("review", row.review),
        share("person", row.person),
        share("blocked", null),
        share("unaccounted", row.unaccounted),
      ],
      lineCount: null,
    };
  };
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
    lineCount: null,
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
  // The organization each metrics read was made for, as the API sees it.
  const organizationHeaders: (string | undefined)[] = [];
  let metricReads = 0;
  await page.route(
    (url) => url.pathname === "/v1/metrics",
    (route) => {
      organizationHeaders.push(
        route.request().headers()["bakery-organization-id"],
      );
      metricReads += 1;
      const metric = new URL(route.request().url()).searchParams.get("metric")!;
      if (metric === "tasks.leadTimeHours") {
        return json(
          route,
          series(options.revision, metric, "hours", [28, 40, null, 31], {
            sampleCount: merged + runs,
            missingCount: options.leftOut ?? 0,
            summary: {
              median,
              p90,
              mean: totals.length === 0
                ? null
                : totals.reduce((a, b) => a + b, 0) / totals.length,
              breakdown,
              deliveryPoints: [
                { deliveryPoint: "merged_pull_request", count: merged },
                { deliveryPoint: "completed_run", count: runs },
              ],
            },
          }),
        );
      }
      if (metric === "prs.openAtCutoff") {
        return json(
          route,
          series(options.revision, metric, "count", [3, 4, 5, 4]),
        );
      }
      return json(
        route,
        series(
          options.revision,
          metric,
          metric === "prs.changedLines" ? "lines" : "count",
          [
            2,
            4,
            0,
            5,
          ],
        ),
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
  return {
    records,
    pullRequests,
    organizationHeaders,
    get metricReads() {
      return metricReads;
    },
  };
}
