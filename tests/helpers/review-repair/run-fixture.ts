import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";
import {
  BASE_SHA,
  HEAD_SHA,
  SHA256_C,
} from "../deterministic-checks/observations.ts";
import {
  type RunScope,
  type SeededRun,
  seedRun,
} from "../deterministic-checks/run-fixture.ts";
import { fingerprintOf } from "./fixtures.ts";

/** A seeded run with the two agent sessions a review cycle names. */
export type ReviewRun = SeededRun & {
  organizationId: string;
  implementerSessionId: string;
  reviewerSessionId: string;
  implementStepId: string;
  reviewStepId: string;
};

async function insertStep(
  owner: PgDatabase,
  scope: RunScope,
  runId: string,
  stepKey: string,
  position: number,
): Promise<string> {
  const stepId = crypto.randomUUID();
  await owner.query(
    `insert into bakery.run_steps
       (id, organization_id, run_id, step_key, position, iteration, status,
        input, created_at, updated_at, version)
     values ($1, $2, $3, $4, $5, 0, 'pending', '{}'::jsonb, now(), now(), 1)`,
    [stepId, scope.organizationId, runId, stepKey, position],
  );
  return stepId;
}

async function insertSession(
  owner: PgDatabase,
  scope: RunScope,
  conversationId: string,
  runStepId: string,
): Promise<string> {
  const sessionId = crypto.randomUUID();
  await owner.query(
    `insert into bakery.agent_sessions
       (id, organization_id, run_step_id, conversation_id, agent_version_id,
        harness, status)
     values ($1, $2, $3, $4, $5, 'codex', 'starting')`,
    [
      sessionId,
      scope.organizationId,
      runStepId,
      conversationId,
      crypto.randomUUID(),
    ],
  );
  return sessionId;
}

/**
 * Seeds a run (task, workflow version, run, one step) and adds an implement
 * step and a review step, each with its own agent session, through the owner
 * role. Everything a `review_cycles` row references then exists.
 */
export async function seedReviewRun(
  owner: PgDatabase,
  scope: RunScope,
): Promise<ReviewRun> {
  const run = await seedRun(owner, scope);
  const task = await owner.query<{ conversation_id: string }>(
    "select conversation_id from bakery.tasks where id = $1",
    [run.taskId],
  );
  const conversationId = task.rows[0].conversation_id;
  const implementStepId = await insertStep(
    owner,
    scope,
    run.runId,
    "implement",
    1,
  );
  const reviewStepId = await insertStep(owner, scope, run.runId, "review", 2);
  return {
    ...run,
    organizationId: scope.organizationId,
    implementStepId,
    reviewStepId,
    implementerSessionId: await insertSession(
      owner,
      scope,
      conversationId,
      implementStepId,
    ),
    reviewerSessionId: await insertSession(
      owner,
      scope,
      conversationId,
      reviewStepId,
    ),
  };
}

/** Columns of `bakery.review_cycles`; omitted columns take a plausible value. */
export type ReviewCycleInsert = {
  id?: string;
  organizationId: string;
  runId: string;
  runStepId: string;
  jobId?: string | null;
  attemptId?: string | null;
  fence?: string | null;
  ordinal?: number;
  reviewerSessionId: string;
  reviewerPrincipalId?: string;
  implementerSessionId: string;
  implementerPrincipalId?: string;
  headSha?: string;
  baseSha?: string;
  policyDigest?: string;
  status?: string;
  findingCount?: number;
  blockingCount?: number;
  createdAt?: Date;
};

/** Inserts one `review_cycles` row and returns its id. */
export async function insertReviewCycle(
  database: PgDatabase,
  row: ReviewCycleInsert,
): Promise<string> {
  const id = row.id ?? crypto.randomUUID();
  await database.query(
    `insert into bakery.review_cycles
       (id, organization_id, run_id, run_step_id, job_id, attempt_id, fence,
        ordinal, reviewer_session_id, reviewer_principal_id,
        implementer_session_id, implementer_principal_id, head_sha, base_sha,
        policy_digest, status, finding_count, blocking_count, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19)`,
    [
      id,
      row.organizationId,
      row.runId,
      row.runStepId,
      row.jobId ?? null,
      row.attemptId ?? null,
      row.fence ?? null,
      row.ordinal ?? 0,
      row.reviewerSessionId,
      row.reviewerPrincipalId ?? crypto.randomUUID(),
      row.implementerSessionId,
      row.implementerPrincipalId ?? crypto.randomUUID(),
      row.headSha ?? HEAD_SHA,
      row.baseSha ?? BASE_SHA,
      row.policyDigest ?? SHA256_C,
      row.status ?? "approved",
      row.findingCount ?? 0,
      row.blockingCount ?? 0,
      row.createdAt ?? new Date("2026-10-31T12:00:00.000Z"),
    ],
  );
  return id;
}

/** Columns of `bakery.review_findings`. */
export type ReviewFindingInsert = {
  id?: string;
  organizationId: string;
  reviewCycleId: string;
  fingerprint?: string;
  severity?: string;
  path?: string;
  line?: number | null;
  body?: string;
  createdAt?: Date;
};

export async function insertReviewFinding(
  database: PgDatabase,
  row: ReviewFindingInsert,
): Promise<string> {
  const id = row.id ?? crypto.randomUUID();
  await database.query(
    `insert into bakery.review_findings
       (id, organization_id, review_cycle_id, fingerprint, severity, path,
        line, body, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      row.organizationId,
      row.reviewCycleId,
      row.fingerprint ?? fingerprintOf(1),
      row.severity ?? "major",
      row.path ?? "src/service.ts",
      row.line === undefined ? 42 : row.line,
      row.body ?? "The retry loop never stops when the provider keeps failing.",
      row.createdAt ?? new Date("2026-10-31T12:00:00.000Z"),
    ],
  );
  return id;
}

/** Columns of `bakery.delivery_decisions`. */
export type DeliveryDecisionInsert = {
  id?: string;
  organizationId: string;
  runId: string;
  ordinal?: number;
  reviewCycleId?: string | null;
  decision?: string;
  reason?: string;
  headSha?: string;
  baseSha?: string | null;
  policyDigest?: string | null;
  failedChecks?: unknown[];
  blockingFingerprints?: string[];
  limits?: Record<string, number>;
  createdAt?: Date;
};

export async function insertDeliveryDecision(
  database: PgDatabase,
  row: DeliveryDecisionInsert,
): Promise<string> {
  const id = row.id ?? crypto.randomUUID();
  await database.query(
    `insert into bakery.delivery_decisions
       (id, organization_id, run_id, ordinal, review_cycle_id, decision,
        reason, head_sha, base_sha, policy_digest, failed_checks,
        blocking_fingerprints, limits, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
             $13::jsonb, $14)`,
    [
      id,
      row.organizationId,
      row.runId,
      row.ordinal ?? 0,
      row.reviewCycleId ?? null,
      row.decision ?? "proceed",
      row.reason ?? "clean",
      row.headSha ?? HEAD_SHA,
      row.baseSha === undefined ? BASE_SHA : row.baseSha,
      row.policyDigest === undefined ? SHA256_C : row.policyDigest,
      JSON.stringify(row.failedChecks ?? []),
      JSON.stringify(row.blockingFingerprints ?? []),
      JSON.stringify(
        row.limits ?? {
          maxRepairCycles: 2,
          maxLoopDurationMs: 86_400_000,
          maxFindings: 25,
        },
      ),
      row.createdAt ?? new Date("2026-10-31T12:00:00.000Z"),
    ],
  );
  return id;
}
