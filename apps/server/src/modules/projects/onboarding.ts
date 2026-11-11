import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  RepositoryInspectionJobInputSchema,
  RepositoryProfileObservationPayloadSchema,
  RepositoryVersionedProfileConfigSchema,
} from "@bakery/contracts/repository-inspection";
import {
  appendAudit,
  appendDomainEvent,
} from "@bakery/persistence/event-audit";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { createTrustedRepositoryResolver } from "../knowledge/import.ts";
import {
  deriveRepositoryInspectionConfig,
  inspectTrustedRepositorySource,
  repositoryInspectionSourceMetadata,
} from "./repository-inspect.ts";
import {
  encodedByteLength,
  inspectionInputWithinBudget,
} from "./inspection-budget.ts";
import { profileDigest } from "./postgres.ts";
import type { PgTransactionClient } from "@bakery/persistence";
import { requireWorkTransaction } from "../work/work-transaction.ts";

type LockedRepository = {
  id: string;
  application_id: string;
  default_branch: string;
  active_profile_id: string | null;
  archived_at: Date | null;
  version: number;
};

// Shared application lock must precede the repository update lock, as in
// manual profile creation and run admission.
export async function lockInspectionRepository(
  transaction: PgTransactionClient,
  organizationId: string,
  repositoryId: string,
): Promise<LockedRepository> {
  const application = await transaction.query<{
    id: string;
    archived_at: Date | null;
  }>(
    `select a.id, a.archived_at
       from bakery.applications a
       join bakery.repositories r
         on r.organization_id = a.organization_id and r.application_id = a.id
      where r.organization_id = $1 and r.id = $2
      for share of a`,
    [organizationId, repositoryId],
  );
  const app = application.rows[0];
  if (!app) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const result = await transaction.query<LockedRepository>(
    `select id, application_id, default_branch, active_profile_id, archived_at, version
       from bakery.repositories
      where organization_id = $1 and application_id = $2 and id = $3
      for update`,
    [organizationId, app.id, repositoryId],
  );
  const repository = result.rows[0];
  if (!repository) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (app.archived_at !== null || repository.archived_at !== null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "repository_unavailable" },
    });
  }
  return repository;
}

function pathId(context: ActionContext): string {
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return id;
}
export async function onboardRepository(context: ActionContext) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const repositoryId = pathId(context);
  const repository = await lockInspectionRepository(
    transaction,
    organizationId,
    repositoryId,
  );
  const inflight = await transaction.query(
    `select o.id from bakery.repository_onboardings o
       join bakery.jobs j on j.organization_id = o.organization_id and j.id = o.job_id
      where o.organization_id = $1 and o.repository_id = $2
        and j.status not in ('completed', 'failed', 'canceled') limit 1`,
    [organizationId, repositoryId],
  );
  if (inflight.rows.length !== 0) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "inspection_in_flight" },
    });
  }
  if (repository.active_profile_id === null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "baseline_required" },
    });
  }
  const baselineResult = await transaction.query<{
    id: string;
    revision: number;
    digest: string;
    config: unknown;
  }>(
    `select id, revision, digest, config from bakery.repository_profiles
      where organization_id = $1 and application_id = $2 and repository_id = $3 and id = $4`,
    [
      organizationId,
      repository.application_id,
      repositoryId,
      repository.active_profile_id,
    ],
  );
  const baseline = baselineResult.rows[0];
  const config = RepositoryVersionedProfileConfigSchema.safeParse(
    baseline?.config,
  );
  if (
    !baseline || !config.success ||
    await profileDigest(config.data) !== baseline.digest ||
    config.data.branches.base !== repository.default_branch
  ) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "baseline_stale" },
    });
  }
  const maximum = await transaction.query<{ max: number }>(
    `select coalesce(max(revision), 0) as max from bakery.repository_profiles
      where organization_id = $1 and repository_id = $2`,
    [organizationId, repositoryId],
  );
  const scope = {
    organizationId,
    applicationId: repository.application_id,
    repositoryId,
  };
  const mapping = await createTrustedRepositoryResolver().resolve({
    organizationId,
    applicationId: repository.application_id,
    repositoryUuid: repositoryId,
  });
  const envelope = await inspectTrustedRepositorySource(
    scope,
    mapping,
    context.signal,
  );
  const observedConfig = deriveRepositoryInspectionConfig(
    config.data,
    envelope,
  );
  const id = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const input = RepositoryInspectionJobInputSchema.parse({
    inspectionId: id,
    jobId,
    ...scope,
    baseline: {
      profileId: baseline.id,
      revision: baseline.revision,
      digest: baseline.digest,
      repositoryVersion: repository.version,
      defaultBranch: repository.default_branch,
    },
    profile: {
      id: crypto.randomUUID(),
      revision: (maximum.rows[0]?.max ?? 0) + 1,
      digest: await profileDigest(observedConfig),
      config: observedConfig,
    },
    source: await repositoryInspectionSourceMetadata(envelope),
  });
  const encodedInput = canonicalJson(input);
  // Leave room in the 64 KiB report for the repeated receipt, bounded host
  // inventory and one worst-case result per server check. Never enqueue an
  // input that the real producer cannot report within the independent cap.
  if (
    !inspectionInputWithinBudget(
      encodedByteLength(encodedInput),
      observedConfig.checkPolicy.checks.length,
    )
  ) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: { reason: "inspection_report_limit" },
    });
  }
  await transaction.query(
    `insert into bakery.jobs (
       id, organization_id, action, input, requirements, status, max_attempts,
       application_id, repository_id, repository_profile_id,
       repository_profile_revision, repository_profile_digest
     ) values ($1, $2, 'repository.inspect', $3::jsonb, '{"capabilities":["git"]}'::jsonb,
               'queued', 1, $4, $5, $6, $7, $8)`,
    [
      jobId,
      organizationId,
      encodedInput,
      repository.application_id,
      repositoryId,
      baseline.id,
      baseline.revision,
      baseline.digest,
    ],
  );
  await transaction.query(
    `insert into bakery.repository_onboardings (
       id, organization_id, application_id, repository_id, job_id, requested_by,
       input, input_digest, source_envelope
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      id,
      organizationId,
      repository.application_id,
      repositoryId,
      jobId,
      principalId,
      encodedInput,
      await sha256Hex(encodedInput),
      canonicalJson(envelope),
    ],
  );
  await appendDomainEvent(transaction, {
    organizationId,
    applicationId: repository.application_id,
    repositoryId,
    eventType: "repository.onboarding_requested",
    aggregateId: id,
    aggregateVersion: 1,
    payload: { resourceId: id, resourceVersion: 1 },
    traceId: context.traceId,
  });
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "repositories.onboard",
    resourceType: "repository_onboarding",
    resourceId: id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { repositoryId, jobId },
  });
  return await getRepositoryOnboarding({
    ...context,
    params: { ...context.params, id },
  });
}

export async function getRepositoryOnboarding(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const result = await transaction.query<{
    id: string;
    repository_id: string;
    job_id: string;
    status: string;
    published_profile_id: string | null;
    observation_id: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `select o.id, o.repository_id, o.job_id, j.status,
            o.published_profile_id, o.observation_id, o.created_at,
            greatest(o.updated_at, j.updated_at) as updated_at
       from bakery.repository_onboardings o
       join bakery.jobs j on j.organization_id = o.organization_id and j.id = o.job_id
      where o.organization_id = $1 and o.id = $2`,
    [organizationId, pathId(context)],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (
    ![
      "queued",
      "leased",
      "running",
      "awaiting_reconciliation",
      "canceling",
      "completed",
      "failed",
      "canceled",
    ].includes(row.status) ||
    (row.published_profile_id === null) !== (row.observation_id === null) ||
    (row.status === "completed") !== (row.published_profile_id !== null)
  ) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  return contractSchemas.RepositoryOnboarding.parse({
    id: row.id,
    repositoryId: row.repository_id,
    jobId: row.job_id,
    status: row.status === "queued"
      ? "queued"
      : ["completed", "failed", "canceled"].includes(row.status)
      ? row.status
      : "running",
    profileId: row.published_profile_id,
    observationId: row.observation_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

export async function getRepositoryObservation(context: ActionContext) {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const result = await transaction.query<{
    id: string;
    application_id: string;
    repository_id: string;
    profile_id: string;
    profile_revision: number;
    profile_digest: string;
    observation_digest: string;
    base_sha: string;
    payload: unknown;
  }>(
    `select id, application_id, repository_id, profile_id, profile_revision, profile_digest,
            observation_digest, base_sha, payload
       from bakery.repository_profile_observations
      where organization_id = $1 and id = $2`,
    [organizationId, pathId(context)],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const parsed = RepositoryProfileObservationPayloadSchema.safeParse(
    row.payload,
  );
  if (
    !parsed.success || parsed.data.organizationId !== organizationId ||
    parsed.data.applicationId !== row.application_id ||
    parsed.data.repositoryId !== row.repository_id ||
    parsed.data.profileId !== row.profile_id ||
    parsed.data.profileRevision !== row.profile_revision ||
    parsed.data.profileDigest !== row.profile_digest ||
    parsed.data.source.baseSha !== row.base_sha ||
    await sha256Hex(canonicalJson(parsed.data)) !== row.observation_digest
  ) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  return contractSchemas.RepositoryProfileObservation.parse({
    id: row.id,
    repositoryId: row.repository_id,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    profileDigest: row.profile_digest,
    observationDigest: row.observation_digest,
    baseSha: row.base_sha,
    payload: parsed.data,
  });
}
