import { assert, assertExists } from "@std/assert";
import type {
  AgentVersionCreateConfig,
  BillingConfig,
} from "../../packages/contracts/src/contracts.ts";
import { workerActionCapabilities } from "../../packages/contracts/src/contracts.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import {
  budgetContentDigest,
} from "../../apps/server/src/modules/work/budget.ts";
import { appendDomainEvent } from "../../packages/persistence/src/event-audit.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import type { JobSeed } from "./worker-execution.ts";

export const fundedModelPolicy = {
  installationMonthlyLimitUsd: "1.000000",
  reservationTtlSeconds: 3_600,
  maxRunDurationSeconds: 86_400,
} as const;

const defaultBilling = {
  provider: "openai",
  billingAccountId: "budget-test-account",
  model: "gpt-5.6-luna",
  billingRoute: "api",
  maxTokens: 1_000,
  maxUsdReservation: 0.1,
  pricingMetadataSnapshot: "budget-test-price-v1",
} satisfies BillingConfig;

const defaultProfileConfig = {
  schemaVersion: 1,
  workflow: { kind: "fixed" },
  branches: { base: "main", allowedPatterns: ["feature/*"] },
  worktree: { root: ".bakery/worktrees" },
};

export type AdmissibleRun = Readonly<{
  organizationId: string;
  principalId: string;
  runId: string;
  runStepId: string;
  stepKey: string;
  taskId: string;
  applicationId: string;
  conversationId: string;
  repositoryId: string;
  profileId: string;
  workflowId: string;
  workflowVersionId: string;
  sessionId: string | null;
  action: string;
  input: Record<string, unknown>;
  agent: Record<string, unknown> | null;
  billing: BillingConfig | null;
  profile: Record<string, unknown>;
  contentDigest: string;
}>;

export type AdmittedRun =
  & AdmissibleRun
  & Readonly<{
    jobId: string;
    installationReservationId: string | null;
    runReservationId: string | null;
    intentId: string | null;
  }>;

export type AdmittedJob =
  & AdmittedRun
  & Readonly<{
    installationReservationId: string;
    runReservationId: string;
    intentId: string;
  }>;

export type AdmissibleRunOptions = Readonly<{
  reservationUsd?: string;
  action?: string;
  billingAccountId?: string;
  stepKey?: string;
  budgetLimitUsd?: string;
  /** Reuse an existing application instead of creating a fresh one. */
  applicationId?: string;
  input?: Record<string, unknown>;
  agentConfig?: AgentVersionCreateConfig | null;
  skillRefs?: readonly { versionId: string; digest: string }[];
}>;

export type AdmissionOptions = Readonly<{
  maxAttempts?: number;
  priority?: number;
  capabilities?: readonly string[];
}>;

export type FundedModelJobOptions =
  & AdmissibleRunOptions
  & Readonly<{
    priority?: number;
    capabilities?: readonly string[];
    maxAttempts?: number;
  }>;

/** Seeds a workflow run and admits it through the production repository path. */
export async function seedAdmissibleRun(
  database: PgDatabase,
  organizationId: string,
  principalId: string,
  options: AdmissibleRunOptions = {},
): Promise<AdmissibleRun> {
  const action = options.action ?? "harness.implement";
  const actionCapabilities = [...workerActionCapabilities(action)];
  const isModelAction = actionCapabilities.includes("model");
  const stepKey = options.stepKey ?? `model-${crypto.randomUUID()}`;
  const runId = crypto.randomUUID();
  const runStepId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const applicationId = options.applicationId ?? crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const suppliedRepositoryId = typeof options.input?.repositoryId === "string"
    ? options.input.repositoryId
    : undefined;
  const repositoryId = suppliedRepositoryId ?? crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const workflowVersionId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const agentVersionId = crypto.randomUUID();
  const skillRefs = [...(options.skillRefs ?? [])];
  const reservationUsd = options.reservationUsd ?? "0.1";
  const agentConfig = options.agentConfig === undefined
    ? (isModelAction
      ? {
        harness: "pi" as const,
        billing: {
          ...defaultBilling,
          billingAccountId: options.billingAccountId ??
            defaultBilling.billingAccountId,
          maxUsdReservation: Number(reservationUsd),
        },
        ...(skillRefs.length === 0 ? {} : {
          skillBindings: Object.fromEntries(
            skillRefs.map((ref, index) => [`fixture-${index}`, ref.versionId]),
          ),
        }),
      }
      : null)
    : options.agentConfig;
  const agentDigest = agentConfig === null
    ? null
    : await sha256Hex(canonicalJson(agentConfig));
  const input = options.input ??
    (action === "harness.implement"
      ? { repositoryId, planArtifact: crypto.randomUUID() }
      : isModelAction
      ? { repositoryId, planArtifact: crypto.randomUUID() }
      : { repositoryId, revision: "a".repeat(40), checks: ["fmt"] });
  const profileDigest = await sha256Hex(canonicalJson(defaultProfileConfig));
  const profile = {
    organizationId,
    applicationId,
    repositoryId,
    id: profileId,
    revision: 1,
    digest: profileDigest,
    config: defaultProfileConfig,
    observationId: null,
    observationDigest: null,
    baseSha: null,
  };
  const spec = {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: `funded-${runId.slice(0, 8)}`,
    workflow: { kind: "fixed" },
    ...(agentVersionId && agentConfig !== null
      ? { agents: { [action]: agentVersionId } }
      : {}),
    steps: [{ id: stepKey, uses: action, with: input }],
  };
  const workflowDigest = await sha256Hex(canonicalJson(spec));
  const agent = agentConfig === null ? null : {
    agentVersionId,
    revision: 1,
    digest: agentDigest,
    config: agentConfig,
    skillRefs,
  };
  const snapshot = {
    schemaVersion: 1,
    executionMode: "repository",
    inputs: {},
    workflow: {
      id: workflowVersionId,
      revision: 1,
      digest: workflowDigest,
      normalizedSpec: spec,
    },
    repositoryProfile: profile,
    stepAgents: agent === null ? {} : { [stepKey]: agent },
    admission: { dependencies: [], status: "queued", reason: null },
  };

  if (options.applicationId === undefined) {
    await database.query(
      `insert into bakery.applications (id, organization_id, slug, name)
       values ($1, $2, $3, $4)`,
      [
        applicationId,
        organizationId,
        `funded-${runId}`,
        "Funded worker fixture",
      ],
    );
  }
  await database.query(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch
     ) values ($1, $2, $3, $4, $5, 'funded-test', $5, 'main')`,
    [
      repositoryId,
      organizationId,
      applicationId,
      crypto.randomUUID(),
      `funded-${runId}`,
    ],
  );
  await database.query(
    `insert into bakery.repository_profiles (
       id, organization_id, application_id, repository_id, revision, config,
       digest, created_by
     ) values ($1, $2, $3, $4, 1, $5::jsonb, $6, $7)`,
    [
      profileId,
      organizationId,
      applicationId,
      repositoryId,
      JSON.stringify(defaultProfileConfig),
      profileDigest,
      principalId,
    ],
  );
  await database.query(
    `insert into bakery.conversations (
       id, organization_id, application_id, repository_id, title, created_by
     ) values ($1, $2, $3, $4, $5, $6)`,
    [
      conversationId,
      organizationId,
      applicationId,
      repositoryId,
      `Funded ${runId}`,
      principalId,
    ],
  );
  await database.query(
    `insert into bakery.tasks (
       id, organization_id, application_id, repository_id, conversation_id,
       title, description, task_type, status, priority, created_by,
       repository_profile_id, repository_profile_revision,
       repository_profile_digest
     ) values ($1, $2, $3, $4, $5, $6, '', 'feature', 'queued', 50,
               $7, $8, 1, $9)`,
    [
      taskId,
      organizationId,
      applicationId,
      repositoryId,
      conversationId,
      `Funded ${runId}`,
      principalId,
      profileId,
      profileDigest,
    ],
  );
  if (agentConfig !== null && agentDigest !== null) {
    await database.query(
      `insert into bakery.agent_definitions (
         id, organization_id, slug, name, description, enabled
       ) values ($1, $2, $3, $4, '', true)`,
      [agentId, organizationId, `funded-agent-${runId}`, "Funded worker agent"],
    );
    await database.query(
      `insert into bakery.agent_versions (
         id, organization_id, agent_id, revision, config, digest, created_by
       ) values ($1, $2, $3, 1, $4::jsonb, $5, $6)`,
      [
        agentVersionId,
        organizationId,
        agentId,
        JSON.stringify(agentConfig),
        agentDigest,
        principalId,
      ],
    );
  }
  await database.query(
    `insert into bakery.workflow_definitions (
       id, organization_id, slug, name, enabled, version
     ) values ($1, $2, $3, $4, true, 1)`,
    [workflowId, organizationId, `funded-${runId}`, `Funded ${runId}`],
  );
  await database.query(
    `insert into bakery.workflow_versions (
       id, organization_id, workflow_id, revision, source_yaml,
       normalized_spec, digest, status, created_by
     ) values ($1, $2, $3, 1, '', $4::jsonb, $5, 'published', $6)`,
    [
      workflowVersionId,
      organizationId,
      workflowId,
      JSON.stringify(spec),
      workflowDigest,
      principalId,
    ],
  );
  await database.query(
    `update bakery.workflow_definitions set active_version_id = $2
      where organization_id = $1 and id = $3`,
    [organizationId, workflowVersionId, workflowId],
  );
  await database.query(
    `insert into bakery.workflow_runs (
       id, organization_id, task_id, workflow_version_id, requested_by,
       status, snapshot, budget_limit_usd, application_id, repository_id,
       repository_profile_id, repository_profile_revision, repository_profile_digest
     ) values ($1, $2, $3, $4, $5, 'running', $6::jsonb, $7, $8, $9, $10, 1, $11)`,
    [
      runId,
      organizationId,
      taskId,
      workflowVersionId,
      principalId,
      JSON.stringify(snapshot),
      options.budgetLimitUsd ?? "1.000000",
      applicationId,
      repositoryId,
      profileId,
      profileDigest,
    ],
  );
  await database.query(
    `update bakery.tasks set current_run_id = $2
      where organization_id = $1 and id = $3`,
    [organizationId, runId, taskId],
  );
  await withPgTransaction(
    database,
    (transaction) =>
      appendDomainEvent(transaction, {
        organizationId,
        applicationId,
        repositoryId,
        taskId,
        conversationId,
        eventType: "run.requested",
        aggregateId: runId,
        aggregateVersion: 1,
        payload: { runId },
        traceId: crypto.randomUUID(),
      }),
  );
  await database.query(
    `insert into bakery.run_steps (
       id, organization_id, run_id, step_key, position, iteration, status, input
     ) values ($1, $2, $3, $4, 1, 0, 'pending', $5::jsonb)`,
    [runStepId, organizationId, runId, stepKey, JSON.stringify(input)],
  );
  const sessionId = agent === null ? null : crypto.randomUUID();
  if (sessionId !== null) {
    await database.query(
      `insert into bakery.agent_sessions (
         id, organization_id, run_step_id, conversation_id, agent_version_id,
         harness, status
       ) values ($1, $2, $3, $4, $5, 'codex', 'active')`,
      [sessionId, organizationId, runStepId, conversationId, agentVersionId],
    );
  }
  const effectiveInput = { ...input, repositoryProfile: profile };
  return {
    organizationId,
    principalId,
    runId,
    runStepId,
    stepKey,
    taskId,
    applicationId,
    conversationId,
    repositoryId,
    profileId,
    workflowId,
    workflowVersionId,
    sessionId,
    action,
    input: effectiveInput,
    agent,
    billing: agentConfig?.billing ?? null,
    profile,
    contentDigest: await budgetContentDigest({
      action,
      actionVersion: workflowVersionId,
      input: effectiveInput,
      agent,
    }),
  };
}

function assertFundedAdmission(
  admission: AdmittedRun,
): asserts admission is AdmittedJob {
  assert(admission.installationReservationId !== null);
  assert(admission.runReservationId !== null);
  assert(admission.intentId !== null);
}

async function admitRun(
  database: PgDatabase,
  run: AdmissibleRun,
  options: AdmissionOptions,
  budgetPolicy: typeof fundedModelPolicy | undefined,
): Promise<AdmittedRun> {
  const repository = budgetPolicy === undefined
    ? createBakeryPostgresWorkflowRepository({
      database,
      maxAttempts: options.maxAttempts ?? 1,
    })
    : createBakeryPostgresWorkflowRepository({
      database,
      maxAttempts: options.maxAttempts ?? 1,
      budgetPolicy,
    });
  const ownerToken = crypto.randomUUID();
  const owner = await repository.acquireEngineOwner(
    run.runId,
    ownerToken,
    60_000,
  );
  assertExists(owner);
  try {
    const admission = await repository.admit({
      runId: run.runId,
      stepKey: run.stepKey,
      iteration: 0,
      actionVersion: run.workflowVersionId,
    }, owner);
    assert(admission.jobId);
    if (options.priority !== undefined || options.capabilities !== undefined) {
      await database.query(
        `update bakery.jobs
            set priority = coalesce($3, priority),
                requirements = coalesce($4::jsonb, requirements),
                updated_at = clock_timestamp()
          where organization_id = $1 and id = $2`,
        [
          run.organizationId,
          admission.jobId,
          options.priority ?? null,
          options.capabilities === undefined
            ? null
            : JSON.stringify({ capabilities: [...options.capabilities] }),
        ],
      );
    }
    const row = (await database.query<{
      jobId: string;
      installationReservationId: string | null;
      runReservationId: string | null;
      intentId: string | null;
    }>(
      `select job.id as "jobId",
              job.installation_reservation_id as "installationReservationId",
              intent.id as "intentId",
              intent.run_reservation_id as "runReservationId"
         from bakery.jobs job
         left join bakery.budget_action_intents intent
           on intent.organization_id = job.organization_id
          and intent.installation_reservation_id = job.installation_reservation_id
        where job.organization_id = $1 and job.id = $2`,
      [run.organizationId, admission.jobId],
    )).rows[0];
    assertExists(row);
    return { ...run, ...row };
  } finally {
    await repository.releaseEngineOwner(owner);
  }
}

/**
 * Admits a funded run whose budget admission the server refuses. Returns the
 * engine's raw admission instead of asserting a job, so a test can read the
 * terminal verdict and the failure the refusal projected onto the run.
 */
export async function admitRefusedFundedModelRun(
  database: PgDatabase,
  run: AdmissibleRun,
): Promise<{ terminal: boolean; jobId?: string }> {
  const repository = createBakeryPostgresWorkflowRepository({
    database,
    maxAttempts: 1,
    budgetPolicy: fundedModelPolicy,
  });
  const owner = await repository.acquireEngineOwner(
    run.runId,
    crypto.randomUUID(),
    60_000,
  );
  assertExists(owner);
  try {
    return await repository.admit({
      runId: run.runId,
      stepKey: run.stepKey,
      iteration: 0,
      actionVersion: run.workflowVersionId,
    }, owner);
  } finally {
    await repository.releaseEngineOwner(owner).catch(() => undefined);
  }
}

/** Admits against the exact funded policy without changing pricing state. */
export async function admitAdmissibleRun(
  database: PgDatabase,
  run: AdmissibleRun,
  options: AdmissionOptions = {},
): Promise<AdmittedRun> {
  return await admitRun(database, run, options, fundedModelPolicy);
}

/** Admits valid nonmodel work without installing a budget policy. */
export async function admitWithoutBudget(
  database: PgDatabase,
  run: AdmissibleRun,
  options: AdmissionOptions = {},
): Promise<AdmittedRun> {
  return await admitRun(database, run, options, undefined);
}

export async function admitFundedModelRun(
  database: PgDatabase,
  run: AdmissibleRun,
  options: AdmissionOptions = {},
): Promise<AdmittedJob> {
  assert(run.billing !== null);
  const admission = await admitAdmissibleRun(database, run, options);
  assertFundedAdmission(admission);
  return admission;
}

export async function seedFundedModelJob(
  database: PgDatabase,
  organizationId: string,
  principalId: string,
  options: FundedModelJobOptions = {},
): Promise<JobSeed> {
  const run = await seedAdmissibleRun(database, organizationId, principalId, {
    ...options,
    stepKey: options.stepKey ?? "worker",
  });
  const sessionId = run.sessionId;
  const billing = run.billing;
  if (!run.agent || billing === null || sessionId === null) {
    throw new Error("FUNDED_MODEL_FIXTURE_REQUIRES_MODEL_AGENT");
  }
  await seedProviderPricingSnapshot(database, { billing });
  const admitted = await admitFundedModelRun(database, run, {
    maxAttempts: options.maxAttempts ?? 3,
    priority: options.priority ?? 50,
    capabilities: options.capabilities,
  });
  return {
    applicationId: admitted.applicationId,
    conversationId: admitted.conversationId,
    taskId: admitted.taskId,
    workflowId: admitted.workflowId,
    workflowVersionId: admitted.workflowVersionId,
    runId: admitted.runId,
    runStepId: admitted.runStepId,
    sessionId,
    jobId: admitted.jobId,
  };
}

export async function seedProviderPricingSnapshot(
  database: PgDatabase,
  options: Readonly<{ billing?: BillingConfig }> = {},
): Promise<void> {
  const billing = options.billing ?? defaultBilling;
  await database.query(
    `insert into bakery.provider_pricing_snapshots (
       provider, billing_account_id, model, billing_type,
       pricing_metadata_snapshot, source_reference, effective_from
     ) values ($1, $2, $3, $4, $5, $6, clock_timestamp())
     on conflict (
       provider, billing_account_id, model, billing_type,
       pricing_metadata_snapshot
     ) do update set status = 'active', effective_until = null,
                     updated_at = clock_timestamp()`,
    [
      billing.provider,
      billing.billingAccountId,
      billing.model,
      billing.billingRoute,
      billing.pricingMetadataSnapshot,
      "test-provider-pricing-fixture",
    ],
  );
}
