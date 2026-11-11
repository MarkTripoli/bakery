import { assert, assertEquals } from "@std/assert";
import { agentVersionDigest } from "../../apps/server/src/modules/agents/postgres.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import type { BillingConfig } from "../../packages/contracts/src/contracts.ts";
import { authTestOrigin } from "./auth.ts";
import { seedProviderPricingSnapshot } from "./funded-model-job.ts";
import type { WorkerFixture, WorkerScope } from "./worker-execution.ts";

/** Server budget policy so preset availability and implement admission can run. */
export const presetBudgetEnv = Object.freeze({
  BAKERY_BUDGET_INSTALLATION_MONTHLY_LIMIT_USD: "100",
  BAKERY_BUDGET_RESERVATION_TTL_SECONDS: "3600",
  BAKERY_BUDGET_MAX_RUN_DURATION_SECONDS: "86400",
});

export const presetBudgetPolicy = Object.freeze({
  installationMonthlyLimitUsd: "100",
  reservationTtlSeconds: 3_600,
  maxRunDurationSeconds: 86_400,
});

export type PresetScope = Pick<
  WorkerScope,
  "organizationId" | "principalId" | "adminCookie"
>;

export type PresetRepository = Readonly<{
  organizationId: string;
  applicationId: string;
  repositoryId: string;
  profileId: string;
  profileDigest: string;
  agentVersionId: string | null;
}>;

export type PresetTask = Readonly<{
  id: string;
  conversationId: string;
}>;

export function presetBilling(
  label: string,
  maxUsdReservation = 1,
): BillingConfig {
  return {
    provider: "preset-provider",
    billingAccountId: `preset-account-${label}`,
    model: "preset-model",
    billingRoute: "api",
    maxTokens: 1_000,
    maxUsdReservation,
    pricingMetadataSnapshot: `preset-price-${label}`,
  };
}

export async function apiCall(
  fixture: Pick<WorkerFixture, "app">,
  scope: PresetScope,
  method: "GET" | "POST" | "PATCH",
  path: string,
  options: {
    body?: unknown;
    idempotencyKey?: string;
    headers?: HeadersInit;
    cookie?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers({
    cookie: options.cookie ?? scope.adminCookie,
    origin: authTestOrigin,
    "Bakery-Organization-Id": scope.organizationId,
    ...(options.headers ?? {}),
  });
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (method !== "GET") {
    headers.set(
      "Idempotency-Key",
      options.idempotencyKey ?? crypto.randomUUID(),
    );
  }
  return await fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers,
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
    }),
  );
}

export async function expectJson<T>(
  response: Response,
  status: number,
): Promise<T> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as T;
}

/** Creates an agent and one immutable version through the real API. */
export async function createCodingAgent(
  fixture: Pick<WorkerFixture, "app">,
  scope: PresetScope,
  label: string,
  config: Record<string, unknown>,
): Promise<string> {
  const agent = await expectJson<{ id: string }>(
    await apiCall(fixture, scope, "POST", "/v1/agents", {
      body: {
        slug: `preset-agent-${label}`,
        name: `Preset coding agent ${label}`,
        description: "Coding agent bound to the fixed coding preset.",
      },
    }),
    201,
  );
  const version = await expectJson<{ id: string }>(
    await apiCall(fixture, scope, "POST", `/v1/agents/${agent.id}/versions`, {
      body: {
        revision: 1,
        config,
        digest: await agentVersionDigest(config),
      },
    }),
    201,
  );
  return version.id;
}

/**
 * Application, repository and active v1 profile rows. Rows are inserted with
 * the owner role because repository onboarding needs a provider; agents and
 * tasks still come from the real API.
 */
export async function seedPresetRepository(
  database: PgDatabase,
  scope: PresetScope,
  options: {
    agentVersionId?: string | null;
    profileExtra?: Record<string, unknown>;
    repositoryArchived?: boolean;
    applicationArchived?: boolean;
    noActiveProfile?: boolean;
  } = {},
): Promise<PresetRepository> {
  const applicationId = crypto.randomUUID();
  const repositoryId = crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const agentVersionId = options.agentVersionId ?? null;
  const config = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
    ...(agentVersionId === null
      ? {}
      : { agentBindings: { "harness.implement": agentVersionId } }),
    ...options.profileExtra,
  };
  const profileDigest = await sha256Hex(canonicalJson(config));
  await database.query(
    `insert into bakery.applications (id, organization_id, slug, name)
     values ($1, $2, $3, 'Preset application')`,
    [applicationId, scope.organizationId, `preset-${applicationId}`],
  );
  await database.query(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch
     ) values ($1, $2, $3, $4, $5, 'preset-owner', $5, 'main')`,
    [
      repositoryId,
      scope.organizationId,
      applicationId,
      crypto.randomUUID(),
      `preset-${repositoryId}`,
    ],
  );
  await database.query(
    `insert into bakery.repository_profiles (
       id, organization_id, application_id, repository_id, revision, config,
       digest, created_by
     ) values ($1, $2, $3, $4, 1, $5::jsonb, $6, $7)`,
    [
      profileId,
      scope.organizationId,
      applicationId,
      repositoryId,
      JSON.stringify(config),
      profileDigest,
      scope.principalId,
    ],
  );
  if (options.noActiveProfile !== true) {
    await database.query(
      `update bakery.repositories set active_profile_id = $3
        where organization_id = $1 and id = $2`,
      [scope.organizationId, repositoryId, profileId],
    );
  }
  if (options.repositoryArchived === true) {
    await archive(database, "repositories", scope.organizationId, repositoryId);
  }
  if (options.applicationArchived === true) {
    await archive(
      database,
      "applications",
      scope.organizationId,
      applicationId,
    );
  }
  return {
    organizationId: scope.organizationId,
    applicationId,
    repositoryId,
    profileId,
    profileDigest,
    agentVersionId,
  };
}

async function archive(
  database: PgDatabase,
  table: "repositories" | "applications",
  organizationId: string,
  id: string,
): Promise<void> {
  await database.query(
    `update bakery.${table} set archived_at = now()
      where organization_id = $1 and id = $2`,
    [organizationId, id],
  );
}

export async function createPresetTask(
  fixture: Pick<WorkerFixture, "app">,
  scope: PresetScope,
  repository: PresetRepository,
  options: {
    title?: string;
    description?: string;
    taskType?: "feature" | "bug" | "epic" | "maintenance";
    idempotencyKey?: string;
  } = {},
): Promise<PresetTask> {
  const task = await expectJson<{ id: string; conversationId: string }>(
    await apiCall(fixture, scope, "POST", "/v1/tasks", {
      idempotencyKey: options.idempotencyKey,
      body: {
        applicationId: repository.applicationId,
        repositoryId: repository.repositoryId,
        repositoryProfileId: repository.profileId,
        taskType: options.taskType ?? "feature",
        title: options.title ?? "Add upload retry",
        description: options.description ?? "Retry failed uploads twice.",
      },
    }),
    201,
  );
  return { id: task.id, conversationId: task.conversationId };
}

export function presetRunBody(
  repository: PresetRepository,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    presetId: "fixed-coding",
    executionMode: "repository",
    repositoryProfileId: repository.profileId,
    ...extra,
  };
}

export async function startPresetRun(
  fixture: Pick<WorkerFixture, "app">,
  scope: PresetScope,
  task: PresetTask,
  repository: PresetRepository,
  options: { idempotencyKey?: string; extra?: Record<string, unknown> } = {},
): Promise<Response> {
  return await apiCall(fixture, scope, "POST", `/v1/tasks/${task.id}/runs`, {
    idempotencyKey: options.idempotencyKey,
    body: presetRunBody(repository, options.extra),
  });
}

/** Funded coding agent plus priced billing, so `ready` is a real verdict. */
export async function seedFundedCodingAgent(
  fixture: Pick<WorkerFixture, "app" | "pgDatabase">,
  scope: PresetScope,
  label: string,
  options: { maxUsdReservation?: number; priced?: boolean } = {},
): Promise<string> {
  const billing = presetBilling(label, options.maxUsdReservation);
  if (options.priced !== false) {
    await seedProviderPricingSnapshot(fixture.pgDatabase, { billing });
  }
  return await createCodingAgent(fixture, scope, label, {
    harness: "codex",
    billing,
  });
}

export type PresetAdmission = Readonly<{
  runId: string;
  briefStepId: string;
  implementStepId: string;
  implementJobId: string;
  /** The version the brief step recorded as its completed output. */
  briefVersionId: string;
}>;

/**
 * Drives a started run through the production engine repository: admits the
 * brief step, records its artifact output as the worker would, then admits the
 * implement step. Returns the implement job the worker would claim.
 */
export async function admitPresetRun(
  database: PgDatabase,
  scope: PresetScope,
  run: { id: string; workflowVersionId: string },
  options: { budgetPolicy?: typeof presetBudgetPolicy } = {},
): Promise<PresetAdmission> {
  const repository = createBakeryPostgresWorkflowRepository({
    database,
    maxAttempts: 1,
    budgetPolicy: options.budgetPolicy ?? presetBudgetPolicy,
  });
  const owner = await repository.acquireEngineOwner(
    run.id,
    crypto.randomUUID(),
    60_000,
  );
  assert(owner);
  try {
    const briefAdmission = await repository.admit({
      runId: run.id,
      stepKey: "brief",
      iteration: 0,
      actionVersion: run.workflowVersionId,
    }, owner);
    assert(briefAdmission.jobId, "brief job must be admitted");
    const steps = await database.query<{ id: string; step_key: string }>(
      `select id, step_key from bakery.run_steps
        where organization_id = $1 and run_id = $2`,
      [scope.organizationId, run.id],
    );
    const briefStepId = steps.rows.find((step) =>
      step.step_key === "brief"
    )!.id;
    const implementStepId = steps.rows.find((step) =>
      step.step_key === "implement"
    )!.id;
    const briefVersionId = crypto.randomUUID();
    await database.query(
      `update bakery.run_steps
          set status = 'completed', output = $3::jsonb, finished_at = now()
        where organization_id = $1 and id = $2`,
      [
        scope.organizationId,
        briefStepId,
        JSON.stringify({
          artifact: {
            artifactId: crypto.randomUUID(),
            versionId: briefVersionId,
            sha256: "d".repeat(64),
          },
        }),
      ],
    );
    const implementAdmission = await repository.admit({
      runId: run.id,
      stepKey: "implement",
      iteration: 0,
      actionVersion: run.workflowVersionId,
    }, owner);
    assert(implementAdmission.jobId, "implement job must be admitted");
    return {
      runId: run.id,
      briefStepId,
      implementStepId,
      implementJobId: implementAdmission.jobId,
      briefVersionId,
    };
  } finally {
    await repository.releaseEngineOwner(owner);
  }
}
