import { assertEquals } from "@std/assert";
import { createSuperuser } from "../../../apps/server/src/modules/auth/index.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../../apps/server/src/platform/database.ts";
import { readRuntimeConfig } from "../../../packages/config/src/env.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";
import { authRequest, sessionCookie } from "../../helpers/auth.ts";
import type { JobSeed } from "../../helpers/worker-execution.ts";
import type {
  Client,
  DurableArtifactIdentity,
} from "../../e2e/helpers/durable-core/artifact-client.ts";
import type { DurableCoreStack } from "./stack.ts";
import { seedProviderPricingSnapshot } from "../funded-model-job.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ENGINE_EVENT_ID =
  /^(?:[0-9A-HJKMNP-TV-Z]{26}|run:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:version:[0-9]+)$/i;
const ENGINE_FIXED_WORKFLOW_FUNCTION_SLUG =
  "bakery-server-bakery-fixed-workflow";
const ENGINE_RECOVERY_FUNCTION_SLUG = "bakery-server-bakery-workflow-recovery";
const ENGINE_WAIT_TIMEOUT_MS = 60_000;
const ENGINE_FUNCTION_REGISTRATION_TIMEOUT_MS = 60_000;
const ENGINE_OWNER_LEASE_SAFETY_MARGIN_MS = 1_000;
const engineOwnerTokens = new Map<string, string>();
function eventInternalIdValue(value: string): bigint {
  return BigInt(`0x${value}`);
}

export type AuthenticatedClients = {
  readonly identity: DurableArtifactIdentity;
  readonly producer: Client;
  readonly consumer: Client;
};

export type EngineAdmissionObservation = {
  readonly outboxStatus: "delivered";
  readonly engineEventId: string;
  readonly deliveryKey: string;
  readonly functionRunId: string;
  readonly functionEventId: string;
  readonly functionEventInternalId: string;
  readonly functionEventReceivedAt: string;
  readonly functionEventReceivedAtMicros: string;
  readonly functionDefinitionId: string;
  readonly functionRunStartedAt: string;
  readonly functionRunStartedAtMicros: string;
  readonly runStatus: string;
  readonly engineOwnerPresent: true;
  readonly engineOwnerGeneration: string;
  readonly engineOwnerToken: string;
  readonly engineOwnerLeaseExpiresAt: string;
  readonly jobStatus: string;
  readonly invocationCount: number;
  readonly recoverySource?: "cron" | "reconciliation" | "handoff";
};

export type EngineEventObservation = {
  readonly eventId: string;
  readonly eventInternalId: string;
  readonly eventReceivedAt: string;
  readonly runId: string;
};

export type EngineRecoveryTriggerObservation = {
  readonly recoveryEventId: string;
  readonly recoveryFunctionId: string;
  readonly recoveryFunctionDefinitionId: string;
  readonly recoveryFunctionRunId: string;
  readonly recoveryFunctionEventId: string;
  readonly recoveryFunctionRunStartedAt: string;
  readonly recoveryFunctionRunStartedAtMicros: string;
  readonly recoveryEventInternalId: string;
  readonly recoveryEventReceivedAt: string;
  readonly recoveryEventReceivedAtMicros: string;
  readonly runId: string;
};

export type EngineAdmission = {
  readonly clients: AuthenticatedClients;
  readonly job: JobSeed;
  readonly observation: EngineAdmissionObservation;
};

export type SecretIdentityEngineAdmission = EngineAdmission & {
  readonly applicationId: string;
  readonly secretId: string;
};

export async function postJson(
  client: Client,
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    origin: client.stack.origin,
    "Bakery-Organization-Id": client.organizationId ?? "",
    "Idempotency-Key": idempotencyKey,
  });
  if (client.cookie) headers.set("cookie", client.cookie);
  return await client.stack.fetch(
    new Request(`${client.stack.origin}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

export async function authenticatedClients(
  stack: DurableCoreStack,
): Promise<AuthenticatedClients> {
  const suffix = crypto.randomUUID();
  const email = `durable-core-admission-${suffix}@example.test`;
  const password = `Durable-Core-${suffix}`;
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    const config = readRuntimeConfig({
      BAKERY_ENV: "test",
      BAKERY_APP_DATABASE_URL: stack.ownerDatabaseUrl,
      BAKERY_PUBLIC_BASE_URL: stack.origin,
      BETTER_AUTH_SECRET: stack.authSecret,
    }).auth!;
    await createSuperuser({ pgDatabase: database, config }, {
      email,
      displayName: "Durable Core Admission",
      password,
    });
    const principal = await database.query<{
      organizationId: string;
      principalId: string;
    }>(
      `select membership.organization_id as "organizationId",
              membership.principal_id as "principalId"
         from bakery.organization_memberships as membership
        where membership.role = 'admin'
          and membership.status = 'active'
          and membership.principal_id = (
            select principal.id
              from bakery.principals as principal
              join public."user" as provider_user
                on provider_user.id = principal.provider_user_id
             where provider_user.email = $1
          )
        order by membership.created_at desc
        limit 1`,
      [email],
    );
    const identityRow = principal.rows[0];
    if (!identityRow) {
      throw new Error("DURABLE_CORE_ADMISSION_IDENTITY_MISSING");
    }
    const identity: DurableArtifactIdentity = {
      email,
      password,
      organizationId: identityRow.organizationId,
      principalId: identityRow.principalId,
    };
    const signIn = async (): Promise<Client> => {
      const response = await stack.fetch(
        authRequest("/api/auth/sign-in/email", { email, password }),
      );
      assertEquals(response.status, 200, await response.clone().text());
      return {
        stack,
        organizationId: identity.organizationId,
        cookie: sessionCookie(response),
      };
    };
    return {
      identity,
      producer: await signIn(),
      consumer: await signIn(),
    };
  } finally {
    await closePgDatabase(database);
  }
}

export async function waitForEngineFunctionRegistration(
  stack: DurableCoreStack,
): Promise<void> {
  const deadline = Date.now() + ENGINE_FUNCTION_REGISTRATION_TIMEOUT_MS;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const result = await stack.runOneOff([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "inngest",
      "-d",
      "inngest",
      "-Atqc",
      "select count(*) from public.functions as f join public.apps as app on app.id = f.app_id where app.name = 'bakery-server' and f.slug = 'bakery-server-bakery-fixed-workflow'",
    ]);
    lastOutput = result.output.trim();
    const count = Number(lastOutput.split("\n").at(-1));
    if (result.success && count === 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `DURABLE_CORE_ENGINE_FUNCTION_REGISTRATION_TIMEOUT:${lastOutput}`,
  );
}

export async function responseJson(
  response: Response,
  expectedStatus: number,
  operation: string,
): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `DURABLE_CORE_ADMISSION_${operation}:${response.status}:${raw}`,
    );
  }
  const body = JSON.parse(raw) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`DURABLE_CORE_ADMISSION_${operation}_BODY_INVALID`);
  }
  return body as Record<string, unknown>;
}

export async function createRepositoryProfile(
  stack: DurableCoreStack,
  organizationId: string,
  principalId: string,
  applicationId: string,
  agentVersionId?: string,
): Promise<{ repositoryId: string; repositoryProfileId: string }> {
  const repositoryId = crypto.randomUUID();
  const repositoryProfileId = crypto.randomUUID();
  const config = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["main", "durable/*"] },
    worktree: { root: "worktree" },
    ...(agentVersionId === undefined
      ? {}
      : { agentBindings: { "harness.implement": agentVersionId } }),
  };
  const digest = await sha256Hex(canonicalJson(config));
  await stack.psql(
    `insert into bakery.repositories (
       id, organization_id, application_id, integration_connection_id,
       provider_repo_id, owner, name, default_branch
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      repositoryId,
      organizationId,
      applicationId,
      crypto.randomUUID(),
      `durable-core-${repositoryId}`,
      "durable-core",
      `repository-${repositoryId.slice(0, 8)}`,
      "main",
    ],
  );
  await stack.psql(
    `insert into bakery.repository_profiles (
       id, organization_id, application_id, repository_id, revision, config,
       digest, created_by
     ) values ($1, $2, $3, $4, 1, $5::jsonb, $6, $7)`,
    [
      repositoryProfileId,
      organizationId,
      applicationId,
      repositoryId,
      JSON.stringify(config),
      digest,
      principalId,
    ],
  );
  await stack.psql(
    `update bakery.repositories
        set active_profile_id = $2
      where organization_id = $1 and id = $3`,
    [organizationId, repositoryProfileId, repositoryId],
  );
  return { repositoryId, repositoryProfileId };
}

const durableCoreBilling = {
  provider: "openai",
  billingAccountId: "budget-test-account",
  model: "gpt-5.6-luna",
  billingRoute: "api",
  maxTokens: 1_000,
  maxUsdReservation: 0.1,
  pricingMetadataSnapshot: "budget-test-price-v1",
} as const;

/** Pins the immutable model agent version that `harness.implement` requires. */
async function createModelAgentVersion(
  stack: DurableCoreStack,
  organizationId: string,
  principalId: string,
): Promise<string> {
  const agentId = crypto.randomUUID();
  const agentVersionId = crypto.randomUUID();
  const config = { harness: "codex", billing: durableCoreBilling };
  await stack.psql(
    `insert into bakery.agent_definitions (
       id, organization_id, slug, name, description, enabled
     ) values ($1, $2, $3, 'Durable core model agent', '', true)`,
    [agentId, organizationId, agentId],
  );
  await stack.psql(
    `insert into bakery.agent_versions (
       id, organization_id, agent_id, revision, config, digest, created_by
     ) values ($1, $2, $3, 1, $4::jsonb, $5, $6)`,
    [
      agentVersionId,
      organizationId,
      agentId,
      JSON.stringify(config),
      await sha256Hex(canonicalJson(config)),
      principalId,
    ],
  );
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    await seedProviderPricingSnapshot(database, {
      billing: durableCoreBilling,
    });
  } finally {
    await closePgDatabase(database);
  }
  return agentVersionId;
}

async function createWorkflow(
  stack: DurableCoreStack,
  organizationId: string,
  principalId: string,
  action: {
    readonly uses: "harness.implement" | "secret.identity.read";
    readonly with: Readonly<Record<string, string>>;
  } = {
    uses: "harness.implement",
    with: {
      repositoryId: "$task.repositoryId",
      planArtifact: crypto.randomUUID(),
    },
  },
): Promise<{ workflowId: string; workflowVersionId: string }> {
  const workflowId = crypto.randomUUID();
  const workflowVersionId = crypto.randomUUID();
  const suffix = workflowId.slice(0, 8);
  const spec = {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: `durable-core-${suffix}`,
    workflow: { kind: "fixed" },
    steps: [{
      id: "worker",
      uses: action.uses,
      with: action.with,
    }],
  };
  const digest = await sha256Hex(canonicalJson(spec));
  await stack.psql(
    `insert into bakery.workflow_definitions (
       id, organization_id, slug, name, enabled, version
     ) values ($1, $2, $3, $4, true, 1)`,
    [
      workflowId,
      organizationId,
      `durable-core-${suffix}`,
      `Durable Core ${suffix}`,
    ],
  );
  await stack.psql(
    `insert into bakery.workflow_versions (
       id, organization_id, workflow_id, revision, source_yaml,
       normalized_spec, digest, status, created_by, version
     ) values ($1, $2, $3, 1, $4, $5::jsonb, $6, 'published', $7, 1)`,
    [
      workflowVersionId,
      organizationId,
      workflowId,
      JSON.stringify(spec),
      JSON.stringify(spec),
      digest,
      principalId,
    ],
  );
  await stack.psql(
    `update bakery.workflow_definitions
        set active_version_id = $2
      where organization_id = $1 and id = $3`,
    [organizationId, workflowVersionId, workflowId],
  );
  return { workflowId, workflowVersionId };
}

async function ensureAgentSession(
  stack: DurableCoreStack,
  organizationId: string,
  runId: string,
  agentVersionId?: string,
): Promise<void> {
  const rows = await stack.psql<{
    runStepId: string;
    conversationId: string;
    sessionId: string | null;
  }>(
    `select step.id as "runStepId",
            task.conversation_id as "conversationId",
            session.id as "sessionId"
       from bakery.workflow_runs as run
       join bakery.run_steps as step
         on step.organization_id = run.organization_id
        and step.run_id = run.id
       join bakery.tasks as task
         on task.organization_id = run.organization_id
        and task.id = run.task_id
       left join bakery.agent_sessions as session
         on session.organization_id = step.organization_id
        and session.run_step_id = step.id
      where run.organization_id = $1 and run.id = $2
      order by session.created_at
      limit 1`,
    [organizationId, runId],
  );
  const row = rows[0];
  if (!row) throw new Error("DURABLE_CORE_ADMISSION_RUN_STEP_MISSING");
  if (row.sessionId !== null) return;
  const sessionId = crypto.randomUUID();
  await stack.psql(
    `insert into bakery.agent_sessions (
       id, organization_id, run_step_id, conversation_id, agent_version_id,
       harness, status
     ) values ($1, $2, $3, $4, $5, 'codex', 'active')`,
    [
      sessionId,
      organizationId,
      row.runStepId,
      row.conversationId,
      agentVersionId ?? crypto.randomUUID(),
    ],
  );
}

type EngineInvocation = {
  readonly functionRunId: string;
  readonly functionEventId: string;
  readonly functionDefinitionId: string;
  readonly functionRunStartedAt: string;
  readonly functionRunStartedAtMicros: string;
  readonly eventInternalId: string;
  readonly eventReceivedAt: string;
  readonly eventReceivedAtMicros: string;
  readonly eventRunId: string;
  readonly runStartedAfterRestart: boolean | null;
  readonly eventReceivedAfterRestart: boolean | null;
  readonly runStartedAfterRecoveryTrigger: boolean | null;
  readonly eventReceivedAfterRecoveryTrigger: boolean | null;
  readonly eventInternalAfterRecoveryTrigger: boolean | null;
};

type EngineInvocationQueryOptions = {
  readonly exactDeliveryKey?: string;
  readonly exactDomainEventId?: string;
  readonly restartBoundary?: string;
  readonly recoveryTrigger?: EngineRecoveryTriggerObservation;
};

function sqlTimestampLiteral(value: string, errorCode: string): string {
  if (!Number.isFinite(Date.parse(value)) || value.includes("'")) {
    throw new Error(errorCode);
  }
  return `'${value.replaceAll("'", "''")}'::timestamptz`;
}

function engineInvocationSql(
  runId: string,
  options: EngineInvocationQueryOptions = {},
): string {
  if (!UUID.test(runId)) {
    throw new Error("DURABLE_CORE_ADMISSION_RUN_ID_INVALID");
  }
  if (
    (options.exactDeliveryKey === undefined) !==
      (options.exactDomainEventId === undefined)
  ) {
    throw new Error("DURABLE_CORE_ADMISSION_ENGINE_EVENT_JOIN_INVALID");
  }
  if (
    options.exactDeliveryKey !== undefined &&
    !ENGINE_EVENT_ID.test(options.exactDeliveryKey)
  ) {
    throw new Error("DURABLE_CORE_ADMISSION_ENGINE_EVENT_ID_INVALID");
  }
  if (
    options.exactDomainEventId !== undefined &&
    !UUID.test(options.exactDomainEventId)
  ) {
    throw new Error("DURABLE_CORE_ADMISSION_DOMAIN_EVENT_ID_INVALID");
  }
  const restartBoundary = options.restartBoundary === undefined
    ? "null"
    : sqlTimestampLiteral(
      options.restartBoundary,
      "DURABLE_CORE_ADMISSION_RESTART_BOUNDARY_INVALID",
    );
  const recoveryTrigger = options.recoveryTrigger;
  const recoveryRunStartedAt = recoveryTrigger === undefined
    ? "null"
    : sqlTimestampLiteral(
      recoveryTrigger.recoveryFunctionRunStartedAt,
      "DURABLE_CORE_RECOVERY_RUN_TIMESTAMP_INVALID",
    );
  const recoveryEventReceivedAt = recoveryTrigger === undefined
    ? "null"
    : sqlTimestampLiteral(
      recoveryTrigger.recoveryEventReceivedAt,
      "DURABLE_CORE_RECOVERY_EVENT_TIMESTAMP_INVALID",
    );
  const recoveryEventInternalId = recoveryTrigger === undefined
    ? "null"
    : `decode('${recoveryTrigger.recoveryEventInternalId}', 'hex')`;
  const exactEventPredicate = options.exactDeliveryKey === undefined
    ? ""
    : `and event.event_id = '${options.exactDeliveryKey}'
     and event.event_data::jsonb #>> '{eventId}' =
       '${options.exactDomainEventId}'`;
  return `select json_build_object(
                 'functionRunId', encode(function_run.run_id, 'hex'),
                 'functionEventId', event.event_id,
                 'functionRunStartedAt', function_run.run_started_at::text || '+00',
                 'functionRunStartedAtMicros',
                   floor(extract(epoch from function_run.run_started_at) *
                     1000000)::bigint::text,
                 'eventInternalId', encode(event.internal_id, 'hex'),
                 'eventReceivedAt', event.received_at::text || '+00',
                 'eventReceivedAtMicros',
                   floor(extract(epoch from event.received_at) *
                     1000000)::bigint::text,
                 'eventRunId',
                   event.event_data::jsonb #>> '{payload,runId}',
                 'runStartedAfterRestart',
                   case when ${restartBoundary} is null then null
                     else function_run.run_started_at > ${restartBoundary}
                   end,
                 'eventReceivedAfterRestart',
                   case when ${restartBoundary} is null then null
                     else event.received_at > ${restartBoundary}
                   end,
                 'runStartedAfterRecoveryTrigger',
                   case when ${recoveryRunStartedAt} is null then null
                     else function_run.run_started_at > ${recoveryRunStartedAt}
                   end,
                 'eventReceivedAfterRecoveryTrigger',
                   case when ${recoveryEventReceivedAt} is null then null
                     else event.received_at > ${recoveryEventReceivedAt}
                   end,
                 'eventInternalAfterRecoveryTrigger',
                   case when ${recoveryEventInternalId} is null then null
                     else event.internal_id > ${recoveryEventInternalId}
                   end,
                 'functionDefinitionId', function_run.function_id::text,
                 'functionSlug', registered_function.slug
               )::text
    from public.function_runs as function_run
    join public.events as event on event.internal_id = function_run.event_id
    join public.functions as registered_function
      on registered_function.id = function_run.function_id
   where registered_function.slug = '${ENGINE_FIXED_WORKFLOW_FUNCTION_SLUG}'
     and event.event_name = 'bakery/run.requested.v1'
     and event.event_data::jsonb #>> '{payload,runId}' = '${runId}'
     ${exactEventPredicate}
   order by event.received_at, event.internal_id,
            function_run.run_started_at, function_run.run_id`;
}

function engineInvocationDiagnosticSql(): string {
  return `select event.internal_id::text || '|' ||
                 event.event_id || '|' ||
                 event.event_name || '|' ||
                 pg_typeof(event.event_data)::text || '|' ||
                 jsonb_typeof(event.event_data::jsonb) || '|' ||
                 length(event.event_data::text)::text || '|' ||
                 coalesce((
                   select string_agg(key, ',' order by key)
                     from jsonb_object_keys(event.event_data::jsonb) as keys(key)
                 ), '') || '|' ||
                 coalesce(event.event_data::jsonb #>> '{runId}', '<null>') || '|' ||
                 coalesce(event.event_data::jsonb #>> '{data,runId}', '<null>') || '|' ||
                 coalesce(event.event_data::jsonb #>> '{data,payload,runId}', '<null>') || '|' ||
                 coalesce(event.event_data::jsonb #>> '{payload,runId}', '<null>') || '|' ||
                 coalesce((
                   select string_agg(
                            function_run.function_id::text || ':' ||
                              coalesce(registered_function.slug, '<none>'),
                            ',' order by function_run.function_id
                          )
                     from public.function_runs as function_run
                     left join public.functions as registered_function
                       on registered_function.id = function_run.function_id
                    where function_run.event_id = event.internal_id
                 ), '<none>')
            from public.events as event
           where event.event_name in (
             'bakery/run.requested.v1',
             'bakery/workflow.reconcile.v1'
           )
           order by event.internal_id desc
           limit 8`;
}

async function engineInvocationDiagnostics(
  stack: DurableCoreStack,
): Promise<string> {
  const result = await stack.runOneOff([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "inngest",
    "-d",
    "inngest",
    "-At",
    "-c",
    engineInvocationDiagnosticSql(),
  ]);
  if (!result.success) return `query-failed:${result.output}`;
  return result.output.trim() || "<none>";
}

async function engineInvocations(
  stack: DurableCoreStack,
  runId: string,
  options: EngineInvocationQueryOptions = {},
): Promise<readonly EngineInvocation[]> {
  const result = await stack.runOneOff([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "inngest",
    "-d",
    "inngest",
    "-At",
    "-c",
    engineInvocationSql(runId, options),
  ]);
  if (!result.success) {
    throw new Error(
      `DURABLE_CORE_ADMISSION_ENGINE_QUERY_FAILED:${result.output}`,
    );
  }
  return result.output.trim().split("\n").filter(Boolean).map((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("DURABLE_CORE_ADMISSION_ENGINE_ROW_INVALID");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("DURABLE_CORE_ADMISSION_ENGINE_ROW_INVALID");
    }
    const row = parsed as Record<string, unknown>;
    const stringValue = (key: string): string | undefined =>
      typeof row[key] === "string" ? row[key] as string : undefined;
    const booleanValue = (key: string): boolean | null | undefined =>
      row[key] === null
        ? null
        : typeof row[key] === "boolean"
        ? row[key] as boolean
        : undefined;
    const functionRunId = stringValue("functionRunId");
    const functionEventId = stringValue("functionEventId");
    const functionDefinitionId = stringValue("functionDefinitionId");
    const functionRunStartedAt = stringValue("functionRunStartedAt");
    const functionRunStartedAtMicros = stringValue(
      "functionRunStartedAtMicros",
    );
    const eventInternalId = stringValue("eventInternalId");
    const eventReceivedAt = stringValue("eventReceivedAt");
    const eventReceivedAtMicros = stringValue("eventReceivedAtMicros");
    const eventRunId = stringValue("eventRunId");
    const functionSlug = stringValue("functionSlug");
    const runStartedAfterRestart = booleanValue("runStartedAfterRestart");
    const eventReceivedAfterRestart = booleanValue("eventReceivedAfterRestart");
    const runStartedAfterRecoveryTrigger = booleanValue(
      "runStartedAfterRecoveryTrigger",
    );
    const eventReceivedAfterRecoveryTrigger = booleanValue(
      "eventReceivedAfterRecoveryTrigger",
    );
    const eventInternalAfterRecoveryTrigger = booleanValue(
      "eventInternalAfterRecoveryTrigger",
    );
    if (
      functionSlug !== ENGINE_FIXED_WORKFLOW_FUNCTION_SLUG ||
      !UUID.test(functionDefinitionId ?? "") ||
      !UUID.test(eventRunId ?? "") ||
      !/^[0-9a-f]+$/i.test(functionRunId ?? "") ||
      !ENGINE_EVENT_ID.test(functionEventId ?? "") ||
      !/^[0-9]+$/.test(functionRunStartedAtMicros ?? "") ||
      !Number.isFinite(Date.parse(functionRunStartedAt ?? "")) ||
      !/^[0-9a-f]+$/i.test(eventInternalId ?? "") ||
      !/^[0-9]+$/.test(eventReceivedAtMicros ?? "") ||
      !Number.isFinite(Date.parse(eventReceivedAt ?? "")) ||
      runStartedAfterRestart === undefined ||
      eventReceivedAfterRestart === undefined ||
      runStartedAfterRecoveryTrigger === undefined ||
      eventReceivedAfterRecoveryTrigger === undefined ||
      eventInternalAfterRecoveryTrigger === undefined
    ) {
      throw new Error("DURABLE_CORE_ADMISSION_ENGINE_ROW_INVALID");
    }
    return {
      functionRunId: functionRunId as string,
      functionEventId: functionEventId as string,
      functionDefinitionId: functionDefinitionId as string,
      functionRunStartedAt: functionRunStartedAt as string,
      functionRunStartedAtMicros: functionRunStartedAtMicros as string,
      eventInternalId: eventInternalId as string,
      eventReceivedAt: eventReceivedAt as string,
      eventReceivedAtMicros: eventReceivedAtMicros as string,
      eventRunId: eventRunId as string,
      runStartedAfterRestart,
      eventReceivedAfterRestart,
      runStartedAfterRecoveryTrigger,
      eventReceivedAfterRecoveryTrigger,
      eventInternalAfterRecoveryTrigger,
    };
  });
}

function functionRunUlid(runIdHex: string): string {
  if (!/^[0-9a-f]{32}$/i.test(runIdHex)) {
    throw new Error("DURABLE_CORE_RECOVERY_FUNCTION_RUN_ID_INVALID");
  }
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const digits = new Array<string>(26);
  let value = BigInt(`0x${runIdHex}`);
  for (let index = digits.length - 1; index >= 0; index--) {
    digits[index] = alphabet[Number(value & 31n)] as string;
    value >>= 5n;
  }
  return digits.join("");
}

async function recoveryFunctionSentEvent(
  stack: DurableCoreStack,
  trigger: EngineRecoveryTriggerObservation,
  successorEventId: string,
): Promise<boolean> {
  if (!ENGINE_EVENT_ID.test(successorEventId)) {
    throw new Error("DURABLE_CORE_RECOVERY_CHILD_EVENT_ID_INVALID");
  }
  // Inngest v1.44 stores step.sendEvent() IDs in its function-run step span;
  // function_runs.original_run_id denotes a rerun, not a parent-child link.
  const recoveryRunId = functionRunUlid(trigger.recoveryFunctionRunId);
  const result = await stack.runOneOff([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "inngest",
    "-d",
    "inngest",
    "-At",
    "-c",
    `select count(*)::int
       from public.spans as span
      where span.run_id = '${recoveryRunId}'
        and span.name = 'executor.step'
        and span.attributes->>'_inngest.step.op' = 'StepRun'
        and span.output->'data'->'ids' ? '${successorEventId}'
        and exists (
          select 1
            from public.events as child_event
           where child_event.event_id = '${successorEventId}'
             and child_event.event_name = 'bakery/run.requested.v1'
             and child_event.event_data::jsonb #>> '{payload,runId}' =
               '${trigger.runId}'
        )`,
  ]);
  const count = result.output.trim();
  if (!result.success || !/^[0-9]+$/.test(count)) {
    throw new Error(`DURABLE_CORE_RECOVERY_SPAN_QUERY_FAILED:${result.output}`);
  }
  if (Number(count) > 1) {
    throw new Error("DURABLE_CORE_RECOVERY_SPAN_DUPLICATE");
  }
  return count === "1";
}

function functionRunIdHex(recoveryRunId: string): string {
  if (!ULID.test(recoveryRunId)) {
    throw new Error("DURABLE_CORE_CRON_FUNCTION_RUN_ID_INVALID");
  }
  let value = 0n;
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  for (const character of recoveryRunId) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) {
      throw new Error("DURABLE_CORE_CRON_FUNCTION_RUN_ID_INVALID");
    }
    value = (value << 5n) | BigInt(digit);
  }
  if (value >= 1n << 128n) {
    throw new Error("DURABLE_CORE_CRON_FUNCTION_RUN_ID_INVALID");
  }
  return value.toString(16).padStart(32, "0");
}

async function cronRecoveryProbe(
  stack: DurableCoreStack,
  runId: string,
  successorEventId: string,
): Promise<boolean> {
  if (!UUID.test(runId) || !ENGINE_EVENT_ID.test(successorEventId)) {
    throw new Error("DURABLE_CORE_CRON_CHILD_EVENT_ID_INVALID");
  }
  const spans = await stack.runOneOff([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "inngest",
    "-d",
    "inngest",
    "-At",
    "-c",
    `select distinct span.run_id
       from public.spans as span
       join public.functions as registered_function
         on registered_function.id::text = span.function_id
       join public.events as child_event
         on child_event.event_id = '${successorEventId}'
      where registered_function.slug = '${ENGINE_RECOVERY_FUNCTION_SLUG}'
        and span.name = 'executor.step'
        and span.attributes->>'_inngest.step.op' = 'StepRun'
        and span.output->'data'->'ids' ? '${successorEventId}'
        and child_event.event_name = 'bakery/run.requested.v1'
        and child_event.event_data::jsonb #>> '{payload,runId}' = '${runId}'
      limit 2`,
  ]);
  if (!spans.success) {
    throw new Error(`DURABLE_CORE_CRON_SPAN_QUERY_FAILED:${spans.output}`);
  }
  const runIds = spans.output.trim().split("\n").filter(Boolean);
  if (runIds.length === 0) {
    return false;
  }
  if (runIds.length !== 1 || !ULID.test(runIds[0] ?? "")) {
    throw new Error("DURABLE_CORE_CRON_SPAN_SOURCE_AMBIGUOUS");
  }
  const recoveryRunId = runIds[0] as string;
  const runIdHex = functionRunIdHex(recoveryRunId);
  const source = await stack.runOneOff([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "inngest",
    "-d",
    "inngest",
    "-At",
    "-c",
    `select count(*)::int
       from public.function_runs as function_run
       join public.events as trigger_event
         on trigger_event.internal_id = function_run.event_id
       join public.functions as registered_function
         on registered_function.id = function_run.function_id
      where function_run.run_id = decode('${runIdHex}', 'hex')
        and registered_function.slug = '${ENGINE_RECOVERY_FUNCTION_SLUG}'
        and trigger_event.event_name = 'inngest/scheduled.timer'`,
  ]);
  const count = source.output.trim();
  if (!source.success || !/^[0-9]+$/.test(count)) {
    throw new Error(`DURABLE_CORE_CRON_SOURCE_QUERY_FAILED:${source.output}`);
  }
  if (Number(count) > 1) {
    throw new Error("DURABLE_CORE_CRON_SOURCE_DUPLICATE");
  }
  return count === "1";
}

async function handoffRecoveryProbe(
  stack: DurableCoreStack,
  organizationId: string,
  runId: string,
  candidate: Pick<EngineInvocation, "functionEventId" | "eventInternalId">,
  restartBoundary: string,
): Promise<boolean> {
  if (
    !UUID.test(organizationId) ||
    !UUID.test(runId) ||
    !ENGINE_EVENT_ID.test(candidate.functionEventId) ||
    !/^[0-9a-f]{32}$/i.test(candidate.eventInternalId)
  ) {
    throw new Error("DURABLE_CORE_HANDOFF_EVENT_INPUT_INVALID");
  }
  const restartBoundarySql = sqlTimestampLiteral(
    restartBoundary,
    "DURABLE_CORE_HANDOFF_RESTART_BOUNDARY_INVALID",
  );
  let appRows: Array<{
    readonly domainEventId: string;
    readonly deliveryKey: string;
  }>;
  try {
    appRows = await stack.psql<{
      domainEventId: string;
      deliveryKey: string;
    }>(
      `select event.id::text as "domainEventId",
              outbox.delivery_key as "deliveryKey"
         from bakery.outbox as outbox
         join bakery.domain_events as event
           on event.id = outbox.event_id
        where event.organization_id = $1
          and event.aggregate_id = $2
          and event.event_type = 'run.requested'
          and outbox.destination = 'inngest'
          and outbox.status = 'delivered'
          and outbox.delivery_key = $3
        limit 2`,
      [organizationId, runId, candidate.functionEventId],
    );
  } catch (error) {
    throw new Error(
      `DURABLE_CORE_HANDOFF_APP_QUERY_FAILED:${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (appRows.length > 1) {
    throw new Error("DURABLE_CORE_HANDOFF_APP_SOURCE_DUPLICATE");
  }
  const appRow = appRows[0];
  if (!appRow) {
    return false;
  }
  if (
    !UUID.test(appRow.domainEventId) ||
    appRow.deliveryKey !== candidate.functionEventId
  ) {
    throw new Error("DURABLE_CORE_HANDOFF_APP_ID_MISMATCH");
  }

  const inngestResult = await stack.runOneOff([
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "inngest",
    "-d",
    "inngest",
    "-At",
    "-c",
    `select json_build_object(
              'eventId', event.event_id,
              'eventInternalId', encode(event.internal_id, 'hex'),
              'eventName', event.event_name,
              'domainEventId', event.event_data::jsonb #>> '{eventId}',
              'payloadRunId', event.event_data::jsonb #>> '{payload,runId}',
              'receivedAt', event.received_at::text || '+00'
            )::text
       from public.events as event
      where event.event_id = '${candidate.functionEventId}'
        and event.internal_id = decode('${candidate.eventInternalId}', 'hex')
        and event.event_name = 'bakery/run.requested.v1'
        and event.event_data::jsonb #>> '{payload,runId}' = '${runId}'
        and event.received_at > ${restartBoundarySql}
      limit 2`,
  ]);
  if (!inngestResult.success) {
    throw new Error(
      `DURABLE_CORE_HANDOFF_EVENT_QUERY_FAILED:${inngestResult.output}`,
    );
  }
  const eventRows = inngestResult.output.trim().split("\n").map((line) =>
    line.trim()
  ).filter(Boolean);
  if (eventRows.length > 1) {
    throw new Error("DURABLE_CORE_HANDOFF_EVENT_SOURCE_DUPLICATE");
  }
  const eventRowText = eventRows[0];
  if (!eventRowText) {
    return false;
  }
  let parsedEvent: unknown;
  try {
    parsedEvent = JSON.parse(eventRowText);
  } catch {
    throw new Error("DURABLE_CORE_HANDOFF_EVENT_ROW_INVALID");
  }
  if (
    !parsedEvent ||
    typeof parsedEvent !== "object" ||
    Array.isArray(parsedEvent)
  ) {
    throw new Error("DURABLE_CORE_HANDOFF_EVENT_ROW_INVALID");
  }
  const eventRow = parsedEvent as Record<string, unknown>;
  const eventId = eventRow.eventId;
  const eventInternalId = eventRow.eventInternalId;
  const eventName = eventRow.eventName;
  const domainEventId = eventRow.domainEventId;
  const payloadRunId = eventRow.payloadRunId;
  const receivedAt = eventRow.receivedAt;
  if (
    typeof eventId !== "string" ||
    typeof eventInternalId !== "string" ||
    typeof eventName !== "string" ||
    typeof domainEventId !== "string" ||
    typeof payloadRunId !== "string" ||
    typeof receivedAt !== "string" ||
    !/^[0-9a-f]{32}$/i.test(eventInternalId) ||
    !Number.isFinite(Date.parse(receivedAt)) ||
    eventId !== candidate.functionEventId ||
    eventInternalId.toLowerCase() !== candidate.eventInternalId.toLowerCase() ||
    eventName !== "bakery/run.requested.v1" ||
    domainEventId !== appRow.domainEventId ||
    payloadRunId !== runId ||
    Date.parse(receivedAt) <= Date.parse(restartBoundary)
  ) {
    throw new Error("DURABLE_CORE_HANDOFF_EVENT_ID_MISMATCH");
  }
  return true;
}

export function cronRecoverySentEvent(
  stack: DurableCoreStack,
  runId: string,
  successorEventId: string,
): Promise<boolean> {
  return cronRecoveryProbe(stack, runId, successorEventId);
}

export async function waitForPostRestartEngineEvent(
  stack: DurableCoreStack,
  runId: string,
  restartBoundary: string,
  timeoutMs: number,
  beforeEventInternalId?: string,
  beforeEventReceivedAt?: string,
): Promise<EngineEventObservation | undefined> {
  if (
    !UUID.test(runId) ||
    !Number.isFinite(Date.parse(restartBoundary)) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 ||
    (beforeEventInternalId !== undefined &&
      !/^[0-9a-f]{32}$/i.test(beforeEventInternalId)) ||
    (beforeEventInternalId === undefined) !==
      (beforeEventReceivedAt === undefined)
  ) {
    throw new Error("DURABLE_CORE_POST_RESTART_EVENT_QUERY_INVALID");
  }
  const restartBoundarySql = sqlTimestampLiteral(
    restartBoundary,
    "DURABLE_CORE_POST_RESTART_BOUNDARY_INVALID",
  );
  const beforeEventPredicate = beforeEventInternalId === undefined
    ? ""
    : `and event.internal_id < decode('${beforeEventInternalId}', 'hex')
          and event.received_at < ${
      sqlTimestampLiteral(
        beforeEventReceivedAt as string,
        "DURABLE_CORE_POST_RESTART_EVENT_TIMESTAMP_INVALID",
      )
    }`;
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await stack.runOneOff([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "inngest",
      "-d",
      "inngest",
      "-At",
      "-c",
      `select json_build_object(
                'eventId', event.event_id,
                'eventInternalId', encode(event.internal_id, 'hex'),
                'eventReceivedAt', event.received_at::text || '+00',
                'eventReceivedAtMicros',
                  floor(extract(epoch from event.received_at) *
                    1000000)::bigint::text,
                'runId', event.event_data::jsonb #>> '{payload,runId}',
                'receivedAfterRestart',
                  event.received_at > ${restartBoundarySql}
              )::text
         from public.events as event
        where event.event_name = 'bakery/run.requested.v1'
          and event.event_data::jsonb #>> '{payload,runId}' = '${runId}'
          and event.event_id ~
            '^(?:[0-9A-HJKMNP-TV-Z]{26}|run:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:version:[0-9]+)$'
          and event.received_at > ${restartBoundarySql}
          ${beforeEventPredicate}
        order by event.received_at, event.internal_id
        limit 1`,
    ]);
    if (!result.success) {
      throw new Error(
        `DURABLE_CORE_POST_RESTART_EVENT_QUERY_FAILED:${result.output}`,
      );
    }
    const line = result.output.trim();
    if (line) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("DURABLE_CORE_POST_RESTART_EVENT_ROW_INVALID");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("DURABLE_CORE_POST_RESTART_EVENT_ROW_INVALID");
      }
      const row = parsed as Record<string, unknown>;
      const eventId = row.eventId;
      const eventInternalId = row.eventInternalId;
      const eventReceivedAt = row.eventReceivedAt;
      const eventReceivedAtMicros = row.eventReceivedAtMicros;
      const eventRunId = row.runId;
      if (
        typeof eventId !== "string" || !ENGINE_EVENT_ID.test(eventId) ||
        typeof eventInternalId !== "string" ||
        !/^[0-9a-f]{32}$/i.test(eventInternalId) ||
        typeof eventReceivedAt !== "string" ||
        !Number.isFinite(Date.parse(eventReceivedAt)) ||
        typeof eventReceivedAtMicros !== "string" ||
        !/^[0-9]+$/.test(eventReceivedAtMicros) ||
        eventRunId !== runId ||
        row.receivedAfterRestart !== true
      ) {
        throw new Error("DURABLE_CORE_POST_RESTART_EVENT_ROW_INVALID");
      }
      return {
        eventId,
        eventInternalId,
        eventReceivedAt,
        runId: eventRunId,
      };
    }
    if (Date.now() >= deadline) break;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 100);
    await promise;
  } while (Date.now() < deadline);
  return undefined;
}

type EngineInvocationWaitOptions = {
  readonly previous?: EngineAdmissionObservation;
  readonly recoveryTrigger?: EngineRecoveryTriggerObservation;
  readonly restartBoundary?: string;
  readonly timeoutMs?: number;
};

type CandidateDiagnostic = {
  readonly functionRunId: string;
  readonly functionEventId: string;
  readonly functionDefinitionId: string;
  readonly eventInternalId: string;
  readonly eventReceivedAt: string;
  readonly eventReceivedAtMicros: string;
  readonly eventRunId: string;
  readonly functionRunStartedAt: string;
  readonly functionRunStartedAtMicros: string;
  readonly previousFunctionRunId: string | null;
  readonly previousFunctionEventId: string | null;
  readonly previousFunctionEventInternalId: string | null;
  readonly previousGeneration: string | null;
  readonly currentGeneration: string | null;
  readonly recoveryEventId: string | null;
  readonly predicates: Readonly<Record<string, boolean>>;
  readonly source:
    | "cron"
    | "reconciliation"
    | "handoff"
    | "unproven"
    | "ambiguous";
};

async function waitForEngineAdmission(
  stack: DurableCoreStack,
  runId: string,
  organizationId: string,
  options: EngineInvocationWaitOptions = {},
): Promise<{
  readonly observation: EngineAdmissionObservation;
  readonly job: JobSeed;
}> {
  const timeoutMs = options.timeoutMs ?? ENGINE_WAIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("DURABLE_CORE_ADMISSION_WAIT_TIMEOUT_INVALID");
  }
  if (
    options.recoveryTrigger !== undefined &&
    options.previous === undefined
  ) {
    throw new Error("DURABLE_CORE_ADMISSION_RECOVERY_TRIGGER_INVALID");
  }
  if (
    options.restartBoundary !== undefined &&
    !Number.isFinite(Date.parse(options.restartBoundary))
  ) {
    throw new Error("DURABLE_CORE_ADMISSION_RESTART_BOUNDARY_INVALID");
  }
  const deadline = Date.now() + timeoutMs;
  let lastState = "";
  let lastCandidateDiagnostics: readonly CandidateDiagnostic[] = [];
  while (Date.now() < deadline) {
    const outboxRows = await stack.psql<{
      status: string;
      engineEventId: string | null;
      deliveryKey: string;
      domainEventId: string;
    }>(
      `with original_request as (
             select event.id
               from bakery.domain_events as event
              where event.organization_id = $1
                and event.aggregate_id = $2
                and event.event_type = 'run.requested'
              order by event.organization_sequence, event.id
              limit 1
           )
       select outbox.status,
              outbox.engine_event_id as "engineEventId",
              outbox.delivery_key as "deliveryKey",
              original_request.id::text as "domainEventId"
         from bakery.outbox as outbox
         join original_request on original_request.id = outbox.event_id
        where outbox.destination = 'inngest'`,
      [organizationId, runId],
    );
    if (outboxRows.length > 1) {
      throw new Error(
        `DURABLE_CORE_ENGINE_OUTBOX_DUPLICATE:${JSON.stringify(outboxRows)}`,
      );
    }
    const runRows = await stack.psql<{
      taskId: string;
      applicationId: string;
      conversationId: string;
      workflowId: string;
      workflowVersionId: string;
      runStepId: string;
      sessionId: string;
      jobId: string;
      runStatus: string;
      engineOwnerToken: string | null;
      engineOwnerGeneration: string | null;
      engineOwnerLeaseExpiresAt: string | null;
      engineOwnerLeaseLive: boolean;
      jobStatus: string;
    }>(
      `select run.task_id as "taskId",
              task.application_id as "applicationId",
              task.conversation_id as "conversationId",
              workflow.id as "workflowId",
              run.workflow_version_id as "workflowVersionId",
              step.id as "runStepId",
              session.id as "sessionId",
              job.id as "jobId",
              run.status as "runStatus",
              run.engine_owner_token as "engineOwnerToken",
              run.engine_owner_generation::text as "engineOwnerGeneration",
              run.engine_owner_lease_expires_at as
                "engineOwnerLeaseExpiresAt",
              run.engine_owner_lease_expires_at >
                clock_timestamp() +
                  interval '1 second' as "engineOwnerLeaseLive",
              job.status as "jobStatus"
         from bakery.workflow_runs as run
         join bakery.tasks as task
           on task.organization_id = run.organization_id
          and task.id = run.task_id
         join bakery.workflow_versions as version
           on version.organization_id = run.organization_id
          and version.id = run.workflow_version_id
         join bakery.workflow_definitions as workflow
           on workflow.organization_id = version.organization_id
          and workflow.id = version.workflow_id
         join bakery.run_steps as step
           on step.organization_id = run.organization_id
          and step.run_id = run.id
         join bakery.agent_sessions as session
           on session.organization_id = step.organization_id
          and session.run_step_id = step.id
         join bakery.jobs as job
           on job.organization_id = step.organization_id
          and job.run_step_id = step.id
        where run.organization_id = $1 and run.id = $2
        order by job.created_at
        limit 1`,
      [organizationId, runId],
    );
    const outbox = outboxRows[0];
    const state = runRows[0];
    const originalInvocations = outbox?.engineEventId
      ? await engineInvocations(stack, runId, {
        exactDeliveryKey: outbox.deliveryKey,
        exactDomainEventId: outbox.domainEventId,
      })
      : [];
    if (originalInvocations.length > 1) {
      throw new Error(
        `DURABLE_CORE_ENGINE_ORIGINAL_EVENT_DUPLICATE:${
          JSON.stringify(originalInvocations)
        }`,
      );
    }
    const previous = options.previous;
    const invocations = previous === undefined
      ? originalInvocations
      : outbox?.engineEventId
      ? await engineInvocations(stack, runId, {
        restartBoundary: options.restartBoundary,
        recoveryTrigger: options.recoveryTrigger,
      })
      : [];
    const duplicateEventIds = new Set<string>();
    for (const invocation of invocations) {
      if (duplicateEventIds.has(invocation.functionEventId)) {
        throw new Error(
          `DURABLE_CORE_ENGINE_EVENT_DUPLICATE:${invocation.functionEventId}`,
        );
      }
      duplicateEventIds.add(invocation.functionEventId);
    }
    const candidateDiagnostics: CandidateDiagnostic[] = [];
    const successors: Array<{
      readonly candidate: EngineInvocation;
      readonly source: "cron" | "reconciliation" | "handoff";
    }> = [];
    if (previous !== undefined && state) {
      for (const candidate of invocations) {
        const ownerTokenMatchesCandidate = state.engineOwnerToken !== null &&
          state.engineOwnerToken === candidate.functionEventId;
        const basePredicates = {
          functionRunIsNew: candidate.functionRunId !== previous.functionRunId,
          functionEventIsNew: candidate.functionEventId !==
            previous.functionEventId,
          eventInternalIdIsAfterPrevious: eventInternalIdValue(
            candidate.eventInternalId,
          ) > eventInternalIdValue(previous.functionEventInternalId),
          generationIsPresent: state.engineOwnerGeneration !== null,
          generationIsGreater: state.engineOwnerGeneration !== null &&
            BigInt(state.engineOwnerGeneration) >
              BigInt(previous.engineOwnerGeneration),
          ownerTokenIsPresent: state.engineOwnerToken !== null,
          ownerTokenChanged: state.engineOwnerToken !== null &&
            state.engineOwnerToken !== previous.engineOwnerToken,
          functionRunIsAfterRestart: candidate.runStartedAfterRestart === true,
          eventIsAfterRestart: candidate.eventReceivedAfterRestart === true,
        };
        const basePredicatesPass = Object.values(basePredicates).every(
          Boolean,
        );
        let source: CandidateDiagnostic["source"] = "unproven";
        let sourcePredicates = {
          functionRunIsAfterRecoveryTrigger:
            options.recoveryTrigger === undefined,
          eventIsAfterRecoveryTrigger: options.recoveryTrigger === undefined,
          eventInternalIdIsAfterRecoveryTrigger:
            options.recoveryTrigger === undefined,
          candidateIsNotRecoveryTrigger: options.recoveryTrigger === undefined,
        };
        if (basePredicatesPass) {
          const cron = await cronRecoveryProbe(
            stack,
            runId,
            candidate.functionEventId,
          );
          const reconciliation = options.recoveryTrigger !== undefined &&
            await recoveryFunctionSentEvent(
              stack,
              options.recoveryTrigger,
              candidate.functionEventId,
            );
          const handoff = options.restartBoundary !== undefined &&
            await handoffRecoveryProbe(
              stack,
              organizationId,
              runId,
              candidate,
              options.restartBoundary,
            );
          const provenSources = [cron, reconciliation, handoff].filter(
            Boolean,
          ).length;
          if (provenSources > 1) {
            source = "ambiguous";
            throw new Error(
              `DURABLE_CORE_ENGINE_SUCCESSOR_SOURCE_AMBIGUOUS:${
                JSON.stringify({
                  functionEventId: candidate.functionEventId,
                  eventInternalId: candidate.eventInternalId,
                  eventReceivedAt: candidate.eventReceivedAt,
                  runId: candidate.eventRunId,
                })
              }`,
            );
          }
          if (cron) source = "cron";
          else if (reconciliation) source = "reconciliation";
          else if (handoff) source = "handoff";
          sourcePredicates = {
            functionRunIsAfterRecoveryTrigger:
              options.recoveryTrigger === undefined ||
              source !== "reconciliation" ||
              candidate.runStartedAfterRecoveryTrigger === true,
            eventIsAfterRecoveryTrigger:
              options.recoveryTrigger === undefined ||
              source !== "reconciliation" ||
              candidate.eventReceivedAfterRecoveryTrigger === true,
            eventInternalIdIsAfterRecoveryTrigger:
              options.recoveryTrigger === undefined ||
              source !== "reconciliation" ||
              candidate.eventInternalAfterRecoveryTrigger === true,
            candidateIsNotRecoveryTrigger:
              options.recoveryTrigger === undefined ||
              source !== "reconciliation" ||
              candidate.functionEventId !==
                options.recoveryTrigger.recoveryFunctionEventId,
          };
          if (
            ownerTokenMatchesCandidate &&
            (source === "cron" || source === "reconciliation" ||
              source === "handoff") &&
            Object.values(sourcePredicates).every(Boolean)
          ) {
            successors.push({
              candidate,
              source,
            });
          }
        }
        const predicates = {
          ...basePredicates,
          ownerTokenMatchesCandidate,
          ...sourcePredicates,
        };
        candidateDiagnostics.push({
          functionRunId: candidate.functionRunId,
          functionEventId: candidate.functionEventId,
          functionDefinitionId: candidate.functionDefinitionId,
          eventInternalId: candidate.eventInternalId,
          eventReceivedAt: candidate.eventReceivedAt,
          eventReceivedAtMicros: candidate.eventReceivedAtMicros,
          eventRunId: candidate.eventRunId,
          functionRunStartedAt: candidate.functionRunStartedAt,
          functionRunStartedAtMicros: candidate.functionRunStartedAtMicros,
          previousFunctionRunId: previous.functionRunId,
          previousFunctionEventId: previous.functionEventId,
          previousFunctionEventInternalId: previous.functionEventInternalId,
          previousGeneration: previous.engineOwnerGeneration,
          currentGeneration: state.engineOwnerGeneration,
          recoveryEventId: options.recoveryTrigger?.recoveryEventId ?? null,
          predicates,
          source,
        });
      }
    }
    successors.sort((left, right) => {
      const received = BigInt(left.candidate.eventReceivedAtMicros) -
        BigInt(right.candidate.eventReceivedAtMicros);
      if (received < 0n) return -1;
      if (received > 0n) return 1;
      const internal = eventInternalIdValue(left.candidate.eventInternalId) -
        eventInternalIdValue(right.candidate.eventInternalId);
      return internal < 0n ? -1 : internal > 0n ? 1 : 0;
    });
    if (successors.length > 1) {
      throw new Error(
        `DURABLE_CORE_ENGINE_SUCCESSOR_DUPLICATE:${
          JSON.stringify(successors.map(({ candidate }) => candidate))
        }`,
      );
    }
    const successor = successors[0];
    const invocation = previous === undefined
      ? originalInvocations[0]
      : successor?.candidate;
    const recoverySource = successor?.source;
    const safeState = state === undefined ? state : {
      ...state,
      engineOwnerToken: state.engineOwnerToken === null ? null : "[present]",
    };
    lastCandidateDiagnostics = candidateDiagnostics.slice(-16);
    lastState = JSON.stringify({
      outbox,
      originalInvocations,
      state: safeState,
      invocations,
      candidateDiagnostics: lastCandidateDiagnostics,
    });
    const successorReady = previous === undefined
      ? originalInvocations.length === 1
      : successor !== undefined;
    if (
      outbox?.status === "delivered" && outbox.engineEventId && state &&
      state.engineOwnerToken && state.engineOwnerGeneration &&
      state.engineOwnerLeaseExpiresAt && state.engineOwnerLeaseLive &&
      invocation &&
      !["completed", "failed", "canceled", "cancelled"].includes(
        state.runStatus,
      ) &&
      !["completed", "failed", "canceled", "cancelled"].includes(
        state.jobStatus,
      ) && successorReady
    ) {
      if (
        originalInvocations[0]?.functionEventId !== outbox.deliveryKey
      ) {
        throw new Error("DURABLE_CORE_ENGINE_OUTBOX_EVENT_JOIN_FAILED");
      }
      if (
        previous !== undefined &&
        outbox.engineEventId !== previous.engineEventId
      ) {
        throw new Error("DURABLE_CORE_ENGINE_OUTBOX_ID_ROTATED");
      }
      const previousOwnerToken = engineOwnerTokens.get(runId);
      if (
        previous === undefined &&
        previousOwnerToken !== undefined &&
        previousOwnerToken !== state.engineOwnerToken
      ) {
        throw new Error("DURABLE_CORE_ENGINE_OWNER_CONTINUITY_FAILED");
      }
      engineOwnerTokens.set(runId, state.engineOwnerToken);
      return {
        observation: {
          outboxStatus: outbox.status,
          engineEventId: outbox.engineEventId,
          deliveryKey: outbox.deliveryKey,
          functionRunId: invocation.functionRunId,
          functionEventId: invocation.functionEventId,
          functionEventInternalId: invocation.eventInternalId,
          functionEventReceivedAt: invocation.eventReceivedAt,
          functionEventReceivedAtMicros: invocation.eventReceivedAtMicros,
          functionDefinitionId: invocation.functionDefinitionId,
          functionRunStartedAt: invocation.functionRunStartedAt,
          functionRunStartedAtMicros: invocation.functionRunStartedAtMicros,
          runStatus: state.runStatus,
          engineOwnerPresent: true,
          engineOwnerGeneration: state.engineOwnerGeneration,
          engineOwnerToken: state.engineOwnerToken,
          engineOwnerLeaseExpiresAt: state.engineOwnerLeaseExpiresAt,
          jobStatus: state.jobStatus,
          invocationCount: invocations.length,
          ...(recoverySource === undefined ? {} : { recoverySource }),
        },
        job: {
          applicationId: state.applicationId,
          conversationId: state.conversationId,
          taskId: state.taskId,
          workflowId: state.workflowId,
          workflowVersionId: state.workflowVersionId,
          runId,
          runStepId: state.runStepId,
          sessionId: state.sessionId,
          jobId: state.jobId,
        },
      };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  const diagnostic = await engineInvocationDiagnostics(stack);
  const previousDiagnostic = options.previous === undefined ? null : {
    outboxStatus: options.previous.outboxStatus,
    engineEventId: options.previous.engineEventId,
    deliveryKey: options.previous.deliveryKey,
    functionRunId: options.previous.functionRunId,
    functionEventId: options.previous.functionEventId,
    functionEventInternalId: options.previous.functionEventInternalId,
    functionEventReceivedAt: options.previous.functionEventReceivedAt,
    functionEventReceivedAtMicros:
      options.previous.functionEventReceivedAtMicros,
    functionDefinitionId: options.previous.functionDefinitionId,
    functionRunStartedAt: options.previous.functionRunStartedAt,
    functionRunStartedAtMicros: options.previous.functionRunStartedAtMicros,
    runStatus: options.previous.runStatus,
    engineOwnerPresent: options.previous.engineOwnerPresent,
    engineOwnerGeneration: options.previous.engineOwnerGeneration,
    engineOwnerToken: "[present]",
    engineOwnerLeaseExpiresAt: options.previous.engineOwnerLeaseExpiresAt,
    jobStatus: options.previous.jobStatus,
    invocationCount: options.previous.invocationCount,
    ...(options.previous.recoverySource === undefined
      ? {}
      : { recoverySource: options.previous.recoverySource }),
  };
  throw new Error(
    `DURABLE_CORE_ADMISSION_ENGINE_TIMEOUT:${
      JSON.stringify({
        runId,
        restartBoundary: options.restartBoundary ?? null,
        previous: previousDiagnostic,
        recoveryTrigger: options.recoveryTrigger ?? null,
        candidateDiagnostics: lastCandidateDiagnostics,
        lastState,
        inngestDiagnostic: diagnostic,
      })
    }`,
  );
}

async function admitEngineOwnedActionRun(
  stack: DurableCoreStack,
  identity?: { readonly credential: string },
): Promise<EngineAdmission | SecretIdentityEngineAdmission> {
  await waitForEngineFunctionRegistration(stack);
  const clients = await authenticatedClients(stack);
  const application = await responseJson(
    await postJson(
      clients.producer,
      "/v1/applications",
      {
        slug: `durable-core-${crypto.randomUUID().slice(0, 8)}`,
        name: "Durable Core",
        description: "Issue 43 engine-owned admission",
      },
      `durable-core-application-${crypto.randomUUID()}`,
    ),
    201,
    "APPLICATION_CREATE",
  );
  const applicationId = application.id;
  if (typeof applicationId !== "string" || !UUID.test(applicationId)) {
    throw new Error("DURABLE_CORE_ADMISSION_APPLICATION_ID_MISSING");
  }
  let secretId: string | undefined;
  if (identity) {
    const secret = await responseJson(
      await postJson(
        clients.producer,
        "/v1/secrets",
        {
          applicationId,
          name: "Controlled full-stack identity fixture",
          provider: "github",
          value: identity.credential,
          allowedPrincipalIds: [clients.identity.principalId],
          allowedActions: ["identity.read"],
        },
        `durable-core-secret-${crypto.randomUUID()}`,
      ),
      201,
      "SECRET_CREATE",
    );
    if (typeof secret.id !== "string" || !UUID.test(secret.id)) {
      throw new Error("DURABLE_CORE_ADMISSION_SECRET_ID_MISSING");
    }
    secretId = secret.id;
  }
  const agentVersionId = secretId ? undefined : await createModelAgentVersion(
    stack,
    clients.identity.organizationId,
    clients.identity.principalId,
  );
  const repository = await createRepositoryProfile(
    stack,
    clients.identity.organizationId,
    clients.identity.principalId,
    applicationId,
    agentVersionId,
  );
  const workflow = await createWorkflow(
    stack,
    clients.identity.organizationId,
    clients.identity.principalId,
    secretId
      ? { uses: "secret.identity.read", with: { secretRef: secretId } }
      : undefined,
  );
  const task = await responseJson(
    await postJson(
      clients.producer,
      "/v1/tasks",
      {
        applicationId,
        repositoryId: repository.repositoryId,
        taskType: "maintenance",
        title: "Durable core engine-owned task",
      },
      `durable-core-task-${crypto.randomUUID()}`,
    ),
    201,
    "TASK_CREATE",
  );
  const taskId = task.id;
  if (typeof taskId !== "string" || !UUID.test(taskId)) {
    throw new Error("DURABLE_CORE_ADMISSION_TASK_ID_MISSING");
  }
  const run = await responseJson(
    await postJson(
      clients.producer,
      `/v1/tasks/${taskId}/runs`,
      {
        workflowVersionId: workflow.workflowVersionId,
        executionMode: "repository",
        repositoryProfileId: repository.repositoryProfileId,
        budgetLimitUsd: secretId ? "0.005000" : "0.500000",
        inputs: secretId ? {} : { taskId },
      },
      `durable-core-run-${crypto.randomUUID()}`,
    ),
    201,
    "RUN_CREATE",
  );
  const runId = run.id;
  if (typeof runId !== "string" || !UUID.test(runId)) {
    throw new Error("DURABLE_CORE_ADMISSION_RUN_ID_MISSING");
  }
  await ensureAgentSession(
    stack,
    clients.identity.organizationId,
    runId,
    agentVersionId,
  );
  const admitted = await waitForEngineAdmission(
    stack,
    runId,
    clients.identity.organizationId,
  );
  assertEquals(admitted.job.applicationId, applicationId);
  assertEquals(admitted.job.taskId, taskId);
  assertEquals(admitted.job.workflowId, workflow.workflowId);
  assertEquals(admitted.job.workflowVersionId, workflow.workflowVersionId);
  const result = {
    clients,
    job: admitted.job,
    observation: admitted.observation,
  };
  return secretId ? { ...result, applicationId, secretId } : result;
}

export async function admitEngineOwnedRun(
  stack: DurableCoreStack,
): Promise<EngineAdmission> {
  return await admitEngineOwnedActionRun(stack) as EngineAdmission;
}

export async function admitEngineOwnedSecretIdentityRun(
  stack: DurableCoreStack,
  credential: string,
): Promise<SecretIdentityEngineAdmission> {
  return await admitEngineOwnedActionRun(stack, {
    credential,
  }) as SecretIdentityEngineAdmission;
}

export async function waitForEngineInvocation(
  stack: DurableCoreStack,
  runId: string,
  organizationId: string,
  options: EngineInvocationWaitOptions = {},
): Promise<EngineAdmissionObservation> {
  return (await waitForEngineAdmission(
    stack,
    runId,
    organizationId,
    options,
  )).observation;
}

export async function assertEngineRecoveryStateOpen(
  stack: DurableCoreStack,
  runId: string,
  organizationId: string,
): Promise<void> {
  if (!UUID.test(runId) || !UUID.test(organizationId)) {
    throw new Error("DURABLE_CORE_ENGINE_RECOVERY_STATE_ID_INVALID");
  }
  const rows = await stack.psql<{
    runStatus: string;
    jobStatus: string;
  }>(
    `select run.status as "runStatus",
            job.status as "jobStatus"
       from bakery.workflow_runs as run
       join bakery.run_steps as step
         on step.organization_id = run.organization_id
        and step.run_id = run.id
       join bakery.jobs as job
         on job.organization_id = step.organization_id
        and job.run_step_id = step.id
      where run.organization_id = $1 and run.id = $2
      order by job.created_at
      limit 1`,
    [organizationId, runId],
  );
  const state = rows[0];
  if (!state) {
    throw new Error("DURABLE_CORE_ENGINE_RECOVERY_STATE_MISSING");
  }
  if (
    ["completed", "failed", "canceled", "cancelled"].includes(
      state.runStatus,
    ) ||
    ["completed", "failed", "canceled", "cancelled"].includes(
      state.jobStatus,
    )
  ) {
    throw new Error(
      `DURABLE_CORE_ENGINE_RECOVERY_STATE_TERMINAL:${JSON.stringify(state)}`,
    );
  }
}

export async function assertEngineOwnerLeaseLive(
  stack: DurableCoreStack,
  runId: string,
  organizationId: string,
  owner: Pick<
    EngineAdmissionObservation,
    "engineOwnerToken" | "engineOwnerGeneration" | "engineOwnerLeaseExpiresAt"
  >,
): Promise<{
  readonly checkedAt: string;
  readonly engineOwnerToken: string;
  readonly engineOwnerGeneration: string;
  readonly engineOwnerLeaseExpiresAt: string;
}> {
  if (!UUID.test(runId) || !UUID.test(organizationId)) {
    throw new Error("DURABLE_CORE_ENGINE_OWNER_LIVE_ID_INVALID");
  }
  const rows = await stack.psql<{
    engineOwnerToken: string | null;
    engineOwnerGeneration: string | null;
    leaseExpiresAt: string | null;
    checkedAt: string;
    live: boolean;
  }>(
    `select run.engine_owner_token as "engineOwnerToken",
            run.engine_owner_generation::text as "engineOwnerGeneration",
            run.engine_owner_lease_expires_at as "leaseExpiresAt",
            clock_timestamp() as "checkedAt",
            run.engine_owner_lease_expires_at >
              clock_timestamp() +
                ($3::integer * interval '1 millisecond') as live
       from bakery.workflow_runs as run
      where run.organization_id = $1 and run.id = $2`,
    [organizationId, runId, ENGINE_OWNER_LEASE_SAFETY_MARGIN_MS],
  );
  const row = rows[0];
  if (
    row?.engineOwnerToken === null ||
    row?.engineOwnerToken === undefined ||
    row?.engineOwnerGeneration !== owner.engineOwnerGeneration ||
    row?.leaseExpiresAt === null ||
    row?.live !== true ||
    !Number.isFinite(Date.parse(row?.checkedAt ?? ""))
  ) {
    throw new Error(
      `DURABLE_CORE_ENGINE_OWNER_LEASE_NOT_LIVE:${
        JSON.stringify({
          currentGeneration: row?.engineOwnerGeneration ?? null,
          expectedGeneration: owner.engineOwnerGeneration,
          leaseExpiresAt: row?.leaseExpiresAt ?? null,
          expectedLeaseExpiresAt: owner.engineOwnerLeaseExpiresAt,
          checkedAt: row?.checkedAt ?? null,
          live: row?.live ?? false,
          ownerPresent: row?.engineOwnerToken !== null &&
            row?.engineOwnerToken !== undefined,
        })
      }`,
    );
  }
  return {
    checkedAt: row.checkedAt,
    engineOwnerToken: row.engineOwnerToken,
    engineOwnerGeneration: row.engineOwnerGeneration,
    engineOwnerLeaseExpiresAt: row.leaseExpiresAt,
  };
}

export async function readDatabaseClock(
  stack: DurableCoreStack,
): Promise<string> {
  const rows = await stack.psql<{ now: string }>(
    `select clock_timestamp()::text as "now"`,
  );
  const value = rows[0]?.now;
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error("DURABLE_CORE_DATABASE_CLOCK_INVALID");
  }
  return value;
}

export async function waitForEngineOwnerLeaseExpiry(
  stack: DurableCoreStack,
  runId: string,
  organizationId: string,
  owner: Pick<
    EngineAdmissionObservation,
    "engineOwnerToken" | "engineOwnerGeneration" | "engineOwnerLeaseExpiresAt"
  >,
): Promise<{ readonly expiredAt: string }> {
  if (!UUID.test(runId) || !UUID.test(organizationId)) {
    throw new Error("DURABLE_CORE_ENGINE_OWNER_EXPIRY_ID_INVALID");
  }
  const expiresAtMs = Date.parse(owner.engineOwnerLeaseExpiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error("DURABLE_CORE_ENGINE_OWNER_EXPIRY_TIMESTAMP_INVALID");
  }
  const deadline = Math.max(
    Date.now() + ENGINE_WAIT_TIMEOUT_MS,
    expiresAtMs + 30_000,
  );
  let lastState = "";
  while (Date.now() < deadline) {
    const rows = await stack.psql<{
      engineOwnerToken: string | null;
      engineOwnerGeneration: string | null;
      engineOwnerLeaseExpiresAt: string | null;
      databaseNow: string;
      expired: boolean;
    }>(
      `select run.engine_owner_token as "engineOwnerToken",
              run.engine_owner_generation::text as "engineOwnerGeneration",
              run.engine_owner_lease_expires_at as
                "engineOwnerLeaseExpiresAt",
              clock_timestamp()::text as "databaseNow",
              run.engine_owner_lease_expires_at <= clock_timestamp() as expired
         from bakery.workflow_runs as run
        where run.organization_id = $1 and run.id = $2`,
      [organizationId, runId],
    );
    const row = rows[0];
    lastState = JSON.stringify({
      generation: row?.engineOwnerGeneration ?? null,
      leaseExpiresAt: row?.engineOwnerLeaseExpiresAt ?? null,
      expired: row?.expired ?? false,
    });
    if (
      row?.expired === true &&
      row.engineOwnerToken === owner.engineOwnerToken &&
      row.engineOwnerGeneration === owner.engineOwnerGeneration &&
      Number.isFinite(Date.parse(row.databaseNow))
    ) {
      return { expiredAt: row.databaseNow };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`DURABLE_CORE_ENGINE_OWNER_EXPIRY_TIMEOUT:${lastState}`);
}

function recoveryInvocationSql(
  runId: string,
  recoveryEventId: string,
): string {
  if (!UUID.test(runId)) {
    throw new Error("DURABLE_CORE_RECOVERY_RUN_ID_INVALID");
  }
  if (!ULID.test(recoveryEventId)) {
    throw new Error("DURABLE_CORE_RECOVERY_EVENT_ID_INVALID");
  }
  return `select json_build_object(
                 'recoveryFunctionRunId', encode(function_run.run_id, 'hex'),
                 'recoveryFunctionEventId', event.event_id,
                 'recoveryFunctionRunStartedAt',
                   function_run.run_started_at::text || '+00',
                 'recoveryFunctionRunStartedAtMicros',
                   floor(extract(epoch from function_run.run_started_at) *
                     1000000)::bigint::text,
                 'recoveryEventInternalId', encode(event.internal_id, 'hex'),
                 'recoveryEventReceivedAt', event.received_at::text || '+00',
                 'recoveryEventReceivedAtMicros',
                   floor(extract(epoch from event.received_at) *
                     1000000)::bigint::text,
                 'recoveryEventRunId',
                   event.event_data::jsonb #>> '{runId}',
                 'recoveryFunctionDefinitionId', function_run.function_id::text,
                 'recoveryFunctionSlug', registered_function.slug
               )::text
    from public.function_runs as function_run
    join public.events as event on event.internal_id = function_run.event_id
    join public.functions as registered_function
      on registered_function.id = function_run.function_id
   where registered_function.slug = '${ENGINE_RECOVERY_FUNCTION_SLUG}'
     and event.event_name = 'bakery/workflow.reconcile.v1'
     and event.event_id = '${recoveryEventId}'
     and event.event_data::jsonb #>> '{runId}' = '${runId}'
   order by event.internal_id, function_run.run_started_at,
            function_run.run_id`;
}

export async function waitForWorkflowRecoveryInvocation(
  stack: DurableCoreStack,
  runId: string,
  recoveryEventId: string,
): Promise<EngineRecoveryTriggerObservation> {
  if (!UUID.test(runId) || !ULID.test(recoveryEventId)) {
    throw new Error("DURABLE_CORE_RECOVERY_INVOCATION_INPUT_INVALID");
  }
  const deadline = Date.now() + ENGINE_WAIT_TIMEOUT_MS;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const result = await stack.runOneOff([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "inngest",
      "-d",
      "inngest",
      "-At",
      "-c",
      recoveryInvocationSql(runId, recoveryEventId),
    ]);
    lastOutput = result.output.trim();
    if (!result.success) {
      throw new Error(
        `DURABLE_CORE_RECOVERY_FUNCTION_QUERY_FAILED:${result.output}`,
      );
    }
    const rows = lastOutput.split("\n").filter(Boolean);
    if (rows.length > 1) {
      throw new Error("DURABLE_CORE_RECOVERY_FUNCTION_RUN_NOT_UNIQUE");
    }
    const line = rows[0];
    if (line) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("DURABLE_CORE_RECOVERY_FUNCTION_ROW_INVALID");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("DURABLE_CORE_RECOVERY_FUNCTION_ROW_INVALID");
      }
      const row = parsed as Record<string, unknown>;
      const recoveryFunctionRunId = row.recoveryFunctionRunId;
      const recoveryFunctionEventId = row.recoveryFunctionEventId;
      const recoveryFunctionRunStartedAt = row.recoveryFunctionRunStartedAt;
      const recoveryFunctionRunStartedAtMicros =
        row.recoveryFunctionRunStartedAtMicros;
      const recoveryEventInternalId = row.recoveryEventInternalId;
      const recoveryEventReceivedAt = row.recoveryEventReceivedAt;
      const recoveryEventReceivedAtMicros = row.recoveryEventReceivedAtMicros;
      const recoveryEventRunId = row.recoveryEventRunId;
      const recoveryFunctionDefinitionId = row.recoveryFunctionDefinitionId;
      const recoveryFunctionSlug = row.recoveryFunctionSlug;
      if (
        typeof recoveryFunctionSlug !== "string" ||
        recoveryFunctionSlug !== ENGINE_RECOVERY_FUNCTION_SLUG ||
        typeof recoveryFunctionDefinitionId !== "string" ||
        !UUID.test(recoveryFunctionDefinitionId) ||
        typeof recoveryFunctionRunId !== "string" ||
        !/^[0-9a-f]{32}$/i.test(recoveryFunctionRunId) ||
        typeof recoveryFunctionEventId !== "string" ||
        recoveryFunctionEventId !== recoveryEventId ||
        typeof recoveryEventRunId !== "string" ||
        recoveryEventRunId !== runId ||
        typeof recoveryFunctionRunStartedAt !== "string" ||
        !Number.isFinite(Date.parse(recoveryFunctionRunStartedAt)) ||
        typeof recoveryFunctionRunStartedAtMicros !== "string" ||
        !/^[0-9]+$/.test(recoveryFunctionRunStartedAtMicros) ||
        typeof recoveryEventInternalId !== "string" ||
        !/^[0-9a-f]+$/i.test(recoveryEventInternalId) ||
        typeof recoveryEventReceivedAt !== "string" ||
        !Number.isFinite(Date.parse(recoveryEventReceivedAt)) ||
        typeof recoveryEventReceivedAtMicros !== "string" ||
        !/^[0-9]+$/.test(recoveryEventReceivedAtMicros)
      ) {
        throw new Error("DURABLE_CORE_RECOVERY_FUNCTION_ROW_INVALID");
      }
      return {
        recoveryEventId,
        recoveryFunctionId: recoveryFunctionSlug,
        recoveryFunctionDefinitionId,
        recoveryFunctionRunId,
        recoveryFunctionEventId,
        recoveryFunctionRunStartedAt,
        recoveryFunctionRunStartedAtMicros,
        recoveryEventInternalId,
        recoveryEventReceivedAt,
        recoveryEventReceivedAtMicros,
        runId,
      };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`DURABLE_CORE_RECOVERY_FUNCTION_TIMEOUT:${lastOutput}`);
}

export async function publishWorkflowReconciliation(
  stack: DurableCoreStack,
  runId: string,
): Promise<string> {
  if (!UUID.test(runId)) {
    throw new Error("DURABLE_CORE_RECONCILIATION_RUN_ID_INVALID");
  }
  const response = await fetch(
    `http://127.0.0.1:${stack.ports.inngest}/e/${
      encodeURIComponent("bakery-e2e-event")
    }`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{
        name: "bakery/workflow.reconcile.v1",
        ts: Date.now(),
        data: { runId },
      }]),
    },
  );
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `DURABLE_CORE_RECONCILIATION_EVENT_FAILED:${response.status}:${raw}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("DURABLE_CORE_RECONCILIATION_RESPONSE_INVALID");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("DURABLE_CORE_RECONCILIATION_RESPONSE_INVALID");
  }
  const ids = (body as Record<string, unknown>).ids;
  const eventId = Array.isArray(ids) ? ids[0] : undefined;
  if (
    typeof eventId !== "string" ||
    eventId.trim() === "" ||
    !ULID.test(eventId)
  ) {
    throw new Error("DURABLE_CORE_RECONCILIATION_EVENT_ID_MISSING");
  }
  return eventId;
}
