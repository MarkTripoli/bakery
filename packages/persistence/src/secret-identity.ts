import { StandardError } from "@bakery/contracts/http";
import {
  type SealedCredentialOperation,
  SealedCredentialOperationSchema,
  type SecretIdentityInvocationProof,
  type SecretIdentityToolResult,
  SecretIdentityToolResultSchema,
} from "@bakery/contracts/secret-identity";
import {
  admitRepositoryExecutionJob,
  canonicalExecutionInputDigest,
} from "./repository-admission.ts";
import type { PgTransactionClient } from "./postgres.ts";
import { sessionGeneration } from "./types.ts";

const PREPARED_TTL_SECONDS = 30;
const PROVIDER = "github";
const POLICY_ACTION = "identity.read";
const WORKER_ACTION = "secret.identity.read";

type OperationStatus =
  | "prepared"
  | "in_flight"
  | "completed"
  | "denied"
  | "uncertain";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_ACCOUNT_ID_PATTERN = /^[1-9][0-9]{0,15}$/;
const OPERATION_STATUSES = new Set<OperationStatus>([
  "prepared",
  "in_flight",
  "completed",
  "denied",
  "uncertain",
]);

type OperationRow = {
  id: string;
  organization_id: string;
  application_id: string;
  repository_id: string;
  repository_profile_id: string;
  repository_profile_revision: number;
  repository_profile_digest: string;
  observation_id: string | null;
  observation_digest: string | null;
  base_sha: string | null;
  run_id: string;
  run_step_id: string;
  job_id: string;
  attempt_id: string;
  worker_host_id: string;
  worker_session_id: string;
  worker_session_generation: string | number;
  requester_id: string;
  secret_id: string;
  secret_version_id: string;
  secret_generation: number;
  policy_revision: number;
  invalidation_generation: number;
  verified_provider_account_id: string;
  provider: string;
  action: string;
  input_digest: string;
  fence: string | number;
  lease_token_hash: string;
  lease_expires_at: Date | string;
  status: OperationStatus;
  expires_at: Date | string;
  io_attempt: number;
  request_digest: string | null;
  safe_result: unknown;
  safe_code: string | null;
  result_digest: string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  run_requested_by: string | null;
  run_application_id: string | null;
  run_repository_id: string | null;
  current_profile_id: string | null;
  current_profile_revision: number | null;
  current_profile_digest: string | null;
  current_observation_id: string | null;
  current_observation_digest: string | null;
  current_base_sha: string | null;
  job_action: string;
  job_input: unknown;
  job_fence: string | number;
  attempt_worker_host_id: string;
  attempt_worker_session_id: string;
  attempt_worker_session_generation: string | number;
  attempt_fence: string | number;
  attempt_lease_token_hash: string;
  attempt_lease_expires_at: Date | string;
  attempt_status: string;
  secret_revoked_at: Date | string | null;
  secret_expires_at: Date | string | null;
  current_secret_generation: number;
  current_policy_revision: number;
  current_invalidation_generation: number;
  current_secret_version_id: string | null;
  current_verified_provider_account_id: string | null;
  allowed_principals: unknown;
  allowed_actions: unknown;
  requester_disabled_at: Date | string | null;
  membership_status: string | null;
  version_expires_at: Date | string | null;
  version_revision: number;
  version_key_id: string;
  version_ciphertext: Uint8Array;
  version_nonce: Uint8Array;
  authority_time: Date | string;
};

export type PreparedOperationWorkerIdentity = {
  readonly host: {
    readonly id: string;
    readonly organizationId: string;
    readonly workerSessionId: string | null;
    readonly workerSessionGeneration: string | number;
  };
};

export type PrepareIdentityOperationInput = {
  organizationId: string;
  jobId: string;
  attemptId: string;
  workerHostId: string;
  workerSessionId: string;
  workerSessionGeneration: string | number;
  fence: bigint;
  leaseToken: string;
  leaseExpiresAt: Date;
  inputDigest: string;
};

export type PreparedIdentityInvocation = {
  operationId: string;
  requestDigest: string;
  organizationId: string;
  applicationId: string;
  secretId: string;
  versionId: string;
  revision: number;
  keyId: string;
  ciphertext: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
};

export type BeginPreparedIdentityInvocation =
  | { kind: "invoke"; value: PreparedIdentityInvocation }
  | { kind: "terminal"; result: SecretIdentityToolResult; replayed: boolean };
type SecretIdentityDenialCode = Extract<
  SecretIdentityToolResult,
  { status: "denied" }
>["code"];

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("PREPARED_OPERATION_TIMESTAMP_INVALID");
  }
  return date.toISOString();
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ? value
    : [];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function operationDenied(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

function invalidStoredOperation(reason: string): never {
  throw new StandardError({
    code: "INTERNAL",
    cause: new Error(`PREPARED_OPERATION_ROW_INVALID:${reason}`),
  });
}

function storedTimestamp(value: Date | string, field: string): number {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) invalidStoredOperation(field);
  return time;
}

function assertStoredOperation(row: OperationRow): void {
  if (row.provider !== PROVIDER) invalidStoredOperation("provider");
  if (row.action !== POLICY_ACTION) invalidStoredOperation("action");
  if (!OPERATION_STATUSES.has(row.status)) {
    invalidStoredOperation("status");
  }
  if (!Number.isInteger(row.io_attempt) || ![0, 1].includes(row.io_attempt)) {
    invalidStoredOperation("io_attempt");
  }
  if (!SHA256_PATTERN.test(row.input_digest)) {
    invalidStoredOperation("input_digest");
  }
  if (!SHA256_PATTERN.test(row.lease_token_hash)) {
    invalidStoredOperation("lease_token_hash");
  }
  if (
    row.request_digest !== null &&
    !SHA256_PATTERN.test(row.request_digest)
  ) invalidStoredOperation("request_digest");
  if (
    row.result_digest !== null &&
    !SHA256_PATTERN.test(row.result_digest)
  ) invalidStoredOperation("result_digest");
  if (!PROVIDER_ACCOUNT_ID_PATTERN.test(row.verified_provider_account_id)) {
    invalidStoredOperation("verified_provider_account_id");
  }
  if (
    row.safe_code !== null &&
    (row.safe_code.length < 1 || row.safe_code.length > 64)
  ) invalidStoredOperation("safe_code");

  const createdAt = storedTimestamp(row.created_at, "created_at");
  const expiresAt = storedTimestamp(row.expires_at, "expires_at");
  const leaseExpiresAt = storedTimestamp(
    row.lease_expires_at,
    "lease_expires_at",
  );
  if (
    expiresAt <= createdAt ||
    expiresAt > createdAt + PREPARED_TTL_SECONDS * 1000 ||
    expiresAt > leaseExpiresAt
  ) invalidStoredOperation("expires_at");
  if (row.completed_at !== null) {
    storedTimestamp(row.completed_at, "completed_at");
  }

  if (row.status === "prepared" || row.status === "in_flight") {
    if (
      row.safe_result !== null || row.safe_code !== null ||
      row.result_digest !== null || row.completed_at !== null ||
      (row.status === "prepared" &&
        (row.io_attempt !== 0 || row.request_digest !== null)) ||
      (row.status === "in_flight" &&
        (row.io_attempt !== 1 || row.request_digest === null))
    ) invalidStoredOperation("active_lifecycle");
    return;
  }

  if (
    row.safe_result === null || row.result_digest === null ||
    row.completed_at === null || row.request_digest === null
  ) invalidStoredOperation("terminal_lifecycle");
  const parsed = SecretIdentityToolResultSchema.safeParse(row.safe_result);
  if (!parsed.success || parsed.data.status !== row.status) {
    invalidStoredOperation("safe_result");
  }
  const parsedCode = "code" in parsed.data ? parsed.data.code : null;
  if (
    (row.status === "completed" &&
      (row.io_attempt !== 1 || row.safe_code !== null)) ||
    (row.status === "denied" &&
      (row.io_attempt !== 0 || row.safe_code !== parsedCode)) ||
    (row.status === "uncertain" &&
      (row.io_attempt !== 1 || row.safe_code !== parsedCode))
  ) invalidStoredOperation("terminal_state");
}

async function loadOperation(
  transaction: PgTransactionClient,
  organizationId: string,
  attemptId: string,
  operationId?: string,
  authorityTime?: Date,
): Promise<OperationRow | null> {
  const result = await transaction.query<OperationRow>(
    `select operation.*,
            run.requested_by as run_requested_by,
            run.application_id as run_application_id,
            run.repository_id as run_repository_id,
            run.repository_profile_id as current_profile_id,
            run.repository_profile_revision as current_profile_revision,
            run.repository_profile_digest as current_profile_digest,
            run.observation_id as current_observation_id,
            run.observation_digest as current_observation_digest,
            run.base_sha as current_base_sha,
            job.action as job_action, job.input as job_input,
            job.current_fence as job_fence,
            attempt.worker_host_id as attempt_worker_host_id,
            attempt.worker_session_id as attempt_worker_session_id,
            attempt.worker_session_generation as attempt_worker_session_generation,
            attempt.fence as attempt_fence,
            attempt.lease_token_hash as attempt_lease_token_hash,
            attempt.lease_expires_at as attempt_lease_expires_at,
            attempt.status as attempt_status,
            secret.revoked_at as secret_revoked_at,
            secret.expires_at as secret_expires_at,
            secret.generation as current_secret_generation,
            secret.policy_revision as current_policy_revision,
            secret.invalidation_generation as current_invalidation_generation,
            secret.active_version_id as current_secret_version_id,
            secret.verified_provider_account_id as current_verified_provider_account_id,
            secret.allowed_principals, secret.allowed_actions,
            requester.disabled_at as requester_disabled_at,
            membership.status as membership_status,
            version.expires_at as version_expires_at,
            version.revision as version_revision,
            version.key_id as version_key_id,
            version.ciphertext as version_ciphertext,
            version.nonce as version_nonce,
            coalesce($4::timestamptz, clock_timestamp()) as authority_time
       from bakery.prepared_operations operation
       join bakery.workflow_runs run
         on run.organization_id = operation.organization_id
        and run.id = operation.run_id
       join bakery.jobs job
         on job.organization_id = operation.organization_id
        and job.id = operation.job_id
       join bakery.job_attempts attempt
         on attempt.organization_id = operation.organization_id
        and attempt.id = operation.attempt_id
       join bakery.secrets secret
         on secret.organization_id = operation.organization_id
        and secret.application_id = operation.application_id
        and secret.id = operation.secret_id
       join bakery.secret_versions version
         on version.secret_id = operation.secret_id
        and version.id = operation.secret_version_id
       left join bakery.principals requester
         on requester.id = run.requested_by
       left join bakery.organization_memberships membership
         on membership.organization_id = operation.organization_id
        and membership.principal_id = run.requested_by
      where operation.organization_id = $1
        and operation.attempt_id = $2
        and ($3::uuid is null or operation.id = $3)
      for update of operation, attempt, job, run, secret`,
    [organizationId, attemptId, operationId ?? null, authorityTime ?? null],
  );
  const row = result.rows[0];
  if (row) assertStoredOperation(row);
  return row ?? null;
}

function same(
  left: string | number | null,
  right: string | number | null,
): boolean {
  return left === null || right === null
    ? left === right
    : String(left) === String(right);
}

function bindingCode(
  row: OperationRow,
  identity: PreparedOperationWorkerIdentity,
  proof?: SecretIdentityInvocationProof,
): SecretIdentityDenialCode | null {
  const now = new Date(row.authority_time).getTime();
  if (now >= new Date(row.expires_at).getTime()) {
    return "SECRET_OPERATION_EXPIRED";
  }
  if (
    row.worker_host_id !== identity.host.id ||
    row.attempt_worker_host_id !== identity.host.id ||
    identity.host.workerSessionId === null ||
    row.worker_session_id !== identity.host.workerSessionId ||
    row.attempt_worker_session_id !== identity.host.workerSessionId ||
    !same(
      row.worker_session_generation,
      identity.host.workerSessionGeneration,
    ) ||
    !same(
      row.attempt_worker_session_generation,
      identity.host.workerSessionGeneration,
    )
  ) return "SESSION_REBOUND";
  if (
    !same(row.fence, row.job_fence) || !same(row.fence, row.attempt_fence) ||
    !["leased", "running"].includes(row.attempt_status) ||
    now >= new Date(row.lease_expires_at).getTime() ||
    now >= new Date(row.attempt_lease_expires_at).getTime()
  ) return "LEASE_FENCED";
  if (proof) {
    if (
      proof.fence !== String(row.fence) ||
      proof.workerSessionId !== row.worker_session_id ||
      proof.workerSessionGeneration !== String(row.worker_session_generation)
    ) return "LEASE_FENCED";
  }
  if (row.run_requested_by !== row.requester_id) return "SECRET_POLICY_STALE";
  if (
    row.run_application_id !== row.application_id ||
    row.run_repository_id !== row.repository_id ||
    row.current_profile_id !== row.repository_profile_id ||
    !same(row.current_profile_revision, row.repository_profile_revision) ||
    row.current_profile_digest !== row.repository_profile_digest ||
    row.current_observation_id !== row.observation_id ||
    row.current_observation_digest !== row.observation_digest ||
    row.current_base_sha !== row.base_sha ||
    row.job_action !== WORKER_ACTION || row.provider !== PROVIDER ||
    row.action !== POLICY_ACTION
  ) return "INPUT_DIGEST_MISMATCH";
  if (
    row.secret_revoked_at !== null ||
    (row.secret_expires_at !== null &&
      now >= new Date(row.secret_expires_at).getTime()) ||
    (row.version_expires_at !== null &&
      now >= new Date(row.version_expires_at).getTime())
  ) return "SECRET_REVOKED";
  if (
    row.current_secret_generation !== row.secret_generation ||
    row.current_invalidation_generation !== row.invalidation_generation ||
    row.current_secret_version_id !== row.secret_version_id
  ) return "SECRET_GENERATION_STALE";
  const principals = stringArray(row.allowed_principals);
  const actions = stringArray(row.allowed_actions);
  if (
    row.current_policy_revision !== row.policy_revision ||
    row.current_verified_provider_account_id !==
      row.verified_provider_account_id ||
    row.requester_disabled_at !== null || row.membership_status !== "active" ||
    !principals.includes(row.requester_id) || !actions.includes(POLICY_ACTION)
  ) return "SECRET_POLICY_STALE";
  return null;
}

async function inputDigestMatches(row: OperationRow): Promise<boolean> {
  return await canonicalExecutionInputDigest(row.job_input) ===
    row.input_digest;
}

async function requestDigest(
  row: OperationRow,
  proof: SecretIdentityInvocationProof,
): Promise<string> {
  return await canonicalExecutionInputDigest({
    attemptId: row.attempt_id,
    preparedOperationId: row.id,
    leaseTokenHash: await sha256Hex(proof.leaseToken),
    fence: proof.fence,
    workerSessionId: proof.workerSessionId,
    workerSessionGeneration: proof.workerSessionGeneration,
    inputDigest: row.input_digest,
  });
}

async function persistTerminal(
  transaction: PgTransactionClient,
  row: OperationRow,
  result: SecretIdentityToolResult,
  expectedStatus: OperationStatus,
  admittedRequestDigest?: string,
): Promise<SecretIdentityToolResult> {
  const safe = SecretIdentityToolResultSchema.parse(result);
  const encoded = JSON.stringify(safe);
  const digest = await sha256Hex(encoded);
  const updated = await transaction.query(
    `update bakery.prepared_operations
        set status = $4, safe_result = $5::jsonb,
            safe_code = $6, result_digest = $7,
            request_digest = coalesce(request_digest, $8),
            completed_at = clock_timestamp(), updated_at = clock_timestamp()
      where organization_id = $1 and id = $2 and status = $3
        and io_attempt in (0, 1)`,
    [
      row.organization_id,
      row.id,
      expectedStatus,
      safe.status,
      encoded,
      "code" in safe ? safe.code : null,
      digest,
      admittedRequestDigest ?? null,
    ],
  );
  if (updated.rowCount !== 1) {
    operationDenied("prepared_operation_transition_lost");
  }
  return safe;
}

export async function prepareIdentityOperation(
  transaction: PgTransactionClient,
  input: PrepareIdentityOperationInput,
): Promise<SealedCredentialOperation> {
  await admitRepositoryExecutionJob(
    transaction,
    input.organizationId,
    input.jobId,
  );
  const result = await transaction.query<{
    application_id: string;
    repository_id: string;
    repository_profile_id: string;
    repository_profile_revision: number;
    repository_profile_digest: string;
    observation_id: string | null;
    observation_digest: string | null;
    base_sha: string | null;
    run_id: string;
    run_step_id: string;
    requested_by: string;
    action: string;
    job_input: unknown;
    attempt_worker_host_id: string;
    attempt_worker_session_id: string;
    attempt_worker_session_generation: string | number;
    attempt_fence: string | number;
    attempt_lease_token_hash: string;
    attempt_lease_expires_at: Date;
    attempt_status: string;
    secret_id: string;
    secret_version_id: string;
    secret_generation: number;
    policy_revision: number;
    invalidation_generation: number;
    verified_provider_account_id: string;
    secret_provider: string;
  }>(
    `select job.application_id, job.repository_id,
            job.repository_profile_id, job.repository_profile_revision,
            job.repository_profile_digest, job.observation_id,
            job.observation_digest, job.base_sha,
            run.id as run_id, step.id as run_step_id,
            run.requested_by, job.action, job.input as job_input,
            attempt.worker_host_id as attempt_worker_host_id,
            attempt.worker_session_id as attempt_worker_session_id,
            attempt.worker_session_generation as attempt_worker_session_generation,
            attempt.fence as attempt_fence,
            attempt.lease_token_hash as attempt_lease_token_hash,
            attempt.lease_expires_at as attempt_lease_expires_at,
            attempt.status as attempt_status,
            secret.id as secret_id,
            secret.active_version_id as secret_version_id,
            secret.generation as secret_generation,
            secret.policy_revision, secret.invalidation_generation,
            secret.verified_provider_account_id,
            secret.provider as secret_provider
       from bakery.jobs job
       join bakery.run_steps step
         on step.organization_id = job.organization_id and step.id = job.run_step_id
       join bakery.workflow_runs run
         on run.organization_id = step.organization_id and run.id = step.run_id
       join bakery.job_attempts attempt
         on attempt.organization_id = job.organization_id
        and attempt.job_id = job.id and attempt.id = $3
       join bakery.secrets secret
         on secret.organization_id = job.organization_id
        and secret.application_id = job.application_id
        and secret.id = (job.input->>'secretRef')::uuid
       join bakery.secret_versions version
         on version.organization_id = secret.organization_id
        and version.application_id = secret.application_id
        and version.secret_id = secret.id
        and version.id = secret.active_version_id
      where job.organization_id = $1 and job.id = $2
        and job.action = 'secret.identity.read'
        and job.application_id is not null and job.repository_id is not null
        and attempt.worker_host_id = $4
        and attempt.worker_session_id = $5
        and attempt.worker_session_generation = $6
        and attempt.fence = $7 and attempt.lease_token_hash = $8
        and attempt.lease_expires_at = $9 and attempt.status = 'leased'
        and attempt.lease_expires_at > clock_timestamp()
        and run.requested_by is not null
        and secret.revoked_at is null
        and (secret.expires_at is null or secret.expires_at > clock_timestamp())
        and (version.expires_at is null or version.expires_at > clock_timestamp())
      for update of attempt, job, run, secret`,
    [
      input.organizationId,
      input.jobId,
      input.attemptId,
      input.workerHostId,
      input.workerSessionId,
      sessionGeneration(input.workerSessionGeneration, 1n).toString(),
      input.fence.toString(),
      await sha256Hex(input.leaseToken),
      input.leaseExpiresAt,
    ],
  );
  const row = result.rows[0];
  if (
    !row || row.action !== WORKER_ACTION || row.secret_provider !== PROVIDER ||
    !PROVIDER_ACCOUNT_ID_PATTERN.test(row.verified_provider_account_id)
  ) {
    operationDenied("secret_identity_repository_admission_required");
  }
  const digest = await canonicalExecutionInputDigest(row.job_input);
  if (digest !== input.inputDigest) {
    operationDenied("prepared_input_digest_mismatch");
  }
  const operationId = crypto.randomUUID();
  const inserted = await transaction.query<{ expires_at: Date }>(
    `insert into bakery.prepared_operations (
       id, organization_id, application_id, repository_id,
       repository_profile_id, repository_profile_revision,
       repository_profile_digest, observation_id, observation_digest, base_sha,
       run_id, run_step_id, job_id, attempt_id,
       worker_host_id, worker_session_id, worker_session_generation,
       requester_id, secret_id, secret_version_id, secret_generation,
       policy_revision, invalidation_generation, verified_provider_account_id,
       provider, action, input_digest, fence, lease_token_hash, lease_expires_at,
       status, expires_at, io_attempt
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
       $19,$20,$21,$22,$23,$24,'github','identity.read',$25,$26,$27,$28,
       'prepared', least(clock_timestamp() + ($29::integer * interval '1 second'), $28), 0
     ) returning expires_at`,
    [
      operationId,
      input.organizationId,
      row.application_id,
      row.repository_id,
      row.repository_profile_id,
      row.repository_profile_revision,
      row.repository_profile_digest,
      row.observation_id,
      row.observation_digest,
      row.base_sha,
      row.run_id,
      row.run_step_id,
      input.jobId,
      input.attemptId,
      input.workerHostId,
      input.workerSessionId,
      sessionGeneration(input.workerSessionGeneration, 1n).toString(),
      row.requested_by,
      row.secret_id,
      row.secret_version_id,
      row.secret_generation,
      row.policy_revision,
      row.invalidation_generation,
      row.verified_provider_account_id,
      digest,
      input.fence.toString(),
      await sha256Hex(input.leaseToken),
      input.leaseExpiresAt,
      PREPARED_TTL_SECONDS,
    ],
  );
  const expiresAt = inserted.rows[0]?.expires_at;
  if (!expiresAt) operationDenied("prepared_operation_insert_failed");
  return SealedCredentialOperationSchema.parse({
    preparedOperationId: operationId,
    jobId: input.jobId,
    attemptId: input.attemptId,
    inputDigest: digest,
    expiresAt: iso(expiresAt),
  });
}

export async function rebindPreparedIdentityOperation(
  transaction: PgTransactionClient,
  identity: PreparedOperationWorkerIdentity,
  attemptId: string,
  authorityTime?: Date,
): Promise<void> {
  const action = await transaction.query<{ action: string }>(
    `select job.action
       from bakery.job_attempts attempt
       join bakery.jobs job
         on job.organization_id = attempt.organization_id
        and job.id = attempt.job_id
      where attempt.organization_id = $1 and attempt.id = $2
        and attempt.worker_host_id = $3`,
    [identity.host.organizationId, attemptId, identity.host.id],
  );
  if (action.rows[0]?.action !== WORKER_ACTION) return;
  const row = await loadOperation(
    transaction,
    identity.host.organizationId,
    attemptId,
    undefined,
    authorityTime,
  );
  if (!row) operationDenied("prepared_operation_missing");
  const code = bindingCode(row, identity);
  if (code || !(await inputDigestMatches(row))) {
    throw new StandardError({
      code: code === "LEASE_FENCED" || code === "SESSION_REBOUND"
        ? "LEASE_FENCED"
        : "STATE_CONFLICT",
      params: { reason: code ?? "INPUT_DIGEST_MISMATCH" },
    });
  }
}

export async function beginPreparedIdentityInvocation(
  transaction: PgTransactionClient,
  identity: PreparedOperationWorkerIdentity,
  attemptId: string,
  operationId: string,
  proof: SecretIdentityInvocationProof,
): Promise<BeginPreparedIdentityInvocation> {
  const row = await loadOperation(
    transaction,
    identity.host.organizationId,
    attemptId,
    operationId,
  );
  if (!row) operationDenied("prepared_operation_missing");
  const digest = await requestDigest(row, proof);
  if (row.request_digest !== null && row.request_digest !== digest) {
    throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
  }
  if (
    row.status === "completed" || row.status === "denied" ||
    row.status === "uncertain"
  ) {
    return {
      kind: "terminal",
      result: SecretIdentityToolResultSchema.parse(row.safe_result),
      replayed: true,
    };
  }
  if (row.status === "in_flight" || row.io_attempt === 1) {
    return {
      kind: "terminal",
      result: await persistTerminal(transaction, row, {
        status: "uncertain",
        code: "OPERATION_RECOVERY_UNCERTAIN",
      }, "in_flight"),
      replayed: true,
    };
  }
  if (row.status !== "prepared" || row.io_attempt !== 0) {
    operationDenied("prepared_operation_state_invalid");
  }
  const proofHash = await sha256Hex(proof.leaseToken);
  if (
    proofHash !== row.lease_token_hash ||
    proofHash !== row.attempt_lease_token_hash
  ) throw new StandardError({ code: "LEASE_FENCED" });
  let code = bindingCode(row, identity, proof);
  if (!code && !(await inputDigestMatches(row))) code = "INPUT_DIGEST_MISMATCH";
  if (code) {
    return {
      kind: "terminal",
      result: await persistTerminal(
        transaction,
        row,
        {
          status: "denied",
          code,
        },
        "prepared",
        digest,
      ),
      replayed: false,
    };
  }
  try {
    await admitRepositoryExecutionJob(
      transaction,
      row.organization_id,
      row.job_id,
    );
  } catch (error) {
    if (!(error instanceof StandardError)) throw error;
    return {
      kind: "terminal",
      result: await persistTerminal(
        transaction,
        row,
        {
          status: "denied",
          code: "SECRET_POLICY_STALE",
        },
        "prepared",
        digest,
      ),
      replayed: false,
    };
  }
  const updated = await transaction.query(
    `update bakery.prepared_operations
        set status = 'in_flight', io_attempt = 1,
            request_digest = $3, updated_at = clock_timestamp()
      where organization_id = $1 and id = $2
        and status = 'prepared' and io_attempt = 0`,
    [row.organization_id, row.id, digest],
  );
  if (updated.rowCount !== 1) {
    operationDenied("prepared_operation_admission_lost");
  }
  return {
    kind: "invoke",
    value: {
      operationId: row.id,
      requestDigest: digest,
      organizationId: row.organization_id,
      applicationId: row.application_id,
      secretId: row.secret_id,
      versionId: row.secret_version_id,
      revision: row.version_revision,
      keyId: row.version_key_id,
      ciphertext: Uint8Array.from(row.version_ciphertext),
      nonce: Uint8Array.from(row.version_nonce),
    },
  };
}

export async function completePreparedIdentityInvocation(
  transaction: PgTransactionClient,
  identity: PreparedOperationWorkerIdentity,
  attemptId: string,
  operationId: string,
  requestDigestValue: string,
  providerResult: SecretIdentityToolResult,
): Promise<SecretIdentityToolResult> {
  const row = await loadOperation(
    transaction,
    identity.host.organizationId,
    attemptId,
    operationId,
  );
  if (!row || row.request_digest !== requestDigestValue) {
    operationDenied("prepared_operation_completion_binding_invalid");
  }
  if (
    row.status === "completed" || row.status === "denied" ||
    row.status === "uncertain"
  ) {
    return SecretIdentityToolResultSchema.parse(row.safe_result);
  }
  if (row.status !== "in_flight" || row.io_attempt !== 1) {
    operationDenied("prepared_operation_completion_state_invalid");
  }
  let lost = bindingCode(row, identity);
  if (!lost && !(await inputDigestMatches(row))) lost = "INPUT_DIGEST_MISMATCH";
  try {
    if (!lost) {
      await admitRepositoryExecutionJob(
        transaction,
        row.organization_id,
        row.job_id,
      );
    }
  } catch (error) {
    if (!(error instanceof StandardError)) throw error;
    lost = "SECRET_POLICY_STALE";
  }
  const parsedProviderResult = SecretIdentityToolResultSchema.parse(
    providerResult,
  );
  if (
    !lost && parsedProviderResult.status === "completed" &&
    parsedProviderResult.accountId !== row.verified_provider_account_id
  ) lost = "SECRET_POLICY_STALE";
  const result = lost
    ? {
      status: "uncertain" as const,
      code: "COMPLETION_AUTHORITY_LOST" as const,
    }
    : parsedProviderResult;
  return await persistTerminal(transaction, row, result, "in_flight");
}
