import { StandardError } from "@bakery/contracts/http";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  adapterSupportsControl,
  readAdapterCapabilities,
} from "../execution/adapter-capabilities.ts";
import { enqueueWorkerControlCommand } from "../execution/coordination.ts";

/**
 * Best-effort pause of a run whose ticket request was suspended. Request-level
 * suspension is the control: it stops the next `runs.create`. A run that was
 * already executing is asked to pause only when it has a live attempt on a
 * worker whose adapter can steer or interrupt it; otherwise nothing is
 * enqueued and the recheck tries again on its next pass.
 */

/** Why no pause command was enqueued. */
export type RunPauseRefusal =
  | "no_live_attempt"
  | "unsupported"
  | "state_conflict"
  | "already_terminal";

export type RunPauseOutcome =
  | { requested: true }
  | { requested: false; reason: RunPauseRefusal };

/** The reason carried on the worker command. */
export const TICKET_PAUSE_REASON = "ticket_request_suspended";

/**
 * Enqueues a `pause` control command for every live attempt of the run, in the
 * caller's transaction. The live attempts are the ones `runs.control` finds:
 * each step's attempt that is leased, running or canceling and holds the job's
 * current fence (a plan run in a parallel group has one per lane). Every one
 * must be on a worker whose adapter can steer or interrupt it, or nothing is
 * enqueued. The idempotency key names the request and its version, so a
 * repeated pass of the same version enqueues once per attempt and a later
 * suspension (a new version) can pause again. A lane that ended between the
 * read and the enqueue does not hold the others back: they are paused, and the
 * refusal is reported so the next pass looks again (the ones already enqueued
 * dedupe). Sets nothing on the run or the request: the caller records
 * `pause_requested_at` only when `requested` is true.
 */
export async function requestRunPause(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    runId: string;
    traceId: string;
    requestId: string;
    version: number;
  },
): Promise<RunPauseOutcome> {
  const attempts = await transaction.query<{
    id: string;
    adapterCapabilities: unknown;
  }>(
    `select attempt.id, host.adapter_capabilities as "adapterCapabilities"
       from bakery.workflow_runs as run
       join bakery.run_steps as step
         on step.organization_id = run.organization_id
        and step.run_id = run.id
       join bakery.jobs as job
         on job.organization_id = step.organization_id
        and job.run_step_id = step.id
       join bakery.job_attempts as attempt
         on attempt.organization_id = job.organization_id
        and attempt.job_id = job.id
       join bakery.worker_hosts as host
         on host.organization_id = attempt.organization_id
        and host.id = attempt.worker_host_id
      where run.organization_id = $1
        and run.id = $2
        and attempt.status in ('leased', 'running', 'canceling')
        and job.current_fence = attempt.fence
      order by step.position asc, step.iteration asc,
        attempt.attempt_no desc, attempt.id desc`,
    [input.organizationId, input.runId],
  );
  if (attempts.rows.length === 0) {
    return { requested: false, reason: "no_live_attempt" };
  }
  for (const attempt of attempts.rows) {
    if (
      !adapterSupportsControl(
        "pause",
        readAdapterCapabilities(attempt.adapterCapabilities),
      )
    ) {
      return { requested: false, reason: "unsupported" };
    }
  }
  const requestDigest = await sha256Hex(canonicalJson({
    runId: input.runId,
    action: "pause",
    reason: TICKET_PAUSE_REASON,
  }));
  let refusal: RunPauseRefusal | undefined;
  for (const attempt of attempts.rows) {
    try {
      await enqueueWorkerControlCommand(transaction, {
        organizationId: input.organizationId,
        attemptId: attempt.id,
        action: "pause",
        reason: TICKET_PAUSE_REASON,
        idempotencyKey: `ticket-pause:${input.requestId}:${input.version}`,
        requestDigest,
        traceId: input.traceId,
      });
    } catch (error) {
      // The attempt ended, its lease lapsed or its session moved between the
      // read and the enqueue: nothing to pause there, and the next pass looks
      // again.
      if (error instanceof StandardError) {
        if (error.code === "STATE_CONFLICT") {
          refusal ??= "state_conflict";
          continue;
        }
        if (error.code === "ALREADY_TERMINAL") {
          refusal ??= "already_terminal";
          continue;
        }
      }
      throw error;
    }
  }
  return refusal === undefined
    ? { requested: true }
    : { requested: false, reason: refusal };
}
