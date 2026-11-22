import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { isStorableDecisionText } from "@bakery/contracts/human-approval";
import { requireCommandMetadata, StandardError } from "@bakery/contracts/http";
import {
  buildWorkflowPlan,
  WorkflowSemanticDocumentSchema,
} from "@bakery/contracts/workflow-compiler";
import {
  appendAudit,
  carriesPlanRuntime,
  type PgTransactionClient,
} from "@bakery/persistence";
import { appendDecision } from "../work/human-approval-store.ts";
import { DEFAULT_AGENT_SPAWN } from "@bakery/config";
import type { AgentSpawnConfig } from "@bakery/config";
import {
  admitAgentSteer,
  steerRecordDetail,
  stepIsReviewer,
} from "../work/agent-steer.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";

/**
 * Notes for a workflow step that has not started (chapter 25 section 9, #412).
 *
 * A started step has a live session and `sessions.steer` reaches it. A step that
 * has not started has no session, so a person leaves a note here and the agent
 * that runs the step receives it once, with its input. The note is recorded in
 * the work item's decisions ledger when it is written, like every steer, and it
 * is only ever text: it adds no tool, grant, skill or role.
 */

/** The most notes one admission hands a step, so its input stays bounded. */
export const MAX_NOTES_PER_STEP = 20;

type NoteRow = {
  id: string;
  run_id: string;
  step_key: string;
  author_id: string;
  body: string;
  client_note_id: string;
  created_at: Date;
};

const NOTE_COLUMNS =
  "id, run_id, step_key, author_id, body, client_note_id, created_at";

function toNote(row: NoteRow) {
  return {
    id: row.id,
    runId: row.run_id,
    stepKey: row.step_key,
    authorId: row.author_id,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * True when the run's compiled plan declares a step with exactly this key. Steps
 * inside a repeat carry an `@n` marker in their template and are not addressable
 * by a note before they exist.
 */
function planDeclaresStep(snapshot: unknown, stepKey: string): boolean {
  if (!carriesPlanRuntime(snapshot)) return false;
  const runtime = (snapshot as { runtime?: { document?: unknown } }).runtime;
  const document = WorkflowSemanticDocumentSchema.safeParse(runtime?.document);
  if (!document.success) return false;
  return buildWorkflowPlan(document.data).steps.some((step) =>
    step.keyTemplate === stepKey && !step.keyTemplate.includes("@")
  );
}

/** Leaves one note for a step that has not started. */
export async function createRunStepNote(
  context: ActionContext,
  rawInput: unknown,
  limits: AgentSpawnConfig = DEFAULT_AGENT_SPAWN,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const input = rawInput as z.output<typeof contractSchemas.RunStepNoteCreate>;
  // PostgreSQL rejects NUL and lone surrogates; refuse them as a 400 rather than
  // failing the insert as a 500.
  if (!isStorableDecisionText(input.body)) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const runId = context.params.id;
  const stepKey = context.params.stepKey;
  if (!runId || !stepKey) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const clientNoteId = input.clientNoteId ??
    requireCommandMetadata(context).idempotencyKey;

  // The run row, locked: admission locks it before it reads a step's notes, so a
  // note is either written before the step is admitted (and delivered with it)
  // or refused after (the step has started). It cannot fall between the two.
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

  // An agent steers only a run it spawned, only with the steer grant, never a
  // reviewer's step, and within a bound; a person passes untouched. Before any
  // read of the step or any write, so a refusal leaves no trace.
  const admission = await admitAgentSteer(transaction, context, {
    organizationId,
    principalId,
    targetRunId: runId,
    targetStepKey: stepKey,
    limits,
  });
  const steersReviewer = await stepIsReviewer(
    transaction,
    organizationId,
    runId,
    stepKey,
  );

  const step = await transaction.query<{ id: string; status: string }>(
    `select id, status from bakery.run_steps
      where organization_id = $1 and run_id = $2 and step_key = $3
      order by iteration desc
      limit 1`,
    [organizationId, runId, stepKey],
  );
  const stepRow = step.rows[0];
  // A compiled-plan run adds a step's row only when it dispatches the step, so
  // a step with no row yet is real when the run's plan declares it.
  if (!stepRow && !planDeclaresStep(runRow.snapshot, stepKey)) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const row = {
    id: stepRow?.id ?? null,
    status: stepRow?.status ?? "pending",
    task_id: runRow.task_id,
  };

  const replay = await transaction.query<NoteRow>(
    `select ${NOTE_COLUMNS} from bakery.run_step_notes
      where organization_id = $1 and run_id = $2
        and author_id = $3 and client_note_id = $4`,
    [organizationId, runId, principalId, clientNoteId],
  );
  const existing = replay.rows[0];
  if (existing) {
    if (existing.body !== input.body || existing.step_key !== stepKey) {
      throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    }
    return toNote(existing);
  }
  if (row.status !== "pending") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "step_started" },
    });
  }

  const inserted = await transaction.query<NoteRow>(
    `insert into bakery.run_step_notes
       (organization_id, run_id, step_key, author_id, body, client_note_id)
     values ($1, $2, $3, $4, $5, $6)
     returning ${NOTE_COLUMNS}`,
    [organizationId, runId, stepKey, principalId, input.body, clientNoteId],
  );
  const note = inserted.rows[0];
  if (!note) throw new Error("RUN_STEP_NOTE_INSERT_FAILED");

  // Recorded in the decisions ledger before it can be delivered, in the same
  // transaction. The body is at most the ledger's note limit, so it is kept whole.
  await appendDecision(transaction, {
    organizationId,
    taskId: row.task_id,
    runId,
    kind: "steer",
    subjectKind: row.id === null ? "run" : "step",
    subjectId: row.id ?? runId,
    decidedBy: principalId,
    text: input.body,
    detail: {
      mode: "note",
      noteId: note.id,
      stepKey,
      ...steerRecordDetail(principalId, admission, steersReviewer),
    },
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "runSteps.note",
    // An agent's note names its session (O50); the admission found it.
    agentSessionId: admission?.sessionId ?? null,
    resourceType: row.id === null ? "workflow_run" : "run_step",
    resourceId: row.id ?? runId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      noteId: note.id,
      stepKey,
      ...steerRecordDetail(principalId, admission, steersReviewer),
    },
  });
  return toNote(note);
}

/**
 * The notes a step has not yet been handed, oldest first, bounded.
 *
 * Reading does not consume: the caller marks them delivered with
 * `recordNotesDelivered` once the job that carries them exists.
 */
export async function undeliveredStepNotes(
  transaction: PgTransactionClient,
  input: { organizationId: string; runId: string; stepKey: string },
): Promise<{ id: string; body: string }[]> {
  const result = await transaction.query<{ id: string; body: string }>(
    `select note.id, note.body
       from bakery.run_step_notes note
      where note.organization_id = $1 and note.run_id = $2
        and note.step_key = $3
        and not exists (
          select 1 from bakery.run_step_note_deliveries delivery
           where delivery.organization_id = note.organization_id
             and delivery.note_id = note.id)
      order by note.created_at, note.id
      limit ${MAX_NOTES_PER_STEP}`,
    [input.organizationId, input.runId, input.stepKey],
  );
  return result.rows;
}

/**
 * Marks notes as handed to a job. `on conflict do nothing` on the unique note
 * id is what keeps a note from being delivered twice if two admissions race.
 */
export async function recordNotesDelivered(
  transaction: PgTransactionClient,
  input: { organizationId: string; jobId: string; noteIds: string[] },
): Promise<void> {
  for (const noteId of input.noteIds) {
    await transaction.query(
      `insert into bakery.run_step_note_deliveries
         (organization_id, note_id, job_id)
       values ($1, $2, $3)
       on conflict (organization_id, note_id) do nothing`,
      [input.organizationId, noteId, input.jobId],
    );
  }
}
