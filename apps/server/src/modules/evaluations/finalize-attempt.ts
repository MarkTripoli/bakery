/**
 * Records a completed `evaluation.check` / `evaluation.score` worker attempt
 * as one evaluation attempt (issue #44 slice 2). The worker's report is a
 * claim: it is re-validated against the action's output contract, and a judge
 * answer against the caller's own output schema, before it counts as a
 * measurement. Anything that does not validate is recorded as `unscored`
 * with the reason, never as a pass or a fail.
 */

import {
  registeredWorkerActionInputSchema,
  workerActionOutputSchema,
} from "@bakery/contracts/contracts";
import {
  jsonSchemaViolationText,
  validateJsonSchemaSubset,
} from "@bakery/contracts/evaluation-scoring";
import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import { type AttemptRecord, recordAttempt } from "./store.ts";

export const EVALUATION_ACTIONS = Object.freeze(
  ["evaluation.check", "evaluation.score"] as const,
);
export type EvaluationAction = typeof EVALUATION_ACTIONS[number];

export function isEvaluationAction(action: string): action is EvaluationAction {
  return (EVALUATION_ACTIONS as readonly string[]).includes(action);
}

/** The attempt fields a verdict decides; the rest come from the attempt row. */
export type EvaluationOutcome = Readonly<
  Pick<AttemptRecord, "state" | "reason" | "score">
>;

type EvaluationJobInput = Readonly<{
  evaluationResultId: string;
  outputArtifactVersionId: string;
  outputSchema?: unknown;
}>;

function unscored(reason: string): EvaluationOutcome {
  return { state: "unscored", score: null, reason };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decides what one worker report records, failing closed to `unscored`.
 * Pure, so the decision is testable without a database.
 */
export function normalizeEvaluationOutcome(
  action: EvaluationAction,
  payload: unknown,
  input: EvaluationJobInput,
): EvaluationOutcome {
  const parsed = workerActionOutputSchema(action).safeParse(payload);
  if (!parsed.success || !record(parsed.data)) {
    return unscored(`the worker report does not match the ${action} output`);
  }
  const report = parsed.data as {
    state: "passed" | "failed" | "unscored" | "error";
    score: number | null;
    reason: string | null;
    judgeOutput?: unknown;
  };
  const measured = report.state === "passed" || report.state === "failed";
  if (!measured) {
    const fallback = report.state === "error"
      ? "the scorer reported an error without a reason"
      : "the scorer reported no measurement without a reason";
    return {
      state: report.state,
      score: null,
      reason: report.reason?.trim() ? report.reason : fallback,
    };
  }
  if (report.score === null || report.score < 0 || report.score > 1) {
    return unscored("the scorer reported a measurement without a 0..1 score");
  }
  if (action === "evaluation.score") {
    if (report.judgeOutput === null || report.judgeOutput === undefined) {
      return unscored("the judge gave no structured answer");
    }
    const verdict = validateJsonSchemaSubset(
      input.outputSchema,
      report.judgeOutput,
    );
    if (!verdict.ok) {
      return unscored(
        `the judge answer does not match the output schema: ${
          jsonSchemaViolationText(verdict.violations)
        }`,
      );
    }
  }
  return { state: report.state, score: report.score, reason: report.reason };
}

type JobRow = { action: string; input: unknown; started_at: Date | null };

/**
 * Re-reads the job input and the attempt start under an explicit organization
 * predicate, normalizes the report and records it. The worker attempt id is
 * the delivery key, so a duplicate delivery of the same attempt is a no-op.
 */
export async function finalizeEvaluationAttempt(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    attemptId: string;
    jobId: string;
    action: EvaluationAction;
    resultPayload: unknown;
  }>,
): Promise<"recorded" | "duplicate" | "canceled"> {
  const loaded = await transaction.query<JobRow>(
    `select job.action, job.input, attempt.started_at
       from bakery.jobs job
       join bakery.job_attempts attempt
         on attempt.organization_id = job.organization_id
        and attempt.job_id = job.id
      where job.organization_id = $1 and job.id = $2 and attempt.id = $3`,
    [options.organizationId, options.jobId, options.attemptId],
  );
  const row = loaded.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.action !== options.action) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const rawInput = record(row.input) ? { ...row.input } : row.input;
  if (record(rawInput)) delete rawInput.repositoryProfile;
  const input = registeredWorkerActionInputSchema(options.action).safeParse(
    rawInput,
  );
  if (!input.success) throw new StandardError({ code: "STATE_CONFLICT" });
  const jobInput = input.data as EvaluationJobInput;
  const outcome = normalizeEvaluationOutcome(
    options.action,
    options.resultPayload,
    jobInput,
  );
  return await recordAttempt(
    transaction,
    options.organizationId,
    jobInput.evaluationResultId,
    {
      ...outcome,
      deliveryKey: options.attemptId,
      startedAt: row.started_at,
      endedAt: new Date(),
      traceRef: options.attemptId,
      outputArtifactVersionId: jobInput.outputArtifactVersionId,
    },
  );
}
