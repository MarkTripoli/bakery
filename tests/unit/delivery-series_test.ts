import { assertEquals } from "@std/assert";
import type { MetricSeries } from "../../apps/web/src/api/client.ts";
import {
  chartPoints,
  chartStep,
  gapDays,
  gapsOf,
  hasLine,
  isOverTimeShow,
  OVER_TIME_METRIC,
  windowDays,
} from "../../apps/web/src/screens/delivery/delivery-series.ts";

function series(values: (number | null)[], start = "2026-10-01"): MetricSeries {
  const base = Date.parse(`${start}T00:00:00.000Z`);
  return {
    name: "prs.merged",
    points: values.map((value, index) => ({
      at: new Date(base + index * 86_400_000).toISOString(),
      value,
      unknownReason: value === null ? "no_records" : null,
    })),
    from: new Date(base).toISOString(),
    to: new Date(base + values.length * 86_400_000).toISOString(),
    resolution: "day",
    unit: "count",
    cohort: "Distinct pull requests merged in each period",
    sampleCount: 0,
    missingCount: 0,
    measurementRevision: "prs.merged@00000000",
    lastSyncAt: null,
    completeness: "complete",
    missingReasons: [],
    hiddenCount: 0,
    repositories: [],
    summary: null,
  } as MetricSeries;
}

Deno.test("the six things to show map to the metrics the server serves, with no merge rate", () => {
  assertEquals(OVER_TIME_METRIC, {
    merged: "prs.merged",
    opened: "prs.opened",
    open: "prs.openAtCutoff",
    closed: "prs.closedUnmerged",
    lines: "prs.changedLines",
    taskTime: "tasks.leadTimeHours",
  });
  assertEquals(isOverTimeShow("mergeRate"), false);
  assertEquals(isOverTimeShow("lines"), true);
});

Deno.test("one point a day up to 90 days and one a week above that", () => {
  assertEquals(chartStep(90), "day");
  assertEquals(chartStep(91), "week");
  assertEquals(
    windowDays(
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-10-31T00:00:00Z"),
    ),
    30,
  );
});

Deno.test("a null day stays a gap, never a zero", () => {
  const points = chartPoints(series([2, null, 0, null, null]), "merged", "day");
  assertEquals(points.map((point) => point.value), [2, null, 0, null, null]);
  assertEquals(hasLine(points), true);
  assertEquals(
    hasLine(chartPoints(series([null, null]), "merged", "day")),
    false,
  );
});

Deno.test("consecutive unknown days are one gap, and the days it covers are counted", () => {
  const points = chartPoints(series([1, null, null, 3, null]), "merged", "day");
  const gaps = gapsOf(points);
  assertEquals(gaps.map((gap) => gap.buckets), [2, 1]);
  assertEquals(gapDays(gaps), 3);
  assertEquals(gaps[0].from.toISOString(), "2026-10-02T00:00:00.000Z");
  assertEquals(gaps[0].to.toISOString(), "2026-10-04T00:00:00.000Z");
});

Deno.test("a week adds counts and lines, takes the last count still open, and the median of typical times", () => {
  const values = [
    1,
    2,
    null,
    4,
    5,
    6,
    7,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  assertEquals(
    chartPoints(series(values), "merged", "week").map((p) => p.value),
    [25, null],
  );
  assertEquals(
    chartPoints(series(values), "lines", "week").map((p) => p.value),
    [25, null],
  );
  assertEquals(
    chartPoints(series(values), "open", "week").map((p) => p.value),
    [7, null],
  );
  assertEquals(
    chartPoints(series(values), "taskTime", "week").map((p) => p.value),
    [4.5, null],
  );
});

Deno.test("a week with nothing known is a gap, and a short last week is kept", () => {
  const weeks = chartPoints(
    series([null, null, null, null, null, null, null, 3, 4]),
    "merged",
    "week",
  );
  assertEquals(weeks.map((p) => p.value), [null, 7]);
  assertEquals(gapsOf(weeks).length, 1);
  assertEquals(weeks[1].to.toISOString(), "2026-10-10T00:00:00.000Z");
});
