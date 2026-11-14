/**
 * What one tick does with the occurrences of a schedule that are due (issue #36),
 * as pure functions: how many are due, and which firing stands in for them.
 *
 * `automation.tick` finds an automation whose cursor (`next_fire_at`) is due.
 * The occurrences from the cursor up to now are the due ones. One due is an
 * ordinary firing. More than one means the tick was late (a restart, an outage,
 * a disabled automation switched back on): the version's misfire policy decides,
 * and either way at most one firing is created, never a backlog:
 *   - `coalesce`: one queued firing, keyed by the latest due occurrence, that
 *     carries the others as `skippedCount`;
 *   - `skip`: one firing, status `skipped`, that records every due occurrence
 *     in `skippedCount` and runs nothing.
 */
import {
  type CronSchedule,
  MAX_OCCURRENCES,
  occurrencesBetween,
} from "./schedule.ts";

/** How far back a catch-up counts due occurrences; older ones are not counted. */
export const CATCH_UP_DAYS = 366;

export type MisfirePolicy = "coalesce" | "skip";

export type DueOccurrences = Readonly<{
  /** How many occurrences fall from the cursor up to now (within the catch-up window). */
  count: number;
  /** The latest of them: the firing's scheduled instant. */
  latest: Date;
}>;

/**
 * The due occurrences from `cursor` (inclusive) up to `now` (inclusive), or null
 * when none is due. Only the last `CATCH_UP_DAYS` days are counted, so the work
 * is bounded however long the outage was: a per-minute schedule is at most about
 * 530,000 occurrences, found a hundred thousand at a time.
 */
export function dueOccurrences(
  schedule: CronSchedule,
  zone: string,
  cursor: Date,
  now: Date,
): DueOccurrences | null {
  const earliest = new Date(now.getTime() - CATCH_UP_DAYS * 86_400_000);
  // The cursor is itself an occurrence; the window is open at its start.
  let after = new Date(Math.max(cursor.getTime(), earliest.getTime()) - 1);
  let count = 0;
  let latest: Date | null = null;
  while (true) {
    const window = occurrencesBetween(
      schedule,
      zone,
      after,
      now,
      MAX_OCCURRENCES,
    );
    count += window.occurrences.length;
    const last = window.occurrences.at(-1);
    if (last !== undefined) latest = last;
    if (!window.truncated || last === undefined) break;
    after = last;
  }
  return latest === null ? null : { count, latest };
}

export type FiringPlan = Readonly<{
  scheduledAt: Date;
  status: "queued" | "skipped";
  /** Admitted but no run has started: a queued firing waits for its run. */
  pending: boolean;
  skippedCount: number;
}>;

/** The one firing that stands in for the due occurrences, by the misfire policy. */
export function planFiring(
  policy: MisfirePolicy,
  due: DueOccurrences,
): FiringPlan {
  if (due.count <= 1 || policy === "coalesce") {
    return {
      scheduledAt: due.latest,
      status: "queued",
      pending: true,
      skippedCount: Math.max(0, due.count - 1),
    };
  }
  return {
    scheduledAt: due.latest,
    status: "skipped",
    pending: false,
    skippedCount: due.count,
  };
}
