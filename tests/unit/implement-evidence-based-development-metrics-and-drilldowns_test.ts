/**
 * #46: development metrics over pull request facts, on the pure aggregation.
 * AC1: duplicate, reordered, reopened and cross-month observations count by
 * stable identity. AC2: unknown stays unknown; elapsed time is not double
 * counted. AC3's provenance half: a changed definition is a new revision.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  aggregate,
  measurementRevision,
  METRIC_DEFINITIONS,
  MetricKey,
  metricWindow,
  openAt,
  placements,
  type PullRequestFact,
  revisionOf,
  sortKey,
  sourceState,
} from "../../apps/server/src/modules/delivery/metrics.ts";
import {
  decodeCursor,
  encodeCursor,
} from "../../apps/server/src/platform/cursor.ts";
import { lifecycleFacts } from "../../apps/server/src/modules/integrations/pull-request-lifecycle.ts";

const t = (iso: string) => new Date(iso);
function pr(id: string, over: Partial<PullRequestFact> = {}): PullRequestFact {
  return {
    id,
    repositoryId: "r",
    taskId: "t",
    providerNumber: 1,
    url: "u",
    status: "open",
    openedAt: null,
    mergedAt: null,
    closedAt: null,
    additions: null,
    deletions: null,
    transitions: [],
    ...over,
  };
}

// Chapter 18's June example.
const june = metricWindow({
  from: "2026-06-01T00:00:00Z",
  to: "2026-07-01T00:00:00Z",
  resolution: "day",
}, t("2026-07-02T00:00:00Z"));
const A = pr("a", {
  status: "merged",
  openedAt: t("2026-05-31T12:00:00Z"),
  mergedAt: t("2026-06-01T12:00:00Z"),
  closedAt: t("2026-06-01T12:00:00Z"),
  additions: 10,
  deletions: 2,
});
const B = pr("b", {
  status: "merged",
  openedAt: t("2026-06-01T12:00:00Z"),
  mergedAt: t("2026-06-04T12:00:00Z"),
  closedAt: t("2026-06-04T12:00:00Z"),
});
const C = pr("c", { openedAt: t("2026-06-05T00:00:00Z") });

function total(key: MetricKey, facts: PullRequestFact[]) {
  const body = aggregate(key, placements(key, facts, june), june, true);
  return {
    ...body,
    sum: body.points.reduce((s, p) => s + (p.value ?? 0), 0),
  };
}

Deno.test("AC1: the June cohort: 2 merged, 48 h mean turnaround, 1 of 2 opened merged", () => {
  assertEquals(total(MetricKey.Merged, [A, B, C]).sum, 2);
  const turnaround = placements(MetricKey.TurnaroundHours, [A, B, C], june);
  assertEquals(
    turnaround.reduce((s, p) => s + (p.value ?? 0), 0) / turnaround.length,
    48,
  );
  const rate = placements(MetricKey.MergeRate, [A, B, C], june);
  assertEquals(rate.map((p) => [p.fact?.id, p.value]), [["b", 1], ["c", 0]]);
  const body = aggregate(MetricKey.MergeRate, rate, june, true);
  assertEquals(body.missingReasons, [{ reason: "still_open", count: 1 }]);
  assertEquals(body.completeness, "partial");
  // A opened in May: not June's opened cohort, but June's merge.
  assertEquals(total(MetricKey.Opened, [A, B, C]).sum, 2);
});

Deno.test("AC1: duplicate and reordered deliveries add no fact; a reopen is one PR", () => {
  // The store keeps one row per identity; the facts a read implies dedupe by
  // kind and effective time, whichever order the reads come in.
  const closed = {
    state: "closed" as const,
    merged: false,
    openedAt: t("2026-06-02T00:00:00Z"),
    mergedAt: null,
    closedAt: t("2026-06-03T00:00:00Z"),
    providerUpdatedAt: t("2026-06-03T00:00:00Z"),
    additions: null,
    deletions: null,
    changedFiles: null,
  };
  const reopened = {
    ...closed,
    state: "open" as const,
    closedAt: null,
    providerUpdatedAt: t("2026-06-10T00:00:00Z"),
  };
  const facts = [
    ...lifecycleFacts(null, closed),
    ...lifecycleFacts("closed", reopened),
    ...lifecycleFacts("open", reopened),
    ...lifecycleFacts(null, closed),
  ];
  const unique = new Set(
    facts.map((f) => f.kind + "@" + f.effectiveAt.toISOString()),
  );
  assertEquals([...unique].sort(), [
    "closed@2026-06-03T00:00:00.000Z",
    "opened@2026-06-02T00:00:00.000Z",
    "reopened@2026-06-10T00:00:00.000Z",
  ]);
  const D = pr("d", {
    openedAt: t("2026-06-02T00:00:00Z"),
    transitions: [
      { kind: "opened", at: t("2026-06-02T00:00:00Z") },
      { kind: "closed", at: t("2026-06-03T00:00:00Z") },
      { kind: "reopened", at: t("2026-06-10T00:00:00Z") },
    ],
  });
  assertEquals(openAt(D, t("2026-06-05T00:00:00Z")), false);
  assertEquals(openAt(D, t("2026-06-11T00:00:00Z")), true);
  assertEquals(total(MetricKey.Opened, [D]).sum, 1);
  assertEquals(total(MetricKey.ClosedUnmerged, [D]).sum, 0);
});

Deno.test("AC1: a late close never undoes a merge", () => {
  const merged = {
    state: "closed" as const,
    merged: true,
    openedAt: t("2026-06-01T00:00:00Z"),
    mergedAt: t("2026-06-02T00:00:00Z"),
    closedAt: t("2026-06-02T00:00:00Z"),
    providerUpdatedAt: t("2026-06-02T00:00:00Z"),
    additions: 1,
    deletions: 1,
    changedFiles: 1,
  };
  assertEquals(
    lifecycleFacts(null, merged).map((f) => f.kind),
    ["opened", "merged"],
  );
  const E = pr("e", { status: "merged", ...merged, closedAt: merged.closedAt });
  assertEquals(total(MetricKey.ClosedUnmerged, [E]).sum, 0);
});

Deno.test("AC2: unknown times and line totals stay unknown, never zero", () => {
  const noTimes = pr("n", { status: "merged" });
  const noLines = pr("l", {
    status: "merged",
    openedAt: t("2026-06-01T00:00:00Z"),
    mergedAt: t("2026-06-02T00:00:00Z"),
  });
  const lines = total(MetricKey.ChangedLines, [A, noLines]);
  assertEquals(lines.sum, 12);
  assertEquals(lines.missingReasons, [{ reason: "no_diff_totals", count: 1 }]);
  assertEquals(lines.missingCount, 1);
  const merged = total(MetricKey.Merged, [noTimes]);
  assertEquals(merged.missingReasons, [{ reason: "no_merged_time", count: 1 }]);
  const hours = aggregate(
    MetricKey.TurnaroundHours,
    placements(MetricKey.TurnaroundHours, [], june),
    june,
    true,
  );
  assert(
    hours.points.every((p) =>
      p.value === null && p.unknownReason === "no_records"
    ),
  );
  // Nothing ever read: every point is unknown, even counts.
  const never = aggregate(MetricKey.Opened, [], june, false);
  assertEquals(never.completeness, "unknown");
  assert(never.points.every((p) => p.value === null));
});

Deno.test("AC2: overlapping PRs each count once at a cutoff, and a closed one not at all", () => {
  const one = metricWindow({
    from: "2026-06-01T00:00:00Z",
    to: "2026-06-02T00:00:00Z",
    resolution: "day",
  }, t("2026-07-01T00:00:00Z"));
  const X = pr("x", { openedAt: t("2026-05-01T00:00:00Z") });
  const Y = pr("y", { openedAt: t("2026-05-15T00:00:00Z") });
  const Z = pr("z", {
    status: "closed",
    openedAt: t("2026-05-10T00:00:00Z"),
    closedAt: t("2026-05-20T00:00:00Z"),
  });
  const body = aggregate(
    MetricKey.OpenAtCutoff,
    placements(MetricKey.OpenAtCutoff, [X, Y, Z], one),
    one,
    true,
  );
  assertEquals(body.points[0].value, 2);
});

Deno.test("AC3: every definition has its own revision, and a changed one is new", () => {
  const revisions = Object.values(MetricKey).map(measurementRevision);
  assertEquals(new Set(revisions).size, revisions.length);
  const current = METRIC_DEFINITIONS[MetricKey.Merged];
  assertEquals(
    revisionOf(MetricKey.Merged, current),
    measurementRevision(MetricKey.Merged),
  );
  assertNotEquals(
    revisionOf(MetricKey.Merged, { ...current, cohort: current.cohort + "!" }),
    measurementRevision(MetricKey.Merged),
  );
  assertNotEquals(
    revisionOf(MetricKey.Merged, { ...current, placedBy: "closed" }),
    measurementRevision(MetricKey.Merged),
  );
});

Deno.test("the window is bounded: 30-day default, 366-day cap, 1,000 points", () => {
  const now = t("2026-07-01T00:00:00Z");
  const d = metricWindow({}, now);
  assertEquals(d.to.getTime() - d.from.getTime(), 30 * 86_400_000);
  assertThrows(() => metricWindow({ from: "2025-01-01T00:00:00Z" }, now));
  assertThrows(() =>
    metricWindow({ from: "2026-06-01T00:00:00Z", resolution: "minute" }, now)
  );
  assertThrows(() => metricWindow({ from: "2026-07-02T00:00:00Z" }, now));
});

Deno.test("a source is connected, stale or disconnected, never silently zero", () => {
  const now = t("2026-07-01T00:00:00Z");
  const base = {
    connectionStatus: "enabled",
    connectionArchivedAt: null,
    connectionUpdatedAt: t("2026-06-01T00:00:00Z"),
    lastSyncAt: t("2026-06-30T12:00:00Z"),
  };
  assertEquals(sourceState(base, now).state, "connected");
  assertEquals(
    sourceState({ ...base, lastSyncAt: t("2026-06-20T00:00:00Z") }, now).state,
    "stale",
  );
  assertEquals(
    sourceState({ ...base, connectionStatus: "degraded" }, now).state,
    "stale",
  );
  assertEquals(sourceState({ ...base, connectionStatus: "revoked" }, now), {
    state: "disconnected",
    since: "2026-06-01T00:00:00.000Z",
  });
  assertEquals(sourceState({ ...base, connectionStatus: null }, now), {
    state: "disconnected",
    since: null,
  });
});

Deno.test("the drilldown cursor round-trips a known and an unknown placed time", async () => {
  const binding = {
    action: "metrics.sources",
    principalId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    ordering: "countedAt:asc,id:asc",
    filters: "{}",
    schemaVersion: 1,
  };
  const known = placements(MetricKey.Merged, [A], june)[0];
  const unknown =
    placements(MetricKey.Merged, [pr("u", { status: "merged" })], june)[0];
  for (const p of [known, unknown]) {
    const [createdAt] = sortKey(p);
    const id = crypto.randomUUID();
    const cursor = await encodeCursor("secret", binding, { createdAt, id });
    assertEquals(
      (await decodeCursor("secret", cursor, binding))?.createdAt,
      createdAt,
    );
  }
  assert(sortKey(known)[0] < sortKey(unknown)[0]);
});
