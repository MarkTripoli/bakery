import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import { isStorableDecisionText } from "@bakery/contracts/human-approval";
import {
  WORKFLOW_ACTION_METADATA,
  type WorkflowActionName,
} from "@bakery/contracts/workflow-action-registry";
import {
  appendAudit,
  appendDomainEvent,
  carriesPlanRuntime,
} from "@bakery/persistence";
import { executionJobInputFitsTransport } from "@bakery/persistence/repository-admission";
import { releaseCanceledUnclaimedJobReservation } from "../work/budget.ts";
import { appendDecision } from "../work/human-approval-store.ts";
import { MAX_NOTES_PER_STEP } from "./step-notes.ts";
import {
  RUN_STEP_COLUMNS,
  type RunStepRow,
  toRunStep,
} from "../work/run-query.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";

/**
 * A person takes over one workflow step as its completer (chapter 25 section 9,
 * O20, #412 slice 3a).
 *
 * The rules, and why:
 * - The result is an artifact the person names, never free JSON. Most step
 *   outputs carry evidence (a check, a review, a candidate, a merge) that only
 *   the system may attest, so a person cannot type one in. The artifact must
 *   belong to the run's task, and its digest is read from the server's own
 *   row.
 * - Only a step whose job is still queued with no live attempt. A live attempt
 *   ends through its worker's fenced result, which settles the job and its
 *   budget in the same transaction; the person stops it first with run control.
 * - Only compiled-plan runs: they leave run completion to the engine, which
 *   wakes on the `job.completed` event this writes.
 */

const LIVE_JOB_STATUSES = [
  "leased",
  "running",
  "awaiting_reconciliation",
  "canceling",
];

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

type TakeOverInput = z.output<typeof contractSchemas.RunStepTakeOver>;

export async function takeOverRunStep(
  context: ActionContext,
  rawInput: unknown,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const input = rawInput as TakeOverInput;
  const runId = context.params.id;
  const stepKey = context.params.stepKey;
  if (!runId || !stepKey) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }

  // Run first, then step, then job: the order the engine and the result path
  // lock them in.
  const run = await transaction.query<
    { task_id: string; status: string; snapshot: unknown }
  >(
    `select task_id, status, snapshot from bakery.workflow_runs
      where organization_id = $1 and id = $2
        for update`,
    [organizationId, runId],
  );
  const runRow = run.rows[0];
  if (!runRow) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (!["queued", "running"].includes(runRow.status)) {
    conflict("run_not_active");
  }
  if (!carriesPlanRuntime(runRow.snapshot)) conflict("plan_runs_only");

  const step = await transaction.query<RunStepRow>(
    `select ${RUN_STEP_COLUMNS} from bakery.run_steps
      where organization_id = $1 and run_id = $2 and step_key = $3
      order by iteration desc
      limit 1
        for update`,
    [organizationId, runId, stepKey],
  );
  const stepRow = step.rows[0];
  if (!stepRow) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (!["pending", "running", "waiting"].includes(stepRow.status)) {
    conflict("step_finished");
  }

  const job = await transaction.query<{
    id: string;
    action: string;
    status: string;
    version: number;
    input: Record<string, unknown>;
    billing: unknown;
    max_attempts: number;
    installation_reservation_id: string | null;
  }>(
    `select id, action, status, version, input, billing, max_attempts,
            installation_reservation_id
       from bakery.jobs
      where organization_id = $1 and run_step_id = $2
        for update`,
    [organizationId, stepRow.id],
  );
  const jobRow = job.rows[0];
  if (!jobRow) conflict("no_worker_job");
  const attempts = await transaction.query<{ id: string; status: string }>(
    `select id, status from bakery.job_attempts
      where organization_id = $1 and job_id = $2
      order by attempt_no desc`,
    [organizationId, jobRow.id],
  );
  if (
    LIVE_JOB_STATUSES.includes(jobRow.status) ||
    attempts.rows.some((attempt) =>
      ["leased", "running", "canceling"].includes(attempt.status)
    )
  ) conflict("attempt_live");
  if (jobRow.status !== "queued") conflict("job_not_queued");
  // A job with finished attempts may have spent against its reservation, which
  // usage reconciliation settles. Cancelling it here would leave that money
  // held, and releasing it could miss what was spent, so the takeover waits for
  // reconciliation instead.
  if (attempts.rows.length > 0 && jobRow.installation_reservation_id !== null) {
    const reservation = await transaction.query<{ status: string }>(
      `select status from bakery.budget_reservations
        where organization_id = $1 and id = $2`,
      [organizationId, jobRow.installation_reservation_id],
    );
    if (reservation.rows[0]?.status === "held") conflict("budget_unsettled");
  }

  if (input.mode === "restart") {
    return await restartStep(context, {
      input,
      organizationId,
      principalId,
      runId,
      stepKey,
      taskId: runRow.task_id,
      step: stepRow,
      job: jobRow,
    });
  }
  if (!input.artifactId || !input.versionId) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }

  const metadata = Object.hasOwn(WORKFLOW_ACTION_METADATA, jobRow.action)
    ? WORKFLOW_ACTION_METADATA[jobRow.action as WorkflowActionName]
    : undefined;
  if (metadata?.output !== "ArtifactOutput") {
    conflict("takeover_unsupported_action");
  }

  // The digest comes from the server's own row, and the artifact must belong to
  // the run's task, so a person cannot point a step at another task's content.
  const artifact = await transaction.query<{ sha256: string }>(
    `select sha256 from bakery.artifact_versions
      where organization_id = $1 and artifact_id = $2 and id = $3
        and task_id = $4`,
    [organizationId, input.artifactId, input.versionId, runRow.task_id],
  );
  const version = artifact.rows[0];
  if (!version) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const output = {
    artifact: {
      artifactId: input.artifactId,
      versionId: input.versionId,
      sha256: version.sha256,
    },
  };

  const canceled = await transaction.query<{ version: number }>(
    `update bakery.jobs
        set status = 'canceled',
            cancel_requested_at = coalesce(
              cancel_requested_at, current_timestamp
            ),
            current_fence = current_fence + 1,
            updated_at = current_timestamp, version = version + 1
      where organization_id = $1 and id = $2 and status = 'queued'
      returning version`,
    [organizationId, jobRow.id],
  );
  const jobVersion = canceled.rows[0]?.version;
  if (jobVersion === undefined) conflict("job_not_queued");
  // The job will never run, so the money held for it goes back in this same
  // transaction.
  await releaseCanceledUnclaimedJobReservation(transaction, {
    organizationId,
    jobId: jobRow.id,
    onUnreleasable: "throw",
  });

  const settled = await transaction.query<RunStepRow>(
    `update bakery.run_steps
        set status = 'completed', output = $3::jsonb, error = null,
            started_at = coalesce(started_at, current_timestamp),
            finished_at = current_timestamp, updated_at = current_timestamp,
            version = version + 1
      where organization_id = $1 and id = $2
        and status in ('pending', 'running', 'waiting')
      returning ${RUN_STEP_COLUMNS}`,
    [organizationId, stepRow.id, JSON.stringify(output)],
  );
  const completed = settled.rows[0];
  if (!completed) conflict("step_finished");

  // A run that has not left `queued` is now running, as when a worker's first
  // result lands. The engine decides everything else from the step rows.
  await transaction.query(
    `update bakery.workflow_runs
        set status = case when status = 'queued' then 'running' else status end,
            started_at = coalesce(started_at, current_timestamp),
            updated_at = current_timestamp, version = version + 1
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );

  await appendDecision(transaction, {
    organizationId,
    taskId: runRow.task_id,
    runId,
    kind: "takeover",
    subjectKind: "step",
    subjectId: stepRow.id,
    decidedBy: principalId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    detail: {
      mode: input.mode,
      stepKey,
      jobId: jobRow.id,
      artifactId: input.artifactId,
      versionId: input.versionId,
    },
  });

  // The engine waits on this event for the job it admitted. The job had no live
  // attempt, so the last finished attempt (a retry waiting) names it, or none.
  const scope = await transaction.query<
    {
      application_id: string;
      repository_id: string | null;
      conversation_id: string;
    }
  >(
    `select application_id, repository_id, conversation_id
       from bakery.tasks where organization_id = $1 and id = $2`,
    [organizationId, runRow.task_id],
  );
  const taskScope = scope.rows[0];
  if (!taskScope) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  await appendDomainEvent(transaction, {
    organizationId,
    eventType: "job.completed",
    aggregateId: jobRow.id,
    aggregateVersion: jobVersion,
    applicationId: taskScope.application_id,
    repositoryId: taskScope.repository_id,
    taskId: runRow.task_id,
    conversationId: taskScope.conversation_id,
    payload: {
      runId,
      stepId: stepRow.id,
      jobId: jobRow.id,
      attemptId: attempts.rows[0]?.id ?? null,
      status: "completed",
    },
    traceId: context.traceId,
    outboxDeliveryKey: `job:${jobRow.id}:takeover:completed`,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "runSteps.takeOver",
    resourceType: "run_step",
    resourceId: stepRow.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { stepKey, jobId: jobRow.id, mode: input.mode },
  });
  return toRunStep(completed);
}

/**
 * Restarts a step: its queued job gets one more attempt that starts fresh, and
 * the person's note travels with it.
 *
 * The agent stays the step's frozen agent. A job's agent, config and skills must
 * equal what the run's snapshot froze for the step, so a person cannot swap one
 * in; "fresh" means the next attempt resumes from no checkpoint. The same
 * frozen agent keeps its billing, so the job's budget reservation still covers
 * it; if that reservation is no longer held the restart is refused by name
 * rather than run unfunded.
 */
async function restartStep(
  context: ActionContext,
  args: {
    input: TakeOverInput;
    organizationId: string;
    principalId: string;
    runId: string;
    stepKey: string;
    taskId: string;
    step: RunStepRow;
    job: {
      id: string;
      version: number;
      input: Record<string, unknown>;
      billing: unknown;
      max_attempts: number;
      installation_reservation_id: string | null;
    };
  },
) {
  const { input, organizationId, principalId, runId, stepKey, step, job } =
    args;
  const { transaction } = requireWorkTransaction(context);
  if (input.note !== undefined && !isStorableDecisionText(input.note)) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }

  // A model action holds a reservation for the step's agent; an extra attempt
  // is funded only while that reservation is still held.
  if (job.billing !== null) {
    const held = job.installation_reservation_id === null
      ? undefined
      : (await transaction.query<{ status: string }>(
        `select status from bakery.budget_reservations
          where organization_id = $1 and id = $2`,
        [organizationId, job.installation_reservation_id],
      )).rows[0];
    if (held?.status !== "held") conflict("budget_not_reserved");
  }

  let noteId: string | undefined;
  let jobInput = job.input;
  if (input.note !== undefined) {
    const existing = Array.isArray(job.input.stepNotes)
      ? job.input.stepNotes as string[]
      : [];
    if (existing.length >= MAX_NOTES_PER_STEP) conflict("too_many_notes");
    jobInput = { ...job.input, stepNotes: [...existing, input.note] };
    if (!executionJobInputFitsTransport(jobInput)) {
      conflict("job_input_too_large");
    }
    // The same two records a note left before the step started writes, so the
    // job's notes still equal its recorded deliveries (#679).
    // Stamped now, not at transaction start: this runs after the job row is
    // locked, so two simultaneous restarts get stamps in lock order, which is
    // the order each appends to `stepNotes`. The integrity check reads the
    // deliveries back by this stamp, so the two orders must agree.
    const inserted = await transaction.query<{ id: string }>(
      `insert into bakery.run_step_notes
         (organization_id, run_id, step_key, author_id, body, client_note_id,
          created_at)
       values ($1, $2, $3, $4, $5, $6, clock_timestamp())
       returning id`,
      [
        organizationId,
        runId,
        stepKey,
        principalId,
        input.note,
        requireCommandMetadata(context).idempotencyKey,
      ],
    );
    noteId = inserted.rows[0]!.id;
    await transaction.query(
      `insert into bakery.run_step_note_deliveries
         (organization_id, note_id, job_id, delivered_at)
       values ($1, $2, $3, clock_timestamp())`,
      [organizationId, noteId, job.id],
    );
  }

  const restarted = await transaction.query<{ max_attempts: number }>(
    `update bakery.jobs
        set max_attempts = max_attempts + 1,
            current_checkpoints = '[]'::jsonb,
            input = $3::jsonb,
            available_at = current_timestamp,
            updated_at = current_timestamp, version = version + 1
      where organization_id = $1 and id = $2 and status = 'queued'
      returning max_attempts`,
    [organizationId, job.id, JSON.stringify(jobInput)],
  );
  const maxAttempts = restarted.rows[0]?.max_attempts;
  if (maxAttempts === undefined) conflict("job_not_queued");

  await appendDecision(transaction, {
    organizationId,
    taskId: args.taskId,
    runId,
    kind: "takeover",
    subjectKind: "step",
    subjectId: step.id,
    decidedBy: principalId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.note === undefined ? {} : { text: input.note }),
    detail: {
      mode: "restart",
      stepKey,
      jobId: job.id,
      maxAttempts,
      ...(noteId === undefined ? {} : { noteId }),
    },
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "runSteps.takeOver",
    resourceType: "run_step",
    resourceId: step.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { stepKey, jobId: job.id, mode: "restart", maxAttempts },
  });
  return toRunStep(step);
}
