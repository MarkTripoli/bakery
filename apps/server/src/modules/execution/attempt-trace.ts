import {
  childTraceContext,
  formatTraceparent,
  parseTraceparent,
  type TraceContext,
  type TraceLink,
} from "@bakery/config/telemetry-trace";
import type { TelemetryTrace } from "@bakery/config/telemetry";
import type { PgDatabase } from "../../platform/database.ts";

/**
 * What a worker attempt's telemetry says about where it sits in the run's trace.
 *
 * The claim hands the worker a span of its own (a child of the run's span) and
 * keeps it on the attempt (0290). An event about the attempt - a renewal, a
 * result, settled usage - is a child of that span, so every one of them lands in
 * the run's single trace. A retried attempt also links to the first attempt of
 * the same step, so a trace shows the attempts as one piece of work that was
 * tried again, not as unrelated runs.
 */
export type AttemptTrace = Readonly<{
  /** The attempt's own span; events are recorded beneath it. */
  context: TraceContext;
  /** The first attempt's span when this one is a retry, else empty. */
  links: readonly TraceLink[];
  /** 1 for the first attempt of the step. */
  attemptNumber: number;
}>;

type Row = {
  traceparent: string | null;
  attempt_id: string;
  first_attempt_id: string | null;
  first_traceparent: string | null;
  attempt_number: string;
};

/**
 * Reads an attempt's span and the first attempt of its step. The first attempt is
 * the earliest one across every job of the same step (a coordinator turn has no
 * step, so its own job's earliest). Returns undefined for an attempt claimed
 * before the span was kept, which then records its events with no trace, as before.
 */
export async function loadAttemptTrace(
  database: Pick<PgDatabase, "query">,
  organizationId: string,
  attemptId: string,
): Promise<AttemptTrace | undefined> {
  const result = await database.query<Row>(
    `select attempt.traceparent, attempt.id as attempt_id,
            first.id as first_attempt_id, first.traceparent as first_traceparent,
            (select count(*)::text from bakery.job_attempts earlier
               join bakery.jobs earlier_job
                 on earlier_job.organization_id = earlier.organization_id
                and earlier_job.id = earlier.job_id
              where earlier.organization_id = attempt.organization_id
                and (
                  (job.run_step_id is not null
                    and earlier_job.run_step_id = job.run_step_id)
                  or (job.run_step_id is null and earlier.job_id = attempt.job_id)
                )
                and (earlier.created_at, earlier.id)
                  <= (attempt.created_at, attempt.id)) as attempt_number
       from bakery.job_attempts attempt
       join bakery.jobs job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
       left join lateral (
         select candidate.id, candidate.traceparent
           from bakery.job_attempts candidate
           join bakery.jobs candidate_job
             on candidate_job.organization_id = candidate.organization_id
            and candidate_job.id = candidate.job_id
          where candidate.organization_id = attempt.organization_id
            and (
              (job.run_step_id is not null
                and candidate_job.run_step_id = job.run_step_id)
              or (job.run_step_id is null and candidate.job_id = attempt.job_id)
            )
          order by candidate.created_at, candidate.id
          limit 1
       ) first on true
      where attempt.organization_id = $1 and attempt.id = $2`,
    [organizationId, attemptId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const context = parseTraceparent(row.traceparent);
  if (context === undefined) return undefined;
  const first = row.first_attempt_id !== row.attempt_id
    ? parseTraceparent(row.first_traceparent)
    : undefined;
  return {
    context,
    links: first === undefined
      ? []
      : [{ traceId: first.traceId, spanId: first.spanId }],
    attemptNumber: Number(row.attempt_number),
  };
}

/** The shape the telemetry port takes for an event about the attempt. */
export function attemptTelemetryTrace(trace: AttemptTrace): TelemetryTrace {
  return { context: trace.context, links: trace.links };
}

/**
 * The span a child session starts in: its parent's trace and a span of its own.
 *
 * A sub-session is part of the same run, so it must not start a trace of its
 * own (`agent_sessions.parent_session_id` says whose child it is, and this says
 * which trace). A parent with no usable context gives the child none rather than
 * a made-up root, so one half of a run is never filed under an unrelated trace.
 * Nothing creates a sub-session yet; the code that does must take its span here.
 */
export function childSessionTraceparent(
  parentTraceparent: string | null | undefined,
): string | undefined {
  const parent = parseTraceparent(parentTraceparent);
  return parent === undefined
    ? undefined
    : formatTraceparent(childTraceContext(parent));
}
