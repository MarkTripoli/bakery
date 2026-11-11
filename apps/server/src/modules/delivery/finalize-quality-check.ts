import { StandardError } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence/event-audit";
import { assertArtifactReference } from "@bakery/persistence/event-journal";
import type { PgTransactionClient } from "../../platform/database.ts";
import type {
  AttemptRow,
  RequestMetadata,
  WorkerIdentity,
} from "../execution/shared.ts";
import { type CheckPins, deriveCheckPins } from "./check-pins.ts";
import {
  CHECK_EVIDENCE_INVALID_REASON,
  CHECK_OUTPUT_MISMATCH_REASON,
  type CheckReport,
  parseCheckReport,
  verifyCheckReport,
} from "./check-report.ts";

/** Audit operation recorded once for every accepted `quality.check` report. */
export const CHECK_RUNS_RECORD_OPERATION = "delivery.checkRuns.record";

type FinalizeInput = {
  readonly attempt: AttemptRow;
  readonly identity: WorkerIdentity;
  readonly jobId: string;
  readonly resultPayload: unknown;
  readonly metadata: RequestMetadata;
};

type CheckJob = {
  readonly input: unknown;
  readonly runId: string;
  readonly runStepId: string;
  readonly taskId: string;
};

type JobRow = {
  action: string;
  input: unknown;
  run_id: string;
  run_step_id: string;
  task_id: string;
};

/**
 * Reads the job the attempt belongs to, with the run, step and task that own
 * it, under an explicit organization predicate. The job input is the one
 * admission wrote and the claim re-verified; nothing here trusts the report.
 */
async function loadCheckJob(
  transaction: PgTransactionClient,
  organizationId: string,
  jobId: string,
): Promise<CheckJob> {
  const result = await transaction.query<JobRow>(
    `select job.action, job.input, step.id as run_step_id,
            run.id as run_id, run.task_id
       from bakery.jobs job
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
       join bakery.workflow_runs run
         on run.organization_id = step.organization_id
        and run.id = step.run_id
      where job.organization_id = $1 and job.id = $2`,
    [organizationId, jobId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.action !== "quality.check") {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  return {
    input: row.input,
    runId: row.run_id,
    runStepId: row.run_step_id,
    taskId: row.task_id,
  };
}

/**
 * Milliseconds the attempt has existed on the database clock. Commands run one
 * after the other inside that window, so reported durations cannot exceed it.
 */
async function attemptWindowMs(
  transaction: PgTransactionClient,
  organizationId: string,
  attemptId: string,
): Promise<number> {
  const result = await transaction.query<{ elapsed_ms: string | number }>(
    `select ceil(extract(epoch from (clock_timestamp() - created_at)) * 1000)
              ::bigint as elapsed_ms
       from bakery.job_attempts
      where organization_id = $1 and id = $2`,
    [organizationId, attemptId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return Number(row.elapsed_ms);
}

/**
 * Proves each evidence reference is an artifact version of the reporting step.
 * The generic result-reference path never looks inside `observations`, so the
 * references are checked here with the same predicate it uses for
 * `result.artifacts`: the version belongs to the job's run step, its artifact
 * to the job's task, the digest matches and the content is present and not
 * purged. The predicate locks the version, so retention cannot purge it before
 * this transaction commits.
 */
async function assertEvidenceReferences(
  transaction: PgTransactionClient,
  scope: { organizationId: string; taskId: string; runStepId: string },
  report: CheckReport,
): Promise<void> {
  for (const { evidence } of report.observations) {
    if (evidence === null) {
      throw new StandardError({
        code: "VALIDATION_FAILED",
        params: { reason: CHECK_EVIDENCE_INVALID_REASON },
      });
    }
    try {
      await assertArtifactReference(
        transaction,
        scope.organizationId,
        scope.taskId,
        scope.runStepId,
        evidence.versionId,
        evidence.sha256,
        evidence.artifactId,
      );
    } catch (error) {
      if (
        error instanceof StandardError && error.code === "RESOURCE_NOT_FOUND"
      ) {
        throw new StandardError({
          code: "VALIDATION_FAILED",
          params: { reason: CHECK_EVIDENCE_INVALID_REASON },
        });
      }
      throw error;
    }
  }
}

/**
 * Writes one `check_runs` row per observation. Every identity comes from the
 * pins; the report contributes only what a process can have observed (result,
 * reason, exit code, duration, output digest, evidence) and the row id it
 * generated. A repeated id, or a second row for the same check of the same job
 * and fence, hits a unique index and makes the whole report fail.
 */
async function insertCheckRuns(
  transaction: PgTransactionClient,
  input: {
    readonly attempt: AttemptRow;
    readonly job: CheckJob;
    readonly pins: CheckPins;
    readonly report: CheckReport;
  },
): Promise<void> {
  const { attempt, job, pins, report } = input;
  for (const [index, observation] of report.observations.entries()) {
    const pin = pins.commands[index]!;
    const inserted = await transaction.query<{ id: string }>(
      `insert into bakery.check_runs (
         id, organization_id, run_id, run_step_id, job_id, attempt_id, fence,
         check_id, kind, rule_key, result, reason, exit_code, duration_ms,
         output_digest, evidence_version_id, head_sha, base_sha,
         profile_digest, policy_digest, subject_digest, checker_digest
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20, $21, $22
       ) on conflict do nothing returning id`,
      [
        observation.checkRunId,
        attempt.organization_id,
        job.runId,
        job.runStepId,
        attempt.job_id,
        attempt.id,
        String(attempt.fence),
        pin.checkId,
        "command",
        pin.ruleKey,
        observation.result,
        observation.reason,
        observation.exitCode,
        observation.durationMs,
        observation.outputDigest,
        observation.evidence?.versionId ?? null,
        pins.headSha,
        pins.baseSha,
        pins.profileDigest,
        pins.policyDigest,
        pin.subjectDigest,
        pins.checkerDigest,
      ],
    );
    // A conflict is a replayed row id or a repeated (job, fence, check id):
    // refused like any other report the server cannot reconcile.
    if (inserted.rows.length !== 1) {
      throw new StandardError({
        code: "VALIDATION_FAILED",
        params: { reason: CHECK_OUTPUT_MISMATCH_REASON },
      });
    }
  }
}

/**
 * Verifies a worker's `quality.check` report inside the result transaction and
 * records it. Called for a completed result after the schema parse and before
 * the generic reference validation, which then finds the rows. Every failure
 * throws `VALIDATION_FAILED` and writes nothing that survives it, so a rejected
 * report leaves no row and no step output behind:
 *
 * - `check_policy_missing`: the job has no profile with a usable fixed policy;
 * - `check_output_mismatch`: the report differs from what the pins derive;
 * - `check_evidence_invalid`: an evidence reference is not the step's own.
 *
 * The result route calls `finalizeOrDenyQualityCheck`, which also records the
 * refusal for an operator. A replayed result returns before this hook, so rows
 * are written once.
 */
export async function finalizeQualityCheck(
  transaction: PgTransactionClient,
  input: FinalizeInput,
): Promise<void> {
  const { attempt, identity, jobId, metadata } = input;
  const job = await loadCheckJob(transaction, attempt.organization_id, jobId);
  const pins = await deriveCheckPins(job.input);
  const report = parseCheckReport(input.resultPayload);
  verifyCheckReport(
    report,
    pins,
    await attemptWindowMs(transaction, attempt.organization_id, attempt.id),
  );
  await assertEvidenceReferences(transaction, {
    organizationId: attempt.organization_id,
    taskId: job.taskId,
    runStepId: job.runStepId,
  }, report);
  await insertCheckRuns(transaction, { attempt, job, pins, report });
  const audited = await appendAudit(transaction, {
    organizationId: attempt.organization_id,
    principalId: identity.host.principal_id,
    operation: CHECK_RUNS_RECORD_OPERATION,
    resourceType: "job_attempt",
    resourceId: attempt.id,
    requestId: metadata.requestId,
    traceId: metadata.traceId,
    details: {
      jobId,
      runId: job.runId,
      runStepId: job.runStepId,
      fence: String(attempt.fence),
      headSha: pins.headSha,
      baseSha: pins.baseSha,
      policyDigest: pins.policyDigest,
      allRequired: report.allRequired,
      checkRunIds: report.checkRunIds,
    },
  });
  if (audited !== 1) throw new Error("CHECK_RUNS_AUDIT_INSERT_FAILED");
}

const CHECK_RESULT_SAVEPOINT = "quality_check_result";

/**
 * Runs `finalizeQualityCheck` so a refused report stays visible to an
 * operator. The finalizer runs inside a savepoint. When it refuses with a
 * `StandardError`, everything it wrote rolls back to the savepoint (no row, no
 * step output) and one `delivery.checkRuns.record` audit entry with outcome
 * `denied` is appended. Its details are the problem code and the refusal
 * reason (`check_output_mismatch`, `check_evidence_invalid` or
 * `check_policy_missing`), fixed strings of this module and never anything the
 * worker sent.
 *
 * The refusal is returned, not thrown, so the caller can return it and let the
 * transaction commit that entry. The job, attempt and step stay as they were
 * because the finalizer runs before any of them is written. The HTTP problem
 * keeps its status and code and the reason still never reaches the worker; its
 * request and trace ids are the ones the audit entry carries. Any other error
 * is rethrown and rolls the whole transaction back.
 */
export async function finalizeOrDenyQualityCheck(
  transaction: PgTransactionClient,
  input: FinalizeInput,
): Promise<StandardError | null> {
  await transaction.query(`savepoint ${CHECK_RESULT_SAVEPOINT}`);
  try {
    await finalizeQualityCheck(transaction, input);
    await transaction.query(`release savepoint ${CHECK_RESULT_SAVEPOINT}`);
    return null;
  } catch (error) {
    if (!(error instanceof StandardError)) throw error;
    await transaction.query(`rollback to savepoint ${CHECK_RESULT_SAVEPOINT}`);
    const reason = error.params?.reason;
    const inserted = await appendAudit(transaction, {
      organizationId: input.attempt.organization_id,
      principalId: input.identity.host.principal_id,
      operation: CHECK_RUNS_RECORD_OPERATION,
      resourceType: "job_attempt",
      resourceId: input.attempt.id,
      requestId: input.metadata.requestId,
      traceId: input.metadata.traceId,
      outcome: "denied",
      details: {
        code: error.code,
        reason: typeof reason === "string" ? reason : null,
      },
    });
    if (inserted !== 1) {
      throw new Error("CHECK_RUNS_DENIAL_AUDIT_INSERT_FAILED");
    }
    return error;
  }
}
