import { assertEquals } from "@std/assert";
import type {
  MetricSeries,
  MetricSource,
} from "../../apps/web/src/api/client.ts";
import {
  chartGaps,
  chartMaximum,
  chartMissingDays,
  chartSegments,
  countFigure,
  durationWords,
  freshnessOf,
  hoursBetween,
  isDeliveryShow,
  leadTimeOf,
  missingKey,
  openFigure,
  recordRow,
  ruleKey,
  SHOW_METRIC,
  withSomethingMissing,
} from "../../apps/web/src/screens/delivery/delivery-display.ts";

function series(over: Partial<MetricSeries> = {}): MetricSeries {
  return {
    name: "prs.merged",
    points: [],
    from: "2026-11-01T00:00:00.000Z",
    to: "2026-11-20T00:00:00.000Z",
    resolution: "day",
    unit: "count",
    cohort: "Distinct pull requests merged in each period",
    sampleCount: 0,
    missingCount: 0,
    measurementRevision: "prs.merged@00000000",
    lastSyncAt: "2026-11-20T09:00:00.000Z",
    completeness: "complete",
    missingReasons: [],
    hiddenCount: 0,
    repositories: [],
    summary: null,
    ...over,
  };
}

Deno.test("a count that was never read is unknown, not zero", () => {
  assertEquals(countFigure(undefined), { kind: "unknown" });
  assertEquals(countFigure(series({ completeness: "unknown" })), {
    kind: "unknown",
  });
});

Deno.test("a count that was read and found nothing is a real zero", () => {
  assertEquals(countFigure(series({ sampleCount: 0 })), {
    kind: "value",
    value: 0,
  });
  assertEquals(countFigure(series({ sampleCount: 42 })), {
    kind: "value",
    value: 42,
  });
});

Deno.test("still open is the last point in time, not a sum of the points", () => {
  const points = [
    { at: "a", value: 7, unknownReason: null },
    { at: "b", value: 3, unknownReason: null },
  ];
  assertEquals(openFigure(series({ points })), { kind: "value", value: 3 });
  assertEquals(
    openFigure(series({
      points: [{ at: "a", value: null, unknownReason: "no_records" }],
    })),
    { kind: "unknown" },
  );
  assertEquals(openFigure(series({ points: [] })), { kind: "unknown" });
});

Deno.test("freshness: disconnected outranks stale outranks missing", () => {
  const connected = {
    repositoryId: "r1",
    state: "connected" as const,
    since: null,
    lastSyncAt: null,
  };
  const stale = { ...connected, repositoryId: "r2", state: "stale" as const };
  const gone = {
    ...connected,
    repositoryId: "r3",
    state: "disconnected" as const,
    since: "2026-11-10T00:00:00.000Z",
  };
  const lines = series({
    sampleCount: 31,
    missingReasons: [{ reason: "no_diff_totals", count: 11 }],
    missingCount: 11,
  });
  assertEquals(
    freshnessOf({
      merged: series({ repositories: [connected, stale, gone] }),
      lines,
      tasks: undefined,
    }),
    {
      kind: "disconnected",
      repositoryIds: ["r3"],
      since: "2026-11-10T00:00:00.000Z",
    },
  );
  assertEquals(
    freshnessOf({
      merged: series({ repositories: [connected, stale] }),
      lines,
      tasks: undefined,
    }).kind,
    "stale",
  );
  assertEquals(
    freshnessOf({
      merged: series({ repositories: [connected] }),
      lines,
      tasks: series({ missingCount: 2 }),
    }),
    {
      kind: "missing",
      asOf: "2026-11-20T09:00:00.000Z",
      unmeasured: 11,
      merged: 42,
      tasksMissing: 2,
    },
  );
  assertEquals(
    freshnessOf({ merged: series(), lines: series(), tasks: series() }),
    { kind: "complete", asOf: "2026-11-20T09:00:00.000Z" },
  );
});

Deno.test("a missing reason always has words, even one the page does not know", () => {
  assertEquals(missingKey(null), null);
  assertEquals(missingKey("no_diff_totals"), "delivery.missing.noDiffTotals");
  assertEquals(missingKey("something_new"), "delivery.missing.other");
  assertEquals(missingKey("no_line_count"), "delivery.missing.noLineCount");
  assertEquals(
    missingKey("line_count_binary"),
    "delivery.missing.lineCountBinary",
  );
  assertEquals(
    missingKey("line_count_truncated"),
    "delivery.missing.lineCountTruncated",
  );
});

Deno.test("hours between two times are known only when both are", () => {
  assertEquals(
    hoursBetween("2026-11-01T00:00:00Z", "2026-11-01T03:30:00Z"),
    3.5,
  );
  assertEquals(hoursBetween(null, "2026-11-01T03:30:00Z"), null);
  assertEquals(
    hoursBetween("2026-11-02T00:00:00Z", "2026-11-01T00:00:00Z"),
    null,
  );
});

Deno.test("a pull request row opens the task it delivers; a task row opens itself", () => {
  const base: MetricSource = {
    kind: "pullRequest",
    id: "pr-1",
    repositoryId: "r1",
    taskId: "task-9",
    providerNumber: 12,
    url: null,
    status: "merged",
    openedAt: "2026-11-01T00:00:00Z",
    mergedAt: "2026-11-01T02:00:00Z",
    closedAt: null,
    countedAt: "2026-11-01T02:00:00Z",
    value: null,
    missingReason: "no_diff_totals",
    title: "Fix it",
    requestedAt: null,
    deliveredAt: null,
    deliveryPoint: null,
    waits: null,
    lineCount: null,
  };
  const pr = recordRow(base);
  assertEquals(pr.taskId, "task-9");
  assertEquals(pr.openToMergeHours, 2);
  assertEquals(pr.value, null);
  assertEquals(pr.missing, "delivery.missing.noDiffTotals");
  assertEquals(
    recordRow({ ...base, kind: "task", id: "task-3" }).taskId,
    "task-3",
  );
  assertEquals(
    withSomethingMissing([pr, recordRow({ ...base, missingReason: null })])
      .length,
    1,
  );
});

Deno.test("each figure opens the metric that lists exactly what it counts", () => {
  assertEquals(isDeliveryShow("merged"), true);
  assertEquals(isDeliveryShow("lines"), false);
  assertEquals(SHOW_METRIC.tasks, "tasks.leadTimeHours");
  assertEquals(SHOW_METRIC.merged, "prs.changedLines");
});

Deno.test("a duration reads in the two units that matter and never as 0", () => {
  assertEquals(durationWords(0).key, "delivery.duration.none");
  assertEquals(durationWords(0.001).key, "delivery.duration.lessThanMinute");
  assertEquals(durationWords(0.5), {
    key: "delivery.duration.minutes",
    params: { minutes: "30" },
  });
  assertEquals(durationWords(3 + 20 / 60), {
    key: "delivery.duration.hoursMinutes",
    params: { hours: "3", minutes: "20" },
  });
  assertEquals(durationWords(5).key, "delivery.duration.hours");
  assertEquals(durationWords(52), {
    key: "delivery.duration.daysHours",
    params: { days: "2", hours: "4" },
  });
  assertEquals(durationWords(72).key, "delivery.duration.days");
});

const share = (category: string, hours: number | null) => ({
  category,
  hours,
  unknownReason: hours === null ? "not_recorded" : null,
});
const taskSeries = (
  breakdown: ReturnType<typeof share>[],
  points: [number, number],
) =>
  ({
    summary: {
      median: 4,
      p90: 9,
      mean: 5,
      breakdown,
      deliveryPoints: [
        { deliveryPoint: "merged_pull_request", count: points[0] },
        { deliveryPoint: "completed_run", count: points[1] },
      ],
    },
  }) as unknown as MetricSeries;

Deno.test("the time bar adds up to its total, with Not accounted for last and Blocked never a part", () => {
  const lead = leadTimeOf(taskSeries([
    share("agentWorking", 6),
    share("queue", 2),
    share("review", 1),
    share("person", 3),
    share("blocked", null),
    share("unaccounted", 4),
  ], [5, 0]))!;
  assertEquals(lead.parts.map((part) => part.id), [
    "agentWorking",
    "queue",
    "review",
    "person",
    "unaccounted",
  ]);
  assertEquals(lead.totalHours, 16);
  assertEquals(lead.blockedKnown, false);
  assertEquals(lead.point, "merge");
  assertEquals([lead.count, lead.median, lead.p90], [5, 4, 9]);
});

Deno.test("a part with no time is absent, and a known Blocked becomes a part", () => {
  const lead = leadTimeOf(taskSeries([
    share("agentWorking", 3),
    share("queue", 0),
    share("review", null),
    share("person", 0),
    share("blocked", 2),
    share("unaccounted", 0),
  ], [1, 3]))!;
  assertEquals(lead.parts.map((part) => part.id), ["agentWorking", "blocked"]);
  assertEquals(lead.blockedKnown, true);
  assertEquals(lead.point, "mixed");
  assertEquals(lead.runCount, 3);
});

Deno.test("no tasks delivered means no lead-time summary, never a bar of zeros", () => {
  assertEquals(leadTimeOf(undefined), null);
  assertEquals(
    leadTimeOf(taskSeries([share("agentWorking", 0)], [0, 0])),
    null,
  );
  assertEquals(leadTimeOf(taskSeries([], [0, 2]))!.point, "run");
});

Deno.test("the rule line names the definitions version only when one is served", () => {
  assertEquals(ruleKey("merged", "3"), "delivery.records.rule.merged");
  assertEquals(ruleKey("tasks", "3"), "delivery.records.rule.tasks");
  assertEquals(
    ruleKey("merged", null),
    "delivery.records.rule.merged.noVersion",
  );
  assertEquals(
    ruleKey("closed", null),
    "delivery.records.rule.closed.noVersion",
  );
});

Deno.test("a chart breaks its line where nothing was measured and names the gaps", () => {
  const points = [
    { at: "2026-11-01T00:00:00.000Z", value: 3 },
    { at: "2026-11-02T00:00:00.000Z", value: 5 },
    { at: "2026-11-03T00:00:00.000Z", value: null },
    { at: "2026-11-04T00:00:00.000Z", value: null },
    { at: "2026-11-05T00:00:00.000Z", value: 2 },
  ];
  assertEquals(chartSegments(points).length, 2);
  assertEquals(chartSegments(points)[0]?.map((point) => point.value), [3, 5]);
  assertEquals(chartSegments(points)[1]?.map((point) => point.value), [2]);
  assertEquals(chartGaps(points), [{
    from: "2026-11-03T00:00:00.000Z",
    to: "2026-11-04T00:00:00.000Z",
    points: 2,
  }]);
  assertEquals(chartMaximum(points), 5);
  assertEquals(chartSegments([]).length, 0);
  assertEquals(chartGaps([]).length, 0);
});

Deno.test("chart gaps count the actual days in partial weekly buckets", () => {
  const points = [
    { at: "2026-01-01T00:00:00.000Z", value: null },
    { at: "2026-01-08T00:00:00.000Z", value: null },
    { at: "2026-01-15T00:00:00.000Z", value: 2 },
    { at: "2026-01-22T00:00:00.000Z", value: null },
  ];
  assertEquals(
    chartMissingDays(points, "2026-01-25T00:00:00.000Z"),
    17,
  );
});
