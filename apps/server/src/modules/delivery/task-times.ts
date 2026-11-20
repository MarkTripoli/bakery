/**
 * Where a task's time went (chapter 18, issue #46 slice B).
 *
 * A task's lead time runs from when its first run was admitted to its
 * delivery point: its first merged pull request, else the finish of its
 * last completed run. Inside that span every instant belongs to at most one
 * category, so the parts never overlap and never add up to more than the
 * elapsed time. When intervals overlap the most specific wins: a person wait,
 * then review, then agent work, then queue. Time no category covers is left
 * uncategorized; nothing is invented. Bakery records no history of when a
 * task or run was blocked, so Blocked is unknown, never zero.
 */

import type { PgTransactionClient } from "@bakery/persistence";

export const WaitCategory = Object.freeze(
  {
    AgentWorking: "agentWorking",
    Queue: "queue",
    Review: "review",
    Person: "person",
    Blocked: "blocked",
    /** Lead time no recorded interval covers: total minus the known parts. */
    Unaccounted: "unaccounted",
  } as const,
);
export type WaitCategory = typeof WaitCategory[keyof typeof WaitCategory];

/** Order of precedence where intervals overlap, most specific first. */
const PRECEDENCE: readonly WaitCategory[] = [
  WaitCategory.Person,
  WaitCategory.Review,
  WaitCategory.AgentWorking,
  WaitCategory.Queue,
];

/** The step key of the independent review loop. */
export const REVIEW_STEP_KEY = "review.independent";

export type DeliveryPoint = "merged_pull_request" | "completed_run";

export type Interval = Readonly<{ start: number; end: number }>;

export type TaskTimeline = Readonly<{
  taskId: string;
  title: string;
  requestedAt: Date;
  deliveredAt: Date | null;
  deliveryPoint: DeliveryPoint | null;
  intervals: Readonly<
    Record<"agentWorking" | "queue" | "review" | "person", Interval[]>
  >;
}>;

export type WaitShare = {
  category: WaitCategory;
  hours: number | null;
  unknownReason: "not_recorded" | null;
};

const HOUR_MS = 3_600_000;

/** Sorted, merged, clipped to [from, to); empty and inverted spans dropped. */
export function union(
  intervals: readonly Interval[],
  from: number,
  to: number,
): Interval[] {
  const clipped = intervals
    .map((i) => ({ start: Math.max(i.start, from), end: Math.min(i.end, to) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of clipped) {
    const last = out.at(-1);
    if (last && i.start <= last.end) {
      out[out.length - 1] = {
        start: last.start,
        end: Math.max(last.end, i.end),
      };
    } else out.push(i);
  }
  return out;
}

function subtract(base: Interval[], taken: Interval[]): Interval[] {
  let rest = base;
  for (const t of taken) {
    const next: Interval[] = [];
    for (const r of rest) {
      if (t.end <= r.start || t.start >= r.end) {
        next.push(r);
        continue;
      }
      if (t.start > r.start) next.push({ start: r.start, end: t.start });
      if (t.end < r.end) next.push({ start: t.end, end: r.end });
    }
    rest = next;
  }
  return rest;
}

const total = (list: Interval[]) =>
  list.reduce((sum, i) => sum + (i.end - i.start), 0);

type Measured = Exclude<WaitCategory, "blocked" | "unaccounted">;
const MEASURED: readonly Measured[] = [
  WaitCategory.AgentWorking,
  WaitCategory.Queue,
  WaitCategory.Review,
  WaitCategory.Person,
];

/** Lead time in hours; null while the task has no delivery point. */
export function leadTimeHours(task: TaskTimeline): number | null {
  return task.deliveredAt === null
    ? null
    : (task.deliveredAt.getTime() - task.requestedAt.getTime()) / HOUR_MS;
}

function shares(
  known: Map<Measured, number>,
  lead: number | null,
): WaitShare[] {
  const measured: WaitShare[] = MEASURED.map((category) => ({
    category,
    hours: lead === null ? null : known.get(category) ?? 0,
    unknownReason: null,
  }));
  const sum = MEASURED.reduce((s, c) => s + (known.get(c) ?? 0), 0);
  return [
    ...measured,
    {
      category: WaitCategory.Blocked,
      hours: null,
      unknownReason: "not_recorded",
    },
    {
      category: WaitCategory.Unaccounted,
      hours: lead === null ? null : Math.max(0, lead - sum),
      unknownReason: null,
    },
  ];
}

/**
 * The non-overlapping time per category inside the task's span, then what no
 * interval covers, so the known parts and "unaccounted" add up to the lead
 * time exactly. Blocked is always unknown.
 */
export function waitShares(task: TaskTimeline): WaitShare[] {
  const from = task.requestedAt.getTime();
  const to = task.deliveredAt?.getTime() ?? from;
  let taken: Interval[] = [];
  const known = new Map<Measured, number>();
  for (const category of PRECEDENCE as readonly Measured[]) {
    const mine = subtract(union(task.intervals[category], from, to), taken);
    known.set(category, total(mine) / HOUR_MS);
    taken = union([...taken, ...mine], from, to);
  }
  return shares(known, leadTimeHours(task));
}

/** Nearest-rank percentile of a non-empty sample (p in (0, 1]). */
export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

/**
 * The cohort summary: mean, median and 9-in-10 lead time, each category's
 * total over the cohort (adding up to the summed lead time), and how many
 * tasks reached each delivery point.
 */
export function cohortSummary(tasks: readonly TaskTimeline[]) {
  const leads = tasks.map(leadTimeHours).filter((v): v is number => v !== null);
  const known = new Map<Measured, number>();
  for (const task of tasks) {
    for (const share of waitShares(task)) {
      if (
        share.hours === null || !MEASURED.includes(share.category as Measured)
      ) {
        continue;
      }
      const c = share.category as Measured;
      known.set(c, (known.get(c) ?? 0) + share.hours);
    }
  }
  const totalLead = leads.reduce((s, v) => s + v, 0);
  return {
    mean: leads.length === 0 ? null : totalLead / leads.length,
    median: percentile(leads, 0.5),
    p90: percentile(leads, 0.9),
    breakdown: shares(known, leads.length === 0 ? null : totalLead),
    deliveryPoints: [
      {
        deliveryPoint: "merged_pull_request" as const,
        count: tasks.filter((t) => t.deliveryPoint === "merged_pull_request")
          .length,
      },
      {
        deliveryPoint: "completed_run" as const,
        count: tasks.filter((t) => t.deliveryPoint === "completed_run").length,
      },
    ],
  };
}

const MAX_TASKS = 5_000;

/**
 * The tasks delivered in [from, to) with their intervals, bounded. A task is
 * delivered at its first merged pull request, else when its last run
 * completed while the task is completed.
 */
export async function readDeliveredTasks(
  tx: PgTransactionClient,
  organizationId: string,
  repositoryId: string | undefined,
  from: Date,
  to: Date,
): Promise<TaskTimeline[]> {
  const found = await tx.query<{
    id: string;
    title: string;
    requested_at: Date | null;
    merged_at: Date | null;
    completed_at: Date | null;
  }>(
    `with spans as (
       select t.id, t.title,
              (select min(r.created_at) from bakery.workflow_runs r
                where r.organization_id = t.organization_id
                  and r.task_id = t.id) as requested_at,
              (select min(p.merged_at) from bakery.pull_requests p
                where p.organization_id = t.organization_id
                  and p.task_id = t.id
                  and ($4::uuid is null or p.repository_id = $4))
                as merged_at,
              case when t.status = 'completed' then
                (select max(r.finished_at) from bakery.workflow_runs r
                  where r.organization_id = t.organization_id
                    and r.task_id = t.id and r.status = 'completed')
              end as completed_at
         from bakery.tasks t
        where t.organization_id = $1
          and ($4::uuid is null or exists (
            select 1 from bakery.pull_requests p
             where p.organization_id = t.organization_id
               and p.task_id = t.id and p.repository_id = $4))
     )
     select * from spans
      where coalesce(merged_at, completed_at) >= $2
        and coalesce(merged_at, completed_at) < $3
        and requested_at is not null
      order by id
      limit $5`,
    [organizationId, from, to, repositoryId ?? null, MAX_TASKS + 1],
  );
  if (found.rows.length > MAX_TASKS) {
    throw new RangeError("TASK_SCOPE_TOO_LARGE");
  }
  const ids = found.rows.map((row) => row.id);
  if (ids.length === 0) return [];
  const attempts = await tx.query<{
    task_id: string;
    step_key: string;
    job_ready: Date;
    claimed_at: Date;
    started_at: Date | null;
    ended_at: Date | null;
    attempt_no: number;
  }>(
    `select r.task_id, s.step_key,
            greatest(j.created_at, j.available_at) as job_ready,
            a.created_at as claimed_at, a.started_at, a.ended_at, a.attempt_no
       from bakery.job_attempts a
       join bakery.jobs j on j.organization_id = a.organization_id and j.id = a.job_id
       join bakery.run_steps s on s.organization_id = j.organization_id and s.id = j.run_step_id
       join bakery.workflow_runs r on r.organization_id = s.organization_id and r.id = s.run_id
      where a.organization_id = $1 and r.task_id = any($2::uuid[])`,
    [organizationId, ids],
  );
  const people = await tx.query<
    { task_id: string; start: Date; finish: Date | null }
  >(
    `select r.task_id, w.started_at as start, w.ended_at as finish
       from bakery.run_waits w
       join bakery.workflow_runs r on r.organization_id = w.organization_id and r.id = w.run_id
      where w.organization_id = $1 and r.task_id = any($2::uuid[])
     union all
     select q.task_id, q.created_at,
            coalesce(q.answered_at, q.decided_at,
              case when q.status <> 'open' then q.updated_at end)
       from bakery.questions q
      where q.organization_id = $1 and q.task_id = any($2::uuid[])
     union all
     select pr.task_id, pr.created_at,
            coalesce(pr.responded_at, pr.withdrawn_at,
              case when pr.status <> 'open' then pr.updated_at end)
       from bakery.person_requests pr
      where pr.organization_id = $1 and pr.task_id = any($2::uuid[])`,
    [organizationId, ids],
  );
  const byTask = new Map<string, {
    agentWorking: Interval[];
    queue: Interval[];
    review: Interval[];
    person: Interval[];
  }>(
    ids.map((
      id,
    ) => [id, { agentWorking: [], queue: [], review: [], person: [] }]),
  );
  const far = Number.MAX_SAFE_INTEGER;
  for (const a of attempts.rows) {
    const bucket = byTask.get(a.task_id)!;
    if (Number(a.attempt_no) === 1) {
      bucket.queue.push({
        start: a.job_ready.getTime(),
        end: a.claimed_at.getTime(),
      });
    }
    if (a.started_at !== null) {
      const span = {
        start: a.started_at.getTime(),
        end: a.ended_at?.getTime() ?? far,
      };
      (a.step_key === REVIEW_STEP_KEY ? bucket.review : bucket.agentWorking)
        .push(span);
    }
  }
  for (const p of people.rows) {
    byTask.get(p.task_id)!.person.push({
      start: p.start.getTime(),
      end: p.finish?.getTime() ?? far,
    });
  }
  return found.rows.map((row) => ({
    taskId: row.id,
    title: row.title,
    requestedAt: row.requested_at!,
    deliveredAt: row.merged_at ?? row.completed_at,
    deliveryPoint: row.merged_at !== null
      ? "merged_pull_request"
      : "completed_run",
    intervals: byTask.get(row.id)!,
  }));
}
