import { z } from "zod";
import { REPOSITORY_EXECUTION_CUTOVER_BATCH_SIZE as BATCH_SIZE } from "@bakery/config";
import {
  RepositoryExecutionContextSchema,
  type RepositoryExecutionRequirements,
  RepositoryExecutionRequirementsSchema,
} from "@bakery/contracts/repository-inspection";
import {
  executionJobInputFitsTransport,
  executionJobInputMatchesSnapshot,
  repositoryExecutionRequirements,
} from "@bakery/persistence/repository-admission";
import {
  canonicalJson,
  sha256Hex,
} from "../../../../platform/canonical-json.ts";
import {
  type DataMigration,
  type DataMigrationConnection,
  runDataMigrationBatch,
} from "../../../../platform/data-migrate.ts";
import { extractFixedWorkflowSteps } from "../../run-steps.ts";

const IdSchema = RepositoryExecutionContextSchema.shape.id.describe(
  "Primary identity of the migration source row and keyset cursor.",
);
const DigestSchema = RepositoryExecutionContextSchema.shape.digest;
const RevisionSchema = RepositoryExecutionContextSchema.shape.revision;
const IdentitySchema = z.object({
  organizationId: IdSchema.describe(
    "Organization owning this stored identity.",
  ),
  applicationId: IdSchema.nullable().describe(
    "Application scope, null only for an established legacy unpinned job.",
  ),
  repositoryId: IdSchema.nullable().describe(
    "Repository scope required for this repository execution cutover.",
  ),
  id: IdSchema.nullable().describe(
    "Stored immutable repository profile identity, absent only for a legacy job.",
  ),
  revision: RevisionSchema.nullable().describe(
    "Stored profile revision, never derived from the active pointer.",
  ),
  digest: DigestSchema.nullable().describe(
    "Stored canonical profile digest, never recomputed into a new pin.",
  ),
  observationId: IdSchema.nullable().describe(
    "Must remain null for genuine strict-v1 execution.",
  ),
  observationDigest: DigestSchema.nullable().describe(
    "Must remain null for strict-v1 execution without observed evidence.",
  ),
  baseSha: RepositoryExecutionContextSchema.shape.baseSha.describe(
    "Null strict-v1 source pin; v2 is excluded from this migration.",
  ),
}).strict().describe(
  "Tenant-scoped relational execution identity before any data repair.",
);
const SourceRowSchema = z.object({
  id: IdSchema,
  snapshot: z.json().describe(
    "Original frozen run snapshot, preserved except for its old v1 repository context.",
  ),
  runIdentity: IdentitySchema.describe("Frozen relational run identity."),
  taskIdentity: IdentitySchema.describe(
    "Same-tenant task identity which originally authorized the run.",
  ),
  profileIdentity: IdentitySchema.describe(
    "Same-tenant immutable profile identity; no current active profile lookup.",
  ),
  profileConfig: z.json().describe(
    "Original immutable profile config independently checked against its canonical digest.",
  ),
  workflow: z.object({
    id: IdSchema.describe(
      "Immutable published workflow version referenced by the run.",
    ),
    revision: RevisionSchema.describe("Frozen workflow revision."),
    digest: DigestSchema.describe("Canonical normalized workflow digest."),
    normalizedSpec: z.json().describe(
      "Published fixed workflow document matching the frozen snapshot.",
    ),
    status: z.string().min(1).describe(
      "Persisted workflow publication state; only published versions are eligible.",
    ),
  }).strict().describe(
    "Original same-tenant workflow authority rather than caller snapshot metadata.",
  ),
  jobIdentity: IdentitySchema.optional().describe(
    "Original job identity when scanning the job phase.",
  ),
  input: z.json().optional().describe(
    "Original job input and all its extras, never rematerialized from current task data.",
  ),
  requirements: z.json().optional().describe(
    "Existing capability/platform requirements and metadata retained unchanged except for missing registered capabilities.",
  ),
  action: z.string().min(1).describe("Original registered worker action.")
    .optional().describe("Present only in the job phase."),
  stepKey: z.string().min(1).max(64).describe(
    "Original same-tenant run-step key.",
  ).optional().describe("Present only in the job phase."),
  stepOutputs: z.json().describe(
    "Latest non-null output per frozen run-step key using materialization ordering.",
  ).optional().describe("Present only in the job phase."),
}).strict().describe(
  "Bounded migration source projection; domain coherence is decided in TypeScript.",
);

type Progress = { phase: "runs" | "jobs"; cursor: string | null };
// The runner retains one reserved connection across bounded calls. A restarted
// process scans again; committed row transformations are themselves idempotent.
const progressByConnection = new WeakMap<DataMigrationConnection, Progress>();

async function migrateBatch(
  connection: DataMigrationConnection,
  progress: Progress,
  beforeCommit: (() => Promise<void>) | undefined,
): Promise<{ cursor: string | null; exhausted: boolean }> {
  return await runDataMigrationBatch(connection, async (transaction) => {
    const identityColumns = transaction.unsafe(`
      run.snapshot,
      jsonb_build_object('organizationId', run.organization_id, 'applicationId', run.application_id,
        'repositoryId', run.repository_id, 'id', run.repository_profile_id,
        'revision', run.repository_profile_revision, 'digest', run.repository_profile_digest,
        'observationId', run.observation_id, 'observationDigest', run.observation_digest, 'baseSha', run.base_sha) as "runIdentity",
      jsonb_build_object('organizationId', task.organization_id, 'applicationId', task.application_id,
        'repositoryId', task.repository_id, 'id', task.repository_profile_id,
        'revision', task.repository_profile_revision, 'digest', task.repository_profile_digest,
        'observationId', task.observation_id, 'observationDigest', task.observation_digest, 'baseSha', task.base_sha) as "taskIdentity",
      jsonb_build_object('organizationId', profile.organization_id, 'applicationId', profile.application_id,
        'repositoryId', profile.repository_id, 'id', profile.id, 'revision', profile.revision, 'digest', profile.digest,
        'observationId', null, 'observationDigest', null, 'baseSha', null) as "profileIdentity",
      profile.config as "profileConfig",
      jsonb_build_object('id', workflow.id, 'revision', workflow.revision, 'digest', workflow.digest,
        'normalizedSpec', workflow.normalized_spec, 'status', workflow.status) as workflow`);
    const rows = progress.phase === "runs"
      ? await transaction`
        select run.id, ${identityColumns}
        from bakery.workflow_runs run
        join bakery.tasks task on task.organization_id = run.organization_id and task.id = run.task_id
        join bakery.repository_profiles profile on profile.organization_id = run.organization_id and profile.id = run.repository_profile_id
        join bakery.workflow_versions workflow on workflow.organization_id = run.organization_id and workflow.id = run.workflow_version_id
        where run.repository_profile_id is not null and (${progress.cursor}::uuid is null or run.id > ${progress.cursor}::uuid)
        order by run.id limit ${BATCH_SIZE} for update of run`
      : await transaction`
        select job.id, ${identityColumns}, job.input, job.requirements, job.action, step.step_key as "stepKey",
          coalesce(outputs.step_outputs, '{}'::jsonb) as "stepOutputs",
          jsonb_build_object('organizationId', job.organization_id, 'applicationId', job.application_id,
            'repositoryId', job.repository_id, 'id', job.repository_profile_id,
            'revision', job.repository_profile_revision, 'digest', job.repository_profile_digest,
            'observationId', job.observation_id, 'observationDigest', job.observation_digest, 'baseSha', job.base_sha) as "jobIdentity"
        from bakery.jobs job
        join bakery.run_steps step on step.organization_id = job.organization_id and step.id = job.run_step_id
        join bakery.workflow_runs run on run.organization_id = step.organization_id and run.id = step.run_id
        join bakery.tasks task on task.organization_id = run.organization_id and task.id = run.task_id
        join bakery.repository_profiles profile on profile.organization_id = run.organization_id and profile.id = run.repository_profile_id
        join bakery.workflow_versions workflow on workflow.organization_id = run.organization_id and workflow.id = run.workflow_version_id
        left join lateral (
          select jsonb_object_agg(previous.step_key, previous.output) as step_outputs
          from (
            select distinct on (previous.step_key) previous.step_key, previous.output
            from bakery.run_steps previous
            where previous.organization_id = step.organization_id
              and previous.run_id = run.id and previous.output is not null
            order by previous.step_key, previous.iteration desc, previous.position desc, previous.id desc
          ) previous
        ) outputs on true
        where run.repository_profile_id is not null and (${progress.cursor}::uuid is null or job.id > ${progress.cursor}::uuid)
        order by job.id limit ${BATCH_SIZE} for update of job`;
    for (const raw of rows) {
      const parsed = SourceRowSchema.safeParse(raw);
      if (!parsed.success) continue;
      const row = parsed.data;
      const snapshot = row.snapshot;
      if (
        snapshot === null || typeof snapshot !== "object" ||
        Array.isArray(snapshot) ||
        snapshot.schemaVersion !== 1 || snapshot.executionMode !== "repository"
      ) continue;
      const old = snapshot.repositoryProfile;
      if (old === null || typeof old !== "object" || Array.isArray(old)) {
        continue;
      }
      if (
        progress.phase === "runs" && (Object.keys(old).length !== 4 ||
          Object.keys(old).some((key) =>
            !["id", "revision", "digest", "config"].includes(key)
          ))
      ) continue;
      const identityJson = canonicalJson(row.runIdentity);
      if (
        identityJson !== canonicalJson(row.taskIdentity) ||
        identityJson !== canonicalJson(row.profileIdentity)
      ) continue;
      const expected = RepositoryExecutionContextSchema.safeParse({
        ...row.profileIdentity,
        config: row.profileConfig,
      });
      if (!expected.success || expected.data.config.schemaVersion !== 1) {
        continue;
      }
      const context = expected.data;
      const configJson = canonicalJson(context.config);
      if (
        canonicalJson(row.profileConfig) !== configJson ||
        await sha256Hex(configJson) !== context.digest
      ) continue;
      const workflow = snapshot.workflow;
      const workflowJson = canonicalJson(row.workflow.normalizedSpec);
      if (
        workflow === null || typeof workflow !== "object" ||
        Array.isArray(workflow) ||
        row.workflow.status !== "published" ||
        workflow.id !== row.workflow.id ||
        workflow.revision !== row.workflow.revision ||
        workflow.digest !== row.workflow.digest ||
        canonicalJson(workflow.normalizedSpec ?? null) !== workflowJson ||
        await sha256Hex(workflowJson) !== row.workflow.digest
      ) continue;
      try {
        extractFixedWorkflowSteps(row.workflow.normalizedSpec, "fixed");
      } catch {
        continue;
      }
      if (progress.phase === "runs") {
        if (
          canonicalJson(old) !==
            canonicalJson({
              id: context.id,
              revision: context.revision,
              digest: context.digest,
              config: context.config,
            })
        ) continue;
        await transaction`
          update bakery.workflow_runs set snapshot = jsonb_set(snapshot, '{repositoryProfile}', ${
          transaction.json(context)
        }, false)
          where organization_id = ${context.organizationId} and id = ${row.id}`;
        continue;
      }
      const input = row.input;
      const requirements = row.requirements;
      const job = row.jobIdentity;
      if (
        !job || canonicalJson(old) !== canonicalJson(context) || !row.action ||
        row.action === "repository.inspect" ||
        input === null || input === undefined || typeof input !== "object" ||
        Array.isArray(input) ||
        Object.hasOwn(input, "repositoryProfile") ||
        (Object.hasOwn(input, "repositoryId") &&
          input.repositoryId !== context.repositoryId) ||
        requirements === null || requirements === undefined ||
        typeof requirements !== "object" || Array.isArray(requirements) ||
        job.organizationId !== context.organizationId ||
        job.repositoryId !== context.repositoryId ||
        job.observationId !== null || job.observationDigest !== null ||
        job.baseSha !== null
      ) continue;
      const unpinned = job.applicationId === null && job.id === null &&
        job.revision === null && job.digest === null;
      if (!unpinned && canonicalJson(job) !== canonicalJson(row.runIdentity)) {
        continue;
      }
      if (
        !row.stepKey ||
        !executionJobInputMatchesSnapshot(
          {
            runSnapshot: snapshot,
            stepKey: row.stepKey,
            stepOutputs: row.stepOutputs,
            repositoryId: row.taskIdentity.repositoryId,
          },
          row.action,
          input,
        )
      ) continue;
      const expandedInput = { ...input, repositoryProfile: context };
      if (!executionJobInputFitsTransport(expandedInput)) continue;
      const stored = RepositoryExecutionRequirementsSchema.safeParse({
        ...requirements,
        capabilities: Object.hasOwn(requirements, "capabilities")
          ? requirements.capabilities
          : [],
      });
      if (!stored.success) continue;
      let required: RepositoryExecutionRequirements;
      try {
        required = repositoryExecutionRequirements(null, row.action);
      } catch {
        continue;
      }
      const capabilities = [...stored.data.capabilities];
      for (const capability of required.capabilities) {
        if (!capabilities.includes(capability)) capabilities.push(capability);
      }
      const updatedRequirements = RepositoryExecutionRequirementsSchema
        .safeParse({ ...requirements, capabilities });
      if (!updatedRequirements.success) continue;
      await transaction`
        update bakery.jobs set application_id = ${context.applicationId}, repository_profile_id = ${context.id},
          repository_profile_revision = ${context.revision}, repository_profile_digest = ${context.digest},
          input = ${transaction.json(expandedInput)},
          requirements = ${transaction.json(updatedRequirements.data)}
        where organization_id = ${context.organizationId} and id = ${row.id}`;
    }
    return {
      cursor: rows.length === 0
        ? progress.cursor
        : IdSchema.parse(rows[rows.length - 1]!.id),
      exhausted: rows.length < BATCH_SIZE,
    };
  }, beforeCommit);
}

export const frozenExecutionContextBackfill: DataMigration = {
  version: "0049_issue46_frozen_execution_context",
  source: new URL(import.meta.url),
  async run(connection, options): Promise<boolean> {
    let progress = progressByConnection.get(connection) ??
      { phase: "runs" as const, cursor: null };
    for (let batch = 0; batch < options.maxBatches; batch += 1) {
      const result = await migrateBatch(
        connection,
        progress,
        options.beforeCommit,
      );
      if (result.exhausted && progress.phase === "jobs") {
        progressByConnection.delete(connection);
        return true;
      }
      progress = result.exhausted
        ? { phase: "jobs", cursor: null }
        : { ...progress, cursor: result.cursor };
      progressByConnection.set(connection, progress);
    }
    return false;
  },
};
