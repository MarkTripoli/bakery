/**
 * #46 slice B: where a task's time went. The parts never overlap, the known
 * parts plus "unaccounted" add up to the lead time exactly, overlaps resolve
 * person > review > agent > queue, and Blocked is unknown (not recorded).
 */

import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  cohortSummary,
  leadTimeHours,
  percentile,
  type TaskTimeline,
  union,
  waitShares,
} from "../../apps/server/src/modules/delivery/task-times.ts";
import {
  aggregate,
  MetricKey,
  metricWindow,
  taskPlacements,
} from "../../apps/server/src/modules/delivery/metrics.ts";

const H = 3_600_000;
const t0 = Date.parse("2026-06-01T00:00:00Z");
const span = (fromH: number, toH: number) => ({
  start: t0 + fromH * H,
  end: t0 + toH * H,
});

function task(
  hours: number,
  intervals: Partial<TaskTimeline["intervals"]>,
  deliveryPoint: TaskTimeline["deliveryPoint"] = "merged_pull_request",
): TaskTimeline {
  return {
    taskId: crypto.randomUUID(),
    title: "t",
    requestedAt: new Date(t0),
    deliveredAt: new Date(t0 + hours * H),
    deliveryPoint,
    intervals: {
      agentWorking: [],
      queue: [],
      review: [],
      person: [],
      ...intervals,
    },
  };
}

const byCategory = (t: TaskTimeline) =>
  Object.fromEntries(waitShares(t).map((s) => [s.category, s.hours]));

Deno.test("union merges overlapping spans and clips to the task's span", () => {
  assertEquals(
    union([span(1, 3), span(2, 5), span(8, 9), span(-2, 0.5)], t0, t0 + 6 * H),
    [span(0, 0.5), span(1, 5)],
  );
});

Deno.test("parallel agents do not double count elapsed time", () => {
  const t = task(10, { agentWorking: [span(1, 5), span(2, 6), span(3, 4)] });
  assertEquals(byCategory(t).agentWorking, 5);
  assertEquals(byCategory(t).unaccounted, 5);
});

Deno.test("overlaps resolve person, then review, then agent, then queue", () => {
  const t = task(10, {
    queue: [span(0, 2)],
    agentWorking: [span(1, 6)],
    review: [span(5, 8)],
    person: [span(7, 9)],
  });
  const c = byCategory(t);
  assertEquals(c.person, 2); // 7-9
  assertEquals(c.review, 2); // 5-7
  assertEquals(c.agentWorking, 4); // 1-5
  assertEquals(c.queue, 1); // 0-1
  assertEquals(c.unaccounted, 1); // 9-10
  assertEquals(c.blocked, null);
  const known = waitShares(t).filter((s) => s.category !== "blocked")
    .reduce((s, x) => s + (x.hours ?? 0), 0);
  assertEquals(known, leadTimeHours(t));
});

Deno.test("an open interval ends at the delivery point, never past it", () => {
  const t = task(4, {
    person: [{ start: t0 + H, end: Number.MAX_SAFE_INTEGER }],
  });
  assertEquals(byCategory(t).person, 3);
});

Deno.test("Blocked is unknown with a reason, never zero", () => {
  const blocked = waitShares(task(3, {})).find((s) =>
    s.category === "blocked"
  )!;
  assertEquals(blocked, {
    category: "blocked",
    hours: null,
    unknownReason: "not_recorded",
  });
});

Deno.test("median, 9-in-10 and mean are computed on the server", () => {
  assertEquals(percentile([], 0.5), null);
  assertEquals(percentile([5], 0.9), 5);
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assertEquals(percentile(values, 0.5), 5);
  assertEquals(percentile(values, 0.9), 9);
  const s = cohortSummary([
    task(2, { agentWorking: [span(0, 1)] }),
    task(4, {}, "completed_run"),
  ]);
  assertEquals([s.median, s.p90, s.mean], [2, 4, 3]);
  const parts = Object.fromEntries(
    s.breakdown.map((b) => [b.category, b.hours]),
  );
  assertEquals(parts.agentWorking, 1);
  assertAlmostEquals(parts.unaccounted as number, 5);
  assertEquals(s.deliveryPoints, [
    { deliveryPoint: "merged_pull_request", count: 1 },
    { deliveryPoint: "completed_run", count: 1 },
  ]);
  const empty = cohortSummary([]);
  assertEquals([empty.median, empty.p90, empty.mean], [null, null, null]);
});

Deno.test("task lead-time series uses the nearest-rank median in each bucket", () => {
  const deliveredAt = new Date(t0 + H);
  const tasks = [1, 2, 100].map((hours) => ({
    ...task(hours, {}),
    requestedAt: new Date(deliveredAt.getTime() - hours * H),
    deliveredAt,
  }));
  const window = metricWindow({
    from: new Date(t0),
    to: new Date(t0 + 24 * H),
    resolution: "day",
  }, deliveredAt);
  const series = aggregate(
    MetricKey.TaskLeadTime,
    taskPlacements(tasks, window),
    window,
    true,
  );
  assertEquals(series.points[0]?.value, 2);
});
