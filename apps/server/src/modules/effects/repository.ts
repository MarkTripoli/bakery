import type { PgTransactionClient } from "../../platform/database.ts";
import { type ExternalEffectRow, ExternalEffectRowSchema } from "./schema.ts";

/**
 * SQL for `bakery.external_effects`. Every statement carries the organization
 * predicate, so an effect id from another organization is indistinguishable
 * from a missing one.
 */

const SELECT_COLUMNS = `
  id,
  organization_id as "organizationId",
  run_step_id as "runStepId",
  automation_definition_id as "automationDefinitionId",
  subscription_id as "subscriptionId",
  operation,
  action_version as "actionVersion",
  target,
  integration_connection_id as "integrationConnectionId",
  integration_resource_id as "integrationResourceId",
  mcp_connection_id as "mcpConnectionId",
  integration_install_id as "integrationInstallId",
  integration_grant_id as "integrationGrantId",
  adapter_manifest_digest as "adapterManifestDigest",
  repository_profile_id as "repositoryProfileId",
  requesting_principal_id as "requestingPrincipalId",
  actor_ref as "actorRef",
  idempotency_key as "idempotencyKey",
  request_digest as "requestDigest",
  safe_arguments as "safeArguments",
  argument_artifact_version_id as "argumentArtifactVersionId",
  external_account_id as "externalAccountId",
  external_resource_id as "externalResourceId",
  adapter_version as "adapterVersion",
  credential_version_id as "credentialVersionId",
  authorization_revision as "authorizationRevision",
  budget_reservation_id as "budgetReservationId",
  approval_id as "approvalId",
  approval_stage as "approvalStage",
  approval_policy_digest as "approvalPolicyDigest",
  status,
  remote_id as "remoteId",
  safe_result as "safeResult",
  failure_code as "failureCode",
  next_retry_at as "nextRetryAt",
  dispatch_generation as "dispatchGeneration",
  lease_expires_at as "leaseExpiresAt",
  last_checked_at as "lastCheckedAt",
  reconciliation_attempts as "reconciliationAttempts",
  reconciliation_evidence as "reconciliationEvidence",
  created_at as "createdAt",
  updated_at as "updatedAt",
  version`;

/** Parses a raw database row; a row that breaks the ledger invariants is rejected, never trusted. */
export function parseEffectRow(raw: unknown): ExternalEffectRow {
  return ExternalEffectRowSchema.parse(raw);
}

export type EffectKey = Readonly<{
  organizationId: string;
  operation: string;
  target: string;
  idempotencyKey: string;
}>;

export async function findEffectByKey(
  tx: PgTransactionClient,
  key: EffectKey,
): Promise<ExternalEffectRow | null> {
  const result = await tx.query(
    `select ${SELECT_COLUMNS}
       from bakery.external_effects
      where organization_id = $1 and operation = $2 and target = $3
        and idempotency_key = $4`,
    [key.organizationId, key.operation, key.target, key.idempotencyKey],
  );
  return result.rows.length === 0 ? null : parseEffectRow(result.rows[0]);
}

export async function findEffectById(
  tx: PgTransactionClient,
  organizationId: string,
  effectId: string,
): Promise<ExternalEffectRow | null> {
  const result = await tx.query(
    `select ${SELECT_COLUMNS}
       from bakery.external_effects
      where organization_id = $1 and id = $2`,
    [organizationId, effectId],
  );
  return result.rows.length === 0 ? null : parseEffectRow(result.rows[0]);
}

/** Facts about a budget reservation, read under a share lock for the prepare transaction. */
export type ReservationFacts = Readonly<{
  status: string;
  expired: boolean;
  runStepId: string | null;
  externalEffectId: string | null;
}>;

export async function lockReservationForPrepare(
  tx: PgTransactionClient,
  organizationId: string,
  reservationId: string,
): Promise<ReservationFacts | null> {
  const result = await tx.query<{
    status: string;
    expired: boolean;
    runStepId: string | null;
    externalEffectId: string | null;
  }>(
    `select status,
            expires_at <= clock_timestamp() as expired,
            run_step_id as "runStepId",
            external_effect_id as "externalEffectId"
       from bakery.budget_reservations
      where organization_id = $1 and id = $2
        for share`,
    [organizationId, reservationId],
  );
  return result.rows[0] ?? null;
}

export async function runStepExists(
  tx: PgTransactionClient,
  organizationId: string,
  runStepId: string,
): Promise<boolean> {
  const result = await tx.query(
    `select 1 from bakery.run_steps where organization_id = $1 and id = $2`,
    [organizationId, runStepId],
  );
  return result.rows.length === 1;
}

/**
 * Whether the approval row exists in the organization, and whether it is an
 * approval question belonging to the task of the run step the effect binds to.
 * Both facts are immutable, so no row lock is taken.
 */
export async function approvalScope(
  tx: PgTransactionClient,
  organizationId: string,
  approvalId: string,
  runStepId: string,
): Promise<"missing" | "mismatch" | "ok"> {
  const result = await tx.query<{ matches: boolean }>(
    `select q.kind = 'approval' and q.task_id = (
              select run.task_id
                from bakery.run_steps step
                join bakery.workflow_runs run
                  on run.organization_id = step.organization_id
                 and run.id = step.run_id
               where step.organization_id = $1 and step.id = $3
            ) as matches
       from bakery.questions q
      where q.organization_id = $1 and q.id = $2`,
    [organizationId, approvalId, runStepId],
  );
  const row = result.rows[0];
  if (!row) return "missing";
  return row.matches === true ? "ok" : "mismatch";
}

/** Columns the prepare transaction writes; the rest keep their defaults. */
export type PreparedEffectInsert = Readonly<{
  id: string;
  organizationId: string;
  runStepId: string | null;
  automationDefinitionId: string | null;
  operation: string;
  actionVersion: number;
  target: string;
  integrationConnectionId: string;
  integrationResourceId: string;
  integrationInstallId: string;
  integrationGrantId: string;
  adapterManifestDigest: string;
  requestingPrincipalId: string;
  actorRef: string;
  idempotencyKey: string;
  requestDigest: string;
  safeArguments: unknown;
  externalAccountId: string;
  externalResourceId: string;
  adapterVersion: string;
  authorizationRevision: number;
  budgetReservationId: string | null;
  approvalId: string | null;
  approvalStage: string | null;
  approvalPolicyDigest: string | null;
}>;

/**
 * Inserts a prepared effect. Returns the new row, or null when the
 * idempotency key already names a row (the caller reads it and compares).
 */
export async function insertPreparedEffect(
  tx: PgTransactionClient,
  row: PreparedEffectInsert,
): Promise<ExternalEffectRow | null> {
  const result = await tx.query(
    `insert into bakery.external_effects (
       id, organization_id, run_step_id, automation_definition_id, operation,
       action_version, target, integration_connection_id,
       integration_resource_id, integration_install_id, integration_grant_id,
       adapter_manifest_digest, requesting_principal_id, actor_ref,
       idempotency_key, request_digest, safe_arguments, external_account_id,
       external_resource_id, adapter_version, authorization_revision,
       budget_reservation_id, approval_id, approval_stage,
       approval_policy_digest, status
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
       $17::jsonb, $18, $19, $20, $21, $22, $23, $24, $25, 'prepared'
     )
     on conflict (organization_id, operation, target, idempotency_key)
     do nothing
     returning ${SELECT_COLUMNS}`,
    [
      row.id,
      row.organizationId,
      row.runStepId,
      row.automationDefinitionId,
      row.operation,
      row.actionVersion,
      row.target,
      row.integrationConnectionId,
      row.integrationResourceId,
      row.integrationInstallId,
      row.integrationGrantId,
      row.adapterManifestDigest,
      row.requestingPrincipalId,
      row.actorRef,
      row.idempotencyKey,
      row.requestDigest,
      JSON.stringify(row.safeArguments ?? null),
      row.externalAccountId,
      row.externalResourceId,
      row.adapterVersion,
      row.authorizationRevision,
      row.budgetReservationId,
      row.approvalId,
      row.approvalStage,
      row.approvalPolicyDigest,
    ],
  );
  return result.rows.length === 0 ? null : parseEffectRow(result.rows[0]);
}

/** Job facts the claim reads under a share lock. */
export type StepJobFacts = Readonly<{
  id: string;
  status: string;
  cancelRequested: boolean;
}>;

/** Locks every job of a run step `for share`, ordered by id. */
export async function lockStepJobs(
  tx: PgTransactionClient,
  organizationId: string,
  runStepId: string,
): Promise<readonly StepJobFacts[]> {
  const result = await tx.query<StepJobFacts>(
    `select id, status, cancel_requested_at is not null as "cancelRequested"
       from bakery.jobs
      where organization_id = $1 and run_step_id = $2
      order by id
        for share`,
    [organizationId, runStepId],
  );
  return result.rows;
}

/** Run and step facts the claim reads; only the run row is locked. */
export type RunScopeFacts = Readonly<{
  runId: string;
  taskId: string;
  runStatus: string;
  stepStatus: string;
}>;

/** Reads the step and its run, locking the run row `for share`. */
export async function lockRunScope(
  tx: PgTransactionClient,
  organizationId: string,
  runStepId: string,
): Promise<RunScopeFacts | null> {
  const result = await tx.query<RunScopeFacts>(
    `select run.id as "runId", run.task_id as "taskId",
            run.status as "runStatus", step.status as "stepStatus"
       from bakery.run_steps step
       join bakery.workflow_runs run
         on run.organization_id = step.organization_id
        and run.id = step.run_id
      where step.organization_id = $1 and step.id = $2
        for share of run`,
    [organizationId, runStepId],
  );
  return result.rows[0] ?? null;
}

/** A locked effect row with whether its retry delay has elapsed. */
export type LockedEffect = Readonly<{ row: ExternalEffectRow; due: boolean }>;

/** Locks the effect row `for update`; null when the id is not in the organization. */
export async function lockEffectForClaim(
  tx: PgTransactionClient,
  organizationId: string,
  effectId: string,
): Promise<LockedEffect | null> {
  const result = await tx.query<Record<string, unknown>>(
    `select ${SELECT_COLUMNS},
            (next_retry_at is null or next_retry_at <= clock_timestamp()) as due
       from bakery.external_effects
      where organization_id = $1 and id = $2
        for update`,
    [organizationId, effectId],
  );
  const raw = result.rows[0];
  if (!raw) return null;
  const { due, ...columns } = raw;
  return { row: parseEffectRow(columns), due: due === true };
}

/** Question facts the claim checks for an approval-bound effect. */
export type ApprovalFacts = Readonly<{
  status: string;
  decision: string | null;
  subjectId: string | null;
  stage: string | null;
  policyDigest: string | null;
  consumedByRunId: string | null;
  revoked: boolean;
}>;

/** Locks the approval question `for update`. */
export async function lockApproval(
  tx: PgTransactionClient,
  organizationId: string,
  approvalId: string,
): Promise<ApprovalFacts | null> {
  const result = await tx.query<ApprovalFacts>(
    `select status, decision, subject_id as "subjectId",
            scope->>'stage' as stage, policy_digest as "policyDigest",
            consumed_by_run_id as "consumedByRunId",
            revoked_at is not null as revoked
       from bakery.questions
      where organization_id = $1 and id = $2 and kind = 'approval'
        for update`,
    [organizationId, approvalId],
  );
  return result.rows[0] ?? null;
}

/** Id of the task's newest approved plan revision, the authority an approval must still match. */
export async function latestApprovedRevisionId(
  tx: PgTransactionClient,
  organizationId: string,
  taskId: string,
): Promise<string | null> {
  const result = await tx.query<{ id: string }>(
    `select id from bakery.plan_revisions
      where organization_id = $1 and task_id = $2 and status = 'approved'
      order by revision desc
      limit 1`,
    [organizationId, taskId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Compare-and-swap `prepared -> submitted`: bumps the dispatch generation and
 * sets the lease in the same statement. Null when the fence no longer holds.
 */
export async function casClaim(
  tx: PgTransactionClient,
  organizationId: string,
  effectId: string,
  expectedGeneration: number,
  leaseSeconds: number,
): Promise<ExternalEffectRow | null> {
  const result = await tx.query(
    `update bakery.external_effects
        set status = 'submitted',
            dispatch_generation = dispatch_generation + 1,
            lease_expires_at = clock_timestamp() + make_interval(secs => $4),
            next_retry_at = null,
            updated_at = clock_timestamp(),
            version = version + 1
      where organization_id = $1 and id = $2 and status = 'prepared'
        and dispatch_generation = $3
      returning ${SELECT_COLUMNS}`,
    [organizationId, effectId, expectedGeneration, leaseSeconds],
  );
  return result.rows.length === 0 ? null : parseEffectRow(result.rows[0]);
}

/** Compare-and-swap `prepared -> failed` with the reason a claim was refused. */
export async function casToFailed(
  tx: PgTransactionClient,
  organizationId: string,
  effectId: string,
  expectedGeneration: number,
  failureCode: string,
): Promise<ExternalEffectRow | null> {
  const result = await tx.query(
    `update bakery.external_effects
        set status = 'failed',
            failure_code = $4,
            next_retry_at = null,
            lease_expires_at = null,
            updated_at = clock_timestamp(),
            version = version + 1
      where organization_id = $1 and id = $2 and status = 'prepared'
        and dispatch_generation = $3
      returning ${SELECT_COLUMNS}`,
    [organizationId, effectId, expectedGeneration, failureCode],
  );
  return result.rows.length === 0 ? null : parseEffectRow(result.rows[0]);
}

/** An effect row with the clock facts the dispatcher needs, read without locking. */
export type EffectState = Readonly<{
  row: ExternalEffectRow;
  leaseLive: boolean;
  due: boolean;
}>;

/** Reads an effect and whether its lease is live and its retry delay has elapsed, by the database clock. */
export async function readEffectState(
  tx: PgTransactionClient,
  organizationId: string,
  effectId: string,
): Promise<EffectState | null> {
  const result = await tx.query<Record<string, unknown>>(
    `select ${SELECT_COLUMNS},
            (lease_expires_at is not null
             and lease_expires_at > clock_timestamp()) as "leaseLive",
            (next_retry_at is null
             or next_retry_at <= clock_timestamp()) as due
       from bakery.external_effects
      where organization_id = $1 and id = $2`,
    [organizationId, effectId],
  );
  const raw = result.rows[0];
  if (!raw) return null;
  const { leaseLive, due, ...columns } = raw;
  return {
    row: parseEffectRow(columns),
    leaseLive: leaseLive === true,
    due: due === true,
  };
}

/** What a dispatch attempt changes on the row. */
export type OutcomeChange =
  | Readonly<{
    kind: "confirmed";
    remoteId: string | null;
    safeResult: unknown;
  }>
  | Readonly<{ kind: "uncertain" }>
  | Readonly<{ kind: "retry"; delaySeconds: number }>
  | Readonly<{ kind: "failed"; failureCode: string }>;

/**
 * Fenced write of a dispatch outcome. It lands only while the row is still
 * `submitted` at the generation that was claimed; a late `confirmed` may also
 * land on `uncertain` with the same generation. The lease is cleared on every
 * outcome. Null when the fence was lost.
 */
export async function casOutcome(
  tx: PgTransactionClient,
  organizationId: string,
  effectId: string,
  generation: number,
  change: OutcomeChange,
): Promise<ExternalEffectRow | null> {
  const from = change.kind === "confirmed"
    ? ["submitted", "uncertain"]
    : ["submitted"];
  const common = `lease_expires_at = null,
            updated_at = clock_timestamp(),
            version = version + 1`;
  const fence = `where organization_id = $1 and id = $2
        and dispatch_generation = $3 and status = any($4::text[])`;
  let sql: string;
  let values: unknown[];
  switch (change.kind) {
    case "confirmed":
      sql = `update bakery.external_effects
        set status = 'confirmed', remote_id = $5, safe_result = $6::jsonb,
            failure_code = null, next_retry_at = null, ${common}
      ${fence}
      returning ${SELECT_COLUMNS}`;
      values = [
        change.remoteId,
        JSON.stringify(change.safeResult ?? null),
      ];
      break;
    case "uncertain":
      sql = `update bakery.external_effects
        set status = 'uncertain', ${common}
      ${fence}
      returning ${SELECT_COLUMNS}`;
      values = [];
      break;
    case "retry":
      sql = `update bakery.external_effects
        set status = 'prepared',
            next_retry_at = clock_timestamp() + make_interval(secs => $5),
            ${common}
      ${fence}
      returning ${SELECT_COLUMNS}`;
      values = [change.delaySeconds];
      break;
    case "failed":
      sql = `update bakery.external_effects
        set status = 'failed', failure_code = $5, next_retry_at = null,
            ${common}
      ${fence}
      returning ${SELECT_COLUMNS}`;
      values = [change.failureCode];
      break;
  }
  const result = await tx.query(sql, [
    organizationId,
    effectId,
    generation,
    from,
    ...values,
  ]);
  return result.rows.length === 0 ? null : parseEffectRow(result.rows[0]);
}

/**
 * Takes the reconciliation lease. A `submitted` effect whose dispatch lease
 * has expired becomes `uncertain`; an `uncertain` effect is taken only when no
 * live reconciliation lease holds it. Bumps the version, which fences the
 * check that follows. Null when the effect is not eligible.
 */
export async function casReconcileLease(
  tx: PgTransactionClient,
  organizationId: string,
  effectId: string,
  leaseSeconds: number,
): Promise<ExternalEffectRow | null> {
  const result = await tx.query(
    `update bakery.external_effects
        set status = 'uncertain',
            lease_expires_at = clock_timestamp() + make_interval(secs => $3),
            updated_at = clock_timestamp(),
            version = version + 1
      where organization_id = $1 and id = $2
        and ((status = 'submitted' and lease_expires_at <= clock_timestamp())
          or (status = 'uncertain'
              and (lease_expires_at is null
                   or lease_expires_at <= clock_timestamp())))
      returning ${SELECT_COLUMNS}`,
    [organizationId, effectId, leaseSeconds],
  );
  return result.rows.length === 0 ? null : parseEffectRow(result.rows[0]);
}

/** What a read-only reconciliation check writes. */
export type ReconcileCheck = Readonly<{
  confirmed: Readonly<{ remoteId: string | null; safeResult: unknown }> | null;
  evidence: unknown;
}>;

/**
 * Fenced write of one reconciliation check: the row must still be the
 * `uncertain` row whose lease this check took (same version). Always records
 * the check time, the attempt and the bounded evidence, and clears the lease.
 * Null when the fence was lost.
 */
export async function recordReconcileCheck(
  tx: PgTransactionClient,
  organizationId: string,
  effectId: string,
  expectedVersion: number,
  check: ReconcileCheck,
): Promise<ExternalEffectRow | null> {
  const result = await tx.query(
    `update bakery.external_effects
        set status = case when $4::boolean then 'confirmed' else status end,
            remote_id = case when $4::boolean then $5::text else remote_id end,
            safe_result = case when $4::boolean then $6::jsonb
                               else safe_result end,
            last_checked_at = clock_timestamp(),
            reconciliation_attempts = reconciliation_attempts + 1,
            reconciliation_evidence = $7::jsonb,
            lease_expires_at = null,
            updated_at = clock_timestamp(),
            version = version + 1
      where organization_id = $1 and id = $2 and status = 'uncertain'
        and version = $3
      returning ${SELECT_COLUMNS}`,
    [
      organizationId,
      effectId,
      expectedVersion,
      check.confirmed !== null,
      check.confirmed?.remoteId ?? null,
      JSON.stringify(check.confirmed?.safeResult ?? null),
      JSON.stringify(check.evidence),
    ],
  );
  return result.rows.length === 0 ? null : parseEffectRow(result.rows[0]);
}
