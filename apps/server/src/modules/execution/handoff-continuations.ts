import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  nextAggregateVersion,
} from "@bakery/persistence";
import { postgresErrorCode } from "../../platform/postgres-errors.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  decideManifestResume,
  type ResumeDecision,
} from "./handoff-eligibility.ts";
import { HandoffManifestSchema } from "./handoff-manifest.ts";

/**
 * `handoffManifests.continue` (#33 slice 2): retire the source attempt of a
 * stored manifest and admit the job again for a continuation, with exactly one
 * winner however many handoff, cancel and recovery submissions race.
 *
 * ## What a handoff changes, and why it is one transaction
 *
 * The same job, on the same pin, with the same input, is claimed again by a new
 * attempt. Three parts are wrong apart:
 *
 * - the source must stop (its attempt is fenced: `lost`, and the job's fence
 *   advances, so its next heartbeat, event or result is `LEASE_FENCED`),
 * - the job must be claimable again (`queued`), and
 * - the manifest must say it was used, so a second handoff of the same record is
 *   refused instead of admitting a second continuation.
 *
 * They happen together, under the same locks, or not at all. The manifest was
 * persisted while the source was still live (slice 1), so a crash between the
 * two leaves a manifest and a live attempt, never a retired attempt with nothing
 * to continue from.
 *
 * ## What this does not touch
 *
 * - The job's input, billing and agent configuration. The input is pinned at
 *   admission (the sealed-credential digest and the step's declared context
 *   inputs are computed from it), so the continuation reads the manifest by its
 *   id from the continuation record and the job is requeued unchanged.
 * - The budget. The job keeps its one reservation exactly as the existing
 *   lost-attempt requeue does; the continuation changes who runs it, not what it
 *   may spend.
 * - Crash recovery. A source that is not live is handled by the existing
 *   lost-attempt and retry policy; this transition is only for a live source
 *   that was asked to hand off, and a terminal job never becomes claimable.
 *
 * ## Uncertain effects park the job
 *
 * An external effect that may or may not have happened is never repeated and
 * never trusted. The source is still retired and the fence advances, but the job
 * waits in `awaiting_reconciliation` instead of queueing, as a fresh session
 * with no checkpoint. `releaseReconciledHandoffs` (handoff-release.ts) queues it
 * once every effect of the step is settled.
 *
 * ## Refusals commit nothing
 *
 * Every refusal is a thrown error before a write, so the transaction rolls back
 * and a stale or refused submission leaves no trace. Each is named:
 * `PRECONDITION_FAILED` (the run changed since the offer), `run_not_active`,
 * `already_continued`, `manifest_blocked`, `source_not_live`, `fence_moved`,
 * `job_terminal`, `cancel_requested`, `awaiting_reconciliation`,
 * `attempt_budget_exhausted` and `capture_incomplete`.
 *
 * ## Lock order
 *
 * Attempts, then jobs, then the run, then the manifest. The worker cancel path
 * locks an attempt before its job, and the no-attempt cancel locks jobs before the
 * run, so this order agrees with both and cannot deadlock against either.
 * Everything is re-read under its lock: a cancel that won the race is seen as
 * `cancel_requested` or a terminal run and loses nothing.
 */

type Continue = z.output<typeof contractSchemas.HandoffContinue>;

const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "canceled",
  "blocked",
  "needs_human",
];
const TERMINAL_JOB_STATUSES = ["completed", "failed", "canceled"];
const LIVE_ATTEMPT_STATUSES = ["leased", "running", "canceling"];
const POSTGRES_UNIQUE_VIOLATION = "23505";

const refuse = (reason: string) =>
  new StandardError({ code: "STATE_CONFLICT", params: { reason } });

type ManifestRow = {
  id: string;
  run_id: string;
  run_step_id: string;
  source_attempt_id: string;
  source_fence: string;
  status: string;
  mode: string;
  digest: string;
  manifest: unknown;
};

export async function admitHandoffContinuation(
  context: ActionContext,
  input: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const manifestId = context.params.id;
  if (!manifestId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const value = input as Continue;

  // The manifest names its step; read it unlocked first so the locks can be
  // taken in the order above, then re-read it under its lock.
  const named = (await transaction.query<
    { run_id: string; run_step_id: string }
  >(
    `select run_id, run_step_id from bakery.handoff_manifests
      where organization_id = $1 and id = $2`,
    [organizationId, manifestId],
  )).rows[0];
  if (!named) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });

  // 1. Attempts, then jobs, of the step.
  const attempts = (await transaction.query<
    {
      id: string;
      job_id: string;
      status: string;
      fence: string;
      worker_host_id: string | null;
    }
  >(
    `select a.id, a.job_id, a.status, a.fence::text as fence,
            a.worker_host_id
       from bakery.job_attempts as a
       join bakery.jobs as j
         on j.organization_id = a.organization_id and j.id = a.job_id
      where a.organization_id = $1 and j.run_step_id = $2
      order by a.id
        for update of a`,
    [organizationId, named.run_step_id],
  )).rows;
  const jobs = (await transaction.query<
    {
      id: string;
      status: string;
      current_fence: string;
      max_attempts: number;
      cancel_requested_at: Date | string | null;
    }
  >(
    `select j.id, j.status, j.current_fence::text as current_fence,
            j.max_attempts, j.cancel_requested_at
       from bakery.jobs as j
      where j.organization_id = $1 and j.run_step_id = $2
      order by j.id
        for update of j`,
    [organizationId, named.run_step_id],
  )).rows;

  // 2. The run, under its lock.
  const run = (await transaction.query<{ status: string; version: number }>(
    `select status, version from bakery.workflow_runs
      where organization_id = $1 and id = $2
        for update`,
    [organizationId, named.run_id],
  )).rows[0];
  if (!run) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (TERMINAL_RUN_STATUSES.includes(run.status)) {
    throw refuse("run_not_active");
  }
  if (run.version !== value.runVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }

  // 3. The manifest, under its lock, and the state it must still describe.
  const manifest = (await transaction.query<ManifestRow>(
    `select id, run_id, run_step_id, source_attempt_id,
            source_fence::text as source_fence, status, mode, digest, manifest
       from bakery.handoff_manifests
      where organization_id = $1 and id = $2
        for update`,
    [organizationId, manifestId],
  )).rows[0];
  if (!manifest) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (manifest.status === "continued") throw refuse("already_continued");
  if (manifest.status !== "pending") throw refuse("manifest_blocked");
  // The stored bytes were validated on the way in; a row that no longer parses
  // is blocked, never guessed at.
  const stored = HandoffManifestSchema.safeParse(manifest.manifest);
  if (!stored.success) throw refuse("manifest_blocked");
  if (stored.data.repository.captureStatus !== "complete") {
    // A paused capture is not a workspace anyone can safely continue from.
    throw refuse("capture_incomplete");
  }

  const source = attempts.find((attempt) =>
    attempt.id === manifest.source_attempt_id
  );
  if (!source) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (!LIVE_ATTEMPT_STATUSES.includes(source.status)) {
    throw refuse("source_not_live");
  }
  const job = jobs.find((candidate) => candidate.id === source.job_id);
  if (!job) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (TERMINAL_JOB_STATUSES.includes(job.status)) throw refuse("job_terminal");
  if (job.status === "awaiting_reconciliation") {
    throw refuse("awaiting_reconciliation");
  }
  if (job.cancel_requested_at !== null) throw refuse("cancel_requested");
  if (
    BigInt(job.current_fence) !== BigInt(manifest.source_fence) ||
    BigInt(source.fence) !== BigInt(manifest.source_fence)
  ) throw refuse("fence_moved");
  const used = attempts.filter((attempt) => attempt.job_id === job.id).length;
  if (used >= job.max_attempts) throw refuse("attempt_budget_exhausted");

  const resumed = await decideManifestResume(transaction, {
    organizationId,
    runId: named.run_id,
    runStepId: named.run_step_id,
    manifestId: manifest.id,
    manifestDigest: manifest.digest,
    manifest: stored.data,
    sourceHostId: source.worker_host_id ?? "",
  });
  const effectsSettled = resumed.effectsSettled;
  const decision: ResumeDecision = value.mode === "fresh"
    ? { mode: "fresh_session", reason: "fresh_requested" }
    : resumed.decision;

  // 4. The writes: fence the source, requeue the job, mark the manifest.
  const lost = await transaction.query(
    `update bakery.job_attempts
        set status = 'lost', ended_at = clock_timestamp(),
            updated_at = clock_timestamp(), version = version + 1
      where organization_id = $1 and id = $2 and status = any($3::text[])`,
    [organizationId, source.id, LIVE_ATTEMPT_STATUSES],
  );
  if (lost.rowCount !== 1) throw refuse("source_not_live");
  const requeued = await transaction.query<{ version: number }>(
    `update bakery.jobs
        set status = case when $4::boolean then 'queued'
                          else 'awaiting_reconciliation' end,
            current_fence = current_fence + 1,
            current_checkpoints = $3::jsonb,
            available_at = clock_timestamp(),
            updated_at = clock_timestamp(), version = version + 1
      where organization_id = $1 and id = $2
        and status in ('leased', 'running')
      returning version`,
    [
      organizationId,
      job.id,
      // The harness matches this record before any model turn; a fresh
      // session starts from nothing.
      JSON.stringify(
        decision.mode === "exact_harness_resume" ? [decision.checkpoint] : [],
      ),
      effectsSettled,
    ],
  );
  if (requeued.rows.length !== 1) throw refuse("fence_moved");
  const newFence = BigInt(job.current_fence) + 1n;
  await transaction.query(
    `update bakery.handoff_manifests
        set status = 'continued', updated_at = clock_timestamp(),
            version = version + 1
      where organization_id = $1 and id = $2 and status = 'pending'`,
    [organizationId, manifest.id],
  );
  await transaction.query(
    `update bakery.workflow_runs
        set version = version + 1, updated_at = clock_timestamp()
      where organization_id = $1 and id = $2`,
    [organizationId, named.run_id],
  );

  const freshReason = decision.mode === "fresh_session"
    ? decision.reason
    : null;

  // One row records the continuation; the unique keys allow one per manifest
  // and one per fence step even if the locks above were wrong.
  let continuation: { id: string; created_at: Date | string };
  try {
    continuation = (await transaction.query<
      { id: string; created_at: Date | string }
    >(
      `insert into bakery.handoff_continuations (
         organization_id, manifest_id, run_id, run_step_id, job_id,
         source_attempt_id, previous_fence, new_fence, mode,
         admitted_by_principal_id, fresh_reason
       ) values ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint, $9, $10, $11)
       returning id, created_at`,
      [
        organizationId,
        manifest.id,
        named.run_id,
        named.run_step_id,
        job.id,
        source.id,
        job.current_fence,
        newFence.toString(),
        decision.mode,
        principalId,
        freshReason,
      ],
    )).rows[0]!;
  } catch (error) {
    if (postgresErrorCode(error) === POSTGRES_UNIQUE_VIOLATION) {
      throw refuse("already_continued");
    }
    throw error;
  }

  // 5. Audited and announced: who retired which attempt, and onto which fence.
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "handoffManifests.continue",
    resourceType: "handoff_continuation",
    resourceId: continuation.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      manifestId: manifest.id,
      runId: named.run_id,
      runStepId: named.run_step_id,
      jobId: job.id,
      sourceAttemptId: source.id,
      previousFence: job.current_fence,
      newFence: newFence.toString(),
      mode: decision.mode,
      jobStatus: effectsSettled ? "queued" : "awaiting_reconciliation",
      ...(freshReason === null ? {} : { reason: freshReason }),
    },
  });
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: null,
    repositoryId: null,
    eventType: "job.updated",
    aggregateId: job.id,
    aggregateVersion: requeued.rows[0].version,
    payload: {
      jobId: job.id,
      attemptId: source.id,
      version: requeued.rows[0].version,
    },
    traceId: context.traceId,
  });
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: null,
    repositoryId: null,
    eventType: "handoffContinuations.admitted",
    aggregateId: continuation.id,
    aggregateVersion: await nextAggregateVersion(
      transaction,
      organizationId,
      continuation.id,
      "handoffContinuations.admitted",
    ),
    payload: { resourceId: continuation.id, resourceVersion: run.version + 1 },
    traceId: context.traceId,
  });

  return {
    id: continuation.id,
    manifestId: manifest.id,
    runId: named.run_id,
    runStepId: named.run_step_id,
    jobId: job.id,
    sourceAttemptId: source.id,
    previousFence: job.current_fence,
    newFence: newFence.toString(),
    mode: decision.mode,
    freshReason,
    admittedAt: new Date(continuation.created_at).toISOString(),
  };
}
