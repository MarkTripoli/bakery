import { assert } from "@std/assert";
import {
  closePgDatabase,
  openPgDatabase,
  withPgTransaction,
} from "../../../apps/server/src/platform/database.ts";
import type { Stack } from "./stack.ts";

export type RunOutputSeedState =
  | "default"
  | "exit"
  | "timeout"
  | "lost-lease"
  | "truncated"
  | "interrupted";
const states = {
  default: {
    attempt: "running",
    job: "running",
    complete: false,
    capture: "capturing",
    reason: null,
    closed: false,
    result: null,
  },
  exit: {
    attempt: "completed",
    job: "completed",
    complete: true,
    capture: "complete",
    reason: "clean-end",
    closed: true,
    result: { status: "completed", result: { exitCode: 0 } },
  },
  timeout: {
    attempt: "completed",
    job: "completed",
    complete: true,
    capture: "interrupted",
    reason: "source-lost",
    closed: true,
    result: { status: "completed", result: { status: "timed_out" } },
  },
  "lost-lease": {
    attempt: "lost",
    job: "queued",
    complete: false,
    capture: "interrupted",
    reason: "lease-lost",
    closed: false,
    result: null,
  },
  truncated: {
    attempt: "running",
    job: "running",
    complete: false,
    capture: "truncated",
    reason: "text-limit",
    closed: false,
    result: null,
  },
  interrupted: {
    attempt: "running",
    job: "running",
    complete: false,
    capture: "interrupted",
    reason: "source-lost",
    closed: false,
    result: null,
  },
} as const;

/** Configure isolated read-proof snapshots; `default` restores the initial active tuple. */
export async function configureRunOutputState(
  stack: Pick<Stack, "ownerDatabaseUrl">,
  fixture: Readonly<
    {
      taskId: string;
      runId: string;
      stepId: string;
      scope: { organizationId: string };
    }
  >,
  output: Readonly<{ jobId: string; streamId: string }>,
  attemptId: string,
  state: RunOutputSeedState,
): Promise<void> {
  const selected = states[state];
  const lost = state === "lost-lease";
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    await withPgTransaction(database, async (transaction) => {
      const attempt = (await transaction.query<{ fence: string }>(
        `select a.fence::text from bakery.job_attempts a
         join bakery.jobs job on job.organization_id=a.organization_id and job.id=a.job_id
         join bakery.run_steps step on step.organization_id=job.organization_id and step.id=job.run_step_id
         join bakery.workflow_runs run on run.organization_id=step.organization_id and run.id=step.run_id
         join bakery.session_output_streams stream on stream.organization_id=job.organization_id and stream.job_id=job.id
         where a.organization_id=$1 and a.id=$2 and job.id=$3 and step.id=$4 and run.id=$5 and run.task_id=$6 and stream.id=$7`,
        [
          fixture.scope.organizationId,
          attemptId,
          output.jobId,
          fixture.stepId,
          fixture.runId,
          fixture.taskId,
          output.streamId,
        ],
      )).rows[0];
      assert(
        attempt,
        "State fixture must retain exact task/run/job/attempt/output ownership",
      );
      await transaction.query(
        `update bakery.job_attempts set status=$3, result=$4::jsonb,
        ended_at=case when $5 then clock_timestamp() else null end,
        lease_expires_at=clock_timestamp()+case when $6 then interval '-1 second' else interval '30 minutes' end,
        updated_at=clock_timestamp(),version=version+1 where organization_id=$1 and id=$2`,
        [
          fixture.scope.organizationId,
          attemptId,
          selected.attempt,
          selected.result === null ? null : JSON.stringify(selected.result),
          selected.complete || lost,
          lost,
        ],
      );
      await transaction.query(
        `update bakery.jobs set status=$3,current_fence=$4,
        cancel_requested_at=null,updated_at=clock_timestamp(),version=version+1 where organization_id=$1 and id=$2`,
        [
          fixture.scope.organizationId,
          output.jobId,
          selected.job,
          (BigInt(attempt.fence) + (lost ? 1n : 0n)).toString(),
        ],
      );
      await transaction.query(
        `update bakery.workflow_runs set status=$3,
        finished_at=case when $4 then clock_timestamp() else null end,
        updated_at=clock_timestamp(),version=version+1 where organization_id=$1 and id=$2`,
        [
          fixture.scope.organizationId,
          fixture.runId,
          selected.complete ? "completed" : "running",
          selected.complete,
        ],
      );
      await transaction.query(
        `update bakery.run_steps set status=$3,
        finished_at=case when $4 then clock_timestamp() else null end,
        updated_at=clock_timestamp(),version=version+1 where organization_id=$1 and id=$2`,
        [
          fixture.scope.organizationId,
          fixture.stepId,
          selected.complete ? "completed" : "running",
          selected.complete,
        ],
      );
      await transaction.query(
        `update bakery.session_output_streams set capture=$3,reason=$4,closed=$5
        where organization_id=$1 and id=$2`,
        [
          fixture.scope.organizationId,
          output.streamId,
          selected.capture,
          selected.reason,
          selected.closed,
        ],
      );
      await transaction.query(
        `update bakery.session_output_producers set ended_reason=$3
        where organization_id=$1 and session_id=$2 and attempt_id=$4`,
        [
          fixture.scope.organizationId,
          output.streamId,
          selected.closed || lost ? selected.reason : null,
          attemptId,
        ],
      );
    });
  } finally {
    await closePgDatabase(database);
  }
}
