import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";
import { BASE_SHA, HEAD_SHA, SHA256_A, SHA256_C } from "./observations.ts";

/** An organization member that owns the seeded run. */
export type RunScope = { organizationId: string; principalId: string };

export type SeededRun = {
  taskId: string;
  runId: string;
  stepId: string;
};

/**
 * Inserts the smallest task, workflow version, run and run step that
 * `bakery.check_runs` can hang off, through the owner role. Slugs and ids are
 * unique per call, so one organization can hold several runs.
 */
export async function seedRun(
  owner: PgDatabase,
  scope: RunScope,
): Promise<SeededRun> {
  const suffix = crypto.randomUUID();
  const ids = {
    applicationId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    workflowId: crypto.randomUUID(),
    workflowVersionId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    stepId: crypto.randomUUID(),
  };
  const now = new Date("2026-10-31T12:00:00.000Z");
  await owner.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1, $2, $3, $4)`,
    [ids.applicationId, scope.organizationId, `checks-${suffix}`, "Checks"],
  );
  await owner.query(
    `insert into bakery.conversations
       (id, organization_id, application_id, title, created_by)
     values ($1, $2, $3, $4, $5)`,
    [
      ids.conversationId,
      scope.organizationId,
      ids.applicationId,
      "Check evidence",
      scope.principalId,
    ],
  );
  await owner.query(
    `insert into bakery.tasks
       (id, organization_id, application_id, conversation_id, title,
        description, task_type, status, created_by)
     values ($1, $2, $3, $4, $5, $6, 'feature', 'draft', $7)`,
    [
      ids.taskId,
      scope.organizationId,
      ids.applicationId,
      ids.conversationId,
      "Check evidence",
      "Task that owns deterministic check rows.",
      scope.principalId,
    ],
  );
  await owner.query(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name)
     values ($1, $2, $3, $4)`,
    [ids.workflowId, scope.organizationId, `checks-${suffix}`, "Checks"],
  );
  await owner.query(
    `insert into bakery.workflow_versions
       (id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by)
     values ($1, $2, $3, 1, 'name: checks', $4::jsonb, $5, 'published', $6)`,
    [
      ids.workflowVersionId,
      scope.organizationId,
      ids.workflowId,
      JSON.stringify({ name: "checks" }),
      `checks-${suffix}`,
      scope.principalId,
    ],
  );
  await owner.query(
    `insert into bakery.workflow_runs
       (id, organization_id, task_id, workflow_version_id, requested_by,
        status, snapshot, budget_limit_usd, created_at, updated_at, version)
     values ($1, $2, $3, $4, $5, 'queued', $6::jsonb, 0, $7, $7, 1)`,
    [
      ids.runId,
      scope.organizationId,
      ids.taskId,
      ids.workflowVersionId,
      scope.principalId,
      JSON.stringify({ name: "checks" }),
      now,
    ],
  );
  await owner.query(
    `insert into bakery.run_steps
       (id, organization_id, run_id, step_key, position, iteration, status,
        input, created_at, updated_at, version)
     values ($1, $2, $3, 'check', 0, 0, 'pending', '{}'::jsonb, $4, $4, 1)`,
    [ids.stepId, scope.organizationId, ids.runId, now],
  );
  return { taskId: ids.taskId, runId: ids.runId, stepId: ids.stepId };
}

/** Columns of `bakery.check_runs`; omitted optional columns stay null. */
export type CheckRunInsert = {
  id?: string;
  organizationId: string;
  runId: string;
  runStepId?: string | null;
  jobId?: string | null;
  attemptId?: string | null;
  fence?: string | null;
  checkId?: string;
  kind?: string;
  ruleKey?: string | null;
  result?: string;
  reason?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  outputDigest?: string | null;
  evidenceVersionId?: string | null;
  headSha?: string;
  baseSha?: string | null;
  profileDigest?: string | null;
  policyDigest?: string;
  subjectDigest?: string;
  checkerDigest?: string | null;
  titleDigest?: string | null;
  bodyDigest?: string | null;
  mergeMessageDigest?: string | null;
  commitSelectionDigest?: string | null;
  createdAt?: Date;
};

/** Inserts one `check_runs` row through the owner role and returns its id. */
export async function insertCheckRun(
  owner: PgDatabase,
  row: CheckRunInsert,
): Promise<string> {
  const id = row.id ?? crypto.randomUUID();
  await owner.query(
    `insert into bakery.check_runs
       (id, organization_id, run_id, run_step_id, job_id, attempt_id, fence,
        check_id, kind, rule_key, result, reason, exit_code, duration_ms,
        output_digest, evidence_version_id, head_sha, base_sha, profile_digest,
        policy_digest, subject_digest, checker_digest, title_digest,
        body_digest, merge_message_digest, commit_selection_digest, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)`,
    [
      id,
      row.organizationId,
      row.runId,
      row.runStepId ?? null,
      row.jobId ?? null,
      row.attemptId ?? null,
      row.fence ?? null,
      row.checkId ?? "unit",
      row.kind ?? "command",
      row.ruleKey ?? null,
      row.result ?? "passed",
      row.reason ?? "verified",
      row.exitCode ?? null,
      row.durationMs ?? null,
      row.outputDigest ?? null,
      row.evidenceVersionId ?? null,
      row.headSha ?? HEAD_SHA,
      row.baseSha === undefined ? BASE_SHA : row.baseSha,
      row.profileDigest ?? null,
      row.policyDigest ?? SHA256_C,
      row.subjectDigest ?? SHA256_A,
      row.checkerDigest ?? null,
      row.titleDigest ?? null,
      row.bodyDigest ?? null,
      row.mergeMessageDigest ?? null,
      row.commitSelectionDigest ?? null,
      row.createdAt ?? new Date("2026-10-31T12:00:00.000Z"),
    ],
  );
  return id;
}
