import { REPOSITORY_INSPECTION_LIMITS as LIMITS } from "@bakery/config";
import {
  type RepositoryInspectionJobInput,
  RepositoryInspectionJobInputSchema,
  type RepositoryInspectionReceipt,
  RepositoryInspectionReceiptSchema,
  type RepositoryInspectionReport,
  RepositoryInspectionReportSchema,
  RepositoryProfileObservationPayloadSchema,
  RepositoryVersionedProfileConfigSchema,
} from "@bakery/contracts/repository-inspection";
import { StandardError } from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
} from "@bakery/persistence/event-audit";
import type { PgTransactionClient } from "@bakery/persistence";
import {
  inspectionEvidenceIsCoherent,
  repositoryInspectionReadiness,
} from "@bakery/persistence/repository-admission";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import type {
  AttemptRow,
  RequestMetadata,
  WorkerIdentity,
} from "../execution/shared.ts";
import { lockInspectionRepository } from "./onboarding.ts";
import { profileDigest } from "./postgres.ts";
import { createTrustedRepositoryResolver } from "../knowledge/import.ts";

type InspectionRow = {
  id: string;
  application_id: string;
  repository_id: string;
  baseline_profile_id: string;
  baseline_revision: number;
  baseline_digest: string;
  requested_by: string;
  input: unknown;
  input_digest: string;
  job_input: unknown;
  source_envelope: string;
  source_attempt_id: string | null;
  source_next_offset: number;
  published_profile_id: string | null;
  observation_id: string | null;
};

export async function loadInspection(
  transaction: PgTransactionClient,
  attempt: AttemptRow,
): Promise<{ row: InspectionRow; input: RepositoryInspectionJobInput }> {
  const result = await transaction.query<InspectionRow>(
    `select o.id, o.application_id, o.repository_id, o.requested_by,
            o.input, o.input_digest, j.input as job_input,
            j.repository_profile_id as baseline_profile_id,
            j.repository_profile_revision as baseline_revision,
            j.repository_profile_digest as baseline_digest,
            o.source_envelope, o.source_attempt_id, o.source_next_offset,
            o.published_profile_id, o.observation_id
       from bakery.repository_onboardings o
       join bakery.jobs j on j.organization_id = o.organization_id and j.id = o.job_id
      where o.organization_id = $1 and o.job_id = $2
        and j.action = 'repository.inspect' and j.run_step_id is null
        and j.application_id = o.application_id and j.repository_id = o.repository_id
      for update of o`,
    [attempt.organization_id, attempt.job_id],
  );
  const row = result.rows[0];
  const parsed = RepositoryInspectionJobInputSchema.safeParse(row?.input);
  if (!row || !parsed.success) {
    throw new StandardError({ code: "VALIDATION_FAILED" });
  }
  const input = parsed.data;
  const encoded = canonicalJson(input);
  if (
    input.inspectionId !== row.id || input.jobId !== attempt.job_id ||
    input.organizationId !== attempt.organization_id ||
    input.applicationId !== row.application_id ||
    input.repositoryId !== row.repository_id ||
    input.baseline.profileId !== row.baseline_profile_id ||
    input.baseline.revision !== row.baseline_revision ||
    input.baseline.digest !== row.baseline_digest ||
    canonicalJson(row.job_input) !== encoded ||
    await sha256Hex(encoded) !== row.input_digest
  ) {
    throw new StandardError({ code: "VALIDATION_FAILED" });
  }
  return { row, input };
}

export async function inspectionReceipt(
  transaction: PgTransactionClient,
  attempt: AttemptRow,
  input: RepositoryInspectionJobInput,
): Promise<RepositoryInspectionReceipt> {
  const result = await transaction.query<
    { expires_at: Date; server_time: Date }
  >(
    `select created_at + $4::double precision * interval '1 millisecond' as expires_at,
            clock_timestamp() as server_time from bakery.job_attempts
      where organization_id = $1 and id = $2 and job_id = $3`,
    [attempt.organization_id, attempt.id, input.jobId, LIMITS.durationMs],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (row.server_time >= row.expires_at) {
    throw new StandardError({ code: "LEASE_EXPIRED" });
  }
  return RepositoryInspectionReceiptSchema.parse({
    inspectionId: input.inspectionId,
    jobId: input.jobId,
    organizationId: input.organizationId,
    applicationId: input.applicationId,
    repositoryId: input.repositoryId,
    inputDigest: await sha256Hex(canonicalJson(input)),
    source: input.source,
    attemptId: attempt.id,
    fence: String(attempt.fence),
    workerHostId: attempt.worker_host_id,
    workerSessionId: attempt.worker_session_id,
    workerSessionGeneration: String(attempt.worker_session_generation),
    expiresAt: row.expires_at.toISOString(),
  });
}

function invalidReport(): never {
  throw new StandardError({ code: "VALIDATION_FAILED" });
}

// Shape validation is not authority or readiness. Match every identity and
// result against the saved server policy before deriving eligible/blocked.
export function verifyInspectionReport(
  input: RepositoryInspectionJobInput,
  receipt: RepositoryInspectionReceipt,
  identity: WorkerIdentity,
  value: unknown,
): RepositoryInspectionReport {
  const parsed = RepositoryInspectionReportSchema.safeParse(value);
  if (!parsed.success) invalidReport();
  const report = parsed.data;
  if (
    report.host.workerHostId !== identity.host.id ||
    report.host.os !== identity.host.os ||
    report.host.architecture !== identity.host.architecture ||
    !inspectionEvidenceIsCoherent(input, receipt, report)
  ) invalidReport();
  return report;
}

export async function publishInspection(
  transaction: PgTransactionClient,
  attempt: AttemptRow,
  identity: WorkerIdentity,
  value: unknown,
  metadata: RequestMetadata,
): Promise<void> {
  const { row, input } = await loadInspection(transaction, attempt);
  const receipt = await inspectionReceipt(transaction, attempt, input);
  const report = verifyInspectionReport(input, receipt, identity, value);
  if (
    row.published_profile_id !== null || row.observation_id !== null ||
    row.source_attempt_id !== attempt.id ||
    row.source_next_offset !== input.source.envelopeBytes
  ) invalidReport();
  const repository = await lockInspectionRepository(
    transaction,
    input.organizationId,
    input.repositoryId,
  );
  if (
    repository.application_id !== input.applicationId ||
    repository.version !== input.baseline.repositoryVersion ||
    repository.default_branch !== input.baseline.defaultBranch ||
    repository.active_profile_id !== input.baseline.profileId
  ) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const mapping = await createTrustedRepositoryResolver().resolve({
    organizationId: input.organizationId,
    applicationId: input.applicationId,
    repositoryUuid: input.repositoryId,
  });
  if (
    mapping.mappingRevision !== input.source.mappingRevision ||
    mapping.mappingDigest !== input.source.mappingDigest ||
    mapping.snapshotSha !== input.source.baseSha
  ) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const baseline = await transaction.query<
    { revision: number; digest: string; config: unknown }
  >(
    `select revision, digest, config from bakery.repository_profiles
      where organization_id = $1 and application_id = $2 and repository_id = $3 and id = $4`,
    [
      input.organizationId,
      input.applicationId,
      input.repositoryId,
      input.baseline.profileId,
    ],
  );
  const current = baseline.rows[0];
  const config = RepositoryVersionedProfileConfigSchema.safeParse(
    current?.config,
  );
  const maximum = await transaction.query<{ max: number }>(
    `select coalesce(max(revision), 0) as max from bakery.repository_profiles
      where organization_id = $1 and repository_id = $2`,
    [input.organizationId, input.repositoryId],
  );
  if (
    !current || !config.success ||
    current.revision !== input.baseline.revision ||
    current.digest !== input.baseline.digest ||
    await profileDigest(config.data) !== current.digest ||
    config.data.branches.base !== repository.default_branch ||
    input.profile.revision !== (maximum.rows[0]?.max ?? 0) + 1 ||
    await profileDigest(input.profile.config) !== input.profile.digest ||
    (input.profile.config.fixedPolicy !== undefined &&
      input.profile.config.fixedPolicy.trustedChecker.configDigest !==
        await profileDigest(input.profile.config.checkPolicy))
  ) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  const readiness = repositoryInspectionReadiness(input, report);
  const payload = RepositoryProfileObservationPayloadSchema.parse({
    schemaVersion: 1,
    inspectionId: input.inspectionId,
    jobId: input.jobId,
    organizationId: input.organizationId,
    applicationId: input.applicationId,
    repositoryId: input.repositoryId,
    profileId: input.profile.id,
    profileRevision: input.profile.revision,
    profileDigest: input.profile.digest,
    source: input.source,
    receipt,
    host: report.host,
    checks: report.checks,
    readiness,
    observedAt: report.completedAt,
  });
  const observationId = crypto.randomUUID();
  const observationDigest = await sha256Hex(canonicalJson(payload));
  await transaction.query(
    `insert into bakery.repository_profiles (
       id, organization_id, application_id, repository_id, revision, config, digest, created_by
     ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      input.profile.id,
      input.organizationId,
      input.applicationId,
      input.repositoryId,
      input.profile.revision,
      canonicalJson(input.profile.config),
      input.profile.digest,
      row.requested_by,
    ],
  );
  await transaction.query(
    `insert into bakery.repository_profile_observations (
       id, organization_id, application_id, repository_id, profile_id, profile_revision,
       profile_digest, observation_digest, observed_at, source_mapping_revision,
       source_mapping_digest, base_sha, payload, readiness
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
    [
      observationId,
      input.organizationId,
      input.applicationId,
      input.repositoryId,
      input.profile.id,
      input.profile.revision,
      input.profile.digest,
      observationDigest,
      report.completedAt,
      input.source.mappingRevision,
      input.source.mappingDigest,
      input.source.baseSha,
      canonicalJson(payload),
      readiness,
    ],
  );
  if (readiness === "eligible") {
    const activated = await transaction.query(
      `update bakery.repositories set active_profile_id = $5, version = version + 1, updated_at = now()
        where organization_id = $1 and application_id = $2 and id = $3 and version = $4
          and active_profile_id = $6 and default_branch = $7 and archived_at is null returning id`,
      [
        input.organizationId,
        input.applicationId,
        input.repositoryId,
        input.baseline.repositoryVersion,
        input.profile.id,
        input.baseline.profileId,
        input.baseline.defaultBranch,
      ],
    );
    if (activated.rows.length !== 1) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    await appendDomainEvent(transaction, {
      organizationId: input.organizationId,
      applicationId: input.applicationId,
      repositoryId: input.repositoryId,
      eventType: "repositories.updated",
      aggregateId: input.repositoryId,
      aggregateVersion: repository.version + 1,
      payload: {
        resourceId: input.repositoryId,
        resourceVersion: repository.version + 1,
      },
      traceId: metadata.traceId,
    });
  }
  const published = await transaction.query(
    `update bakery.repository_onboardings set published_profile_id = $3, observation_id = $4,
            published_profile_revision = $5, published_profile_digest = $6,
            observation_digest = $7, base_sha = $8, updated_at = now()
      where organization_id = $1 and id = $2 and published_profile_id is null and observation_id is null
      returning id`,
    [
      input.organizationId,
      input.inspectionId,
      input.profile.id,
      observationId,
      input.profile.revision,
      input.profile.digest,
      observationDigest,
      input.source.baseSha,
    ],
  );
  if (published.rows.length !== 1) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  await appendDomainEvent(transaction, {
    organizationId: input.organizationId,
    applicationId: input.applicationId,
    repositoryId: input.repositoryId,
    eventType: "repository.profile_created",
    aggregateId: input.profile.id,
    aggregateVersion: 1,
    payload: { resourceId: input.profile.id, resourceVersion: 1 },
    traceId: metadata.traceId,
  });
  await appendAudit(transaction, {
    organizationId: input.organizationId,
    principalId: identity.host.principal_id,
    operation: "repositoryObservations.publish",
    resourceType: "repository_profile_observation",
    resourceId: observationId,
    requestId: metadata.requestId,
    traceId: metadata.traceId,
    details: {
      inspectionId: input.inspectionId,
      jobId: input.jobId,
      readiness,
    },
  });
}
