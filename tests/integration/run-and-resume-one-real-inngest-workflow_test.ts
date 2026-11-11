import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Hono } from "hono";
import { Inngest } from "inngest";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
} from "../../apps/server/src/modules/auth/migrations.ts";
import {
  bakeryPlatformMigrationSource,
  loadMigrations,
  migrate,
  migrateProvider,
} from "../../apps/server/src/platform/migrate.ts";
import {
  workBakeryMigrationSource,
} from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { createInngestHttpHandler } from "../../apps/server/src/modules/execution/inngest-http.ts";
import { appendDomainEvent, withPgTransaction } from "@bakery/persistence";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import type { LogicalInvocationKey } from "../../apps/server/src/modules/workflow-adapter/invocation-contract.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { RepositoryExecutionContextSchema } from "../../packages/contracts/src/repository-inspection.ts";
import {
  closeWorkerOrganization,
  workerFixtureCapabilities,
} from "../helpers/worker-execution.ts";
import {
  fundedModelPolicy,
  seedAdmissibleRun,
  seedProviderPricingSnapshot,
} from "../helpers/funded-model-job.ts";

const signingKey = "0123456789abcdef0123456789abcdef";
const openConfig = {
  signingKey,
  eventKey: "integration-event-key",
  baseUrl: "http://127.0.0.1:8288",
  serveOrigin: "http://127.0.0.1:8000",
  maxBodyBytes: 32,
  waitMs: 1,
  jobCompletionTimeout: "5m",
  engineRetries: 3,
  maxAttempts: 3,
};
const securedConfig = openConfig;

function key(runId: string, actionVersion: string): LogicalInvocationKey {
  return {
    runId,
    stepKey: "step_1",
    iteration: 0,
    actionVersion,
  };
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

Deno.test("official Inngest Hono handler authenticates sync and bounds bodies", async () => {
  const client = new Inngest({
    id: "integration-test",
    baseUrl: openConfig.baseUrl,
    isDev: true,
  });
  const testFunction = client.createFunction(
    {
      id: "integration-fixed-workflow",
      triggers: [{ event: "integration/test" }],
    },
    () => ({ ok: true }),
  );
  const app = new Hono();
  app.all(
    "/api/inngest",
    createInngestHttpHandler({
      config: openConfig,
      client,
      functions: [testFunction],
    }),
  );
  const discovery = await app.fetch(
    new Request("http://localhost/api/inngest", { method: "GET" }),
  );
  assertEquals(discovery.status, 200);
  const discoveryBody = await discovery.json() as { function_count?: number };
  assertEquals(discoveryBody.function_count, 1);

  const securedApp = new Hono();
  securedApp.all(
    "/api/inngest",
    createInngestHttpHandler({ config: securedConfig, functions: [] }),
  );
  const unsignedSync = await securedApp.fetch(
    new Request("http://localhost/api/inngest", {
      method: "PUT",
      body: "{}",
    }),
  );
  assertEquals(unsignedSync.status, 401);
  const invalidSignature = await securedApp.fetch(
    new Request("http://localhost/api/inngest", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-inngest-signature": "t=0,v1=deadbeef",
      },
      body: "{}",
    }),
  );
  assertEquals(invalidSignature.status, 401);

  const oversized = await app.fetch(
    new Request("http://localhost/api/inngest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "33",
      },
      body: "{}",
    }),
  );
  assertEquals(oversized.status, 413);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(33));
      controller.close();
    },
    cancel() {
      return new Promise<void>(() => {});
    },
  });
  let chunkedBodyTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const chunked = await Promise.race([
      app.fetch(
        new Request("http://localhost/api/inngest", {
          method: "POST",
          body,
          headers: { "content-type": "application/json" },
        }),
      ),
      new Promise<Response>((_, reject) => {
        chunkedBodyTimeout = setTimeout(
          () => reject(new Error("CHUNKED_BODY_LIMIT_TIMEOUT")),
          250,
        );
      }),
    ]);
    assertEquals(chunked.status, 413);
  } finally {
    clearTimeout(chunkedBodyTimeout);
  }
});
Deno.test("Postgres admission and concurrent delivery are durable", async () => {
  const { databaseUrl } = readTestDatabaseConfig();
  const owner = openDatabase(databaseUrl);
  const provider = openPgDatabase(databaseUrl);
  const database = openPgDatabase(databaseUrl, 4);
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const now = new Date();
  try {
    await migrateProvider(
      provider,
      await loadMigrations(betterAuthMigrationSource),
    );
    await migrate(owner, [
      ...await loadMigrations(bakeryPlatformMigrationSource),
      ...await loadMigrations(authBakeryMigrationSource),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
    ]);
    await migrateData(owner, bakeryDataMigrations);
    await owner`
      insert into bakery.principals (id, display_name, principal_type)
      values (${principalId}, 'Issue 40 Test Service', 'service')`;
    await owner`
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values (
        ${organizationId}, 'Issue 40 Test Organization',
        ${`issue-40-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1
      )`;
    const resolvedInput = {
      repositoryId: crypto.randomUUID(),
      planArtifact: crypto.randomUUID(),
    };
    // Seed prerequisites only: the two concurrent calls below must create the job.
    const seeded = await seedAdmissibleRun(
      database,
      organizationId,
      principalId,
      { stepKey: "step_1", input: resolvedInput },
    );
    assert(seeded.agent);
    assert(seeded.billing);
    await seedProviderPricingSnapshot(database, { billing: seeded.billing });
    const {
      applicationId,
      conversationId,
      repositoryId,
      profileId: repositoryProfileId,
      taskId,
      workflowId,
      workflowVersionId,
      runId,
      runStepId,
    } = seeded;
    const repositoryProfile = RepositoryExecutionContextSchema.parse(
      seeded.profile,
    );
    const profileDigest = repositoryProfile.digest;
    const workflowSpec = {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: `issue40-${workflowId.slice(0, 8)}`,
      workflow: { kind: "fixed" },
      agents: { "harness.implement": seeded.agent.agentVersionId },
      steps: [{
        id: "step_1",
        uses: "harness.implement",
        with: {
          repositoryId: "$task.repositoryId",
          planArtifact: "$input.planArtifact",
        },
      }],
    };
    const workflowDigest = await sha256Hex(canonicalJson(workflowSpec));
    const snapshot = {
      schemaVersion: 1,
      executionMode: "repository",
      inputs: { planArtifact: resolvedInput.planArtifact },
      workflow: {
        id: workflowVersionId,
        revision: 1,
        digest: workflowDigest,
        normalizedSpec: workflowSpec,
      },
      repositoryProfile,
      stepAgents: { step_1: seeded.agent },
      admission: { dependencies: [], status: "queued", reason: null },
    };
    await owner`
      update bakery.repositories set active_profile_id = ${repositoryProfileId}
       where organization_id = ${organizationId} and id = ${repositoryId}`;
    await provider.query(
      `update bakery.workflow_versions
          set source_yaml = $3::text, normalized_spec = $3::jsonb, digest = $4
        where organization_id = $1 and id = $2`,
      [
        organizationId,
        workflowVersionId,
        JSON.stringify(workflowSpec),
        workflowDigest,
      ],
    );
    await provider.query(
      `update bakery.workflow_runs set status = 'queued', snapshot = $3::jsonb
        where organization_id = $1 and id = $2`,
      [organizationId, runId, JSON.stringify(snapshot)],
    );
    const requestTraceId = (await owner`
      select trace_id from bakery.domain_events
       where organization_id = ${organizationId} and aggregate_id = ${runId}
         and event_type = 'run.requested'
    `)[0].trace_id;

    const repository = createBakeryPostgresWorkflowRepository({
      database,
      maxAttempts: 3,
      budgetPolicy: fundedModelPolicy,
    });
    const logical = await repository.findNext(runId);
    assert(logical);
    const expected = key(runId, workflowVersionId);
    assertEquals(logical, expected);
    const admissions = await Promise.all([
      repository.admit(logical),
      repository.admit(logical),
    ]);
    assertEquals(admissions.map((entry) => entry.terminal), [false, false]);
    const jobs = await owner`
      select id, action, input, max_attempts, agent_version_id, billing,
             installation_reservation_id
        from bakery.jobs
       where organization_id = ${organizationId}
         and run_step_id = ${runStepId}`;
    assertEquals(jobs.length, 1);
    assertEquals(jobs[0].action, "harness.implement");
    assertEquals(jobs[0].input, {
      ...resolvedInput,
      repositoryProfile,
    });
    assertEquals(jobs[0].max_attempts, 3);
    assertEquals(jobs[0].agent_version_id, seeded.agent.agentVersionId);
    assertEquals(jobs[0].billing, seeded.billing);
    assert(jobs[0].installation_reservation_id);
    const holds = await owner`
      select intent.installation_reservation_id, intent.run_reservation_id,
             installation.status as installation_status, run_hold.status as run_status
        from bakery.budget_action_intents intent
        join bakery.budget_reservations installation
          on installation.id = intent.installation_reservation_id
        join bakery.budget_reservations run_hold
          on run_hold.id = intent.run_reservation_id
       where intent.organization_id = ${organizationId}
         and intent.run_step_id = ${runStepId}`;
    assertEquals(holds.length, 1);
    assertEquals(
      holds[0].installation_reservation_id,
      jobs[0].installation_reservation_id,
    );
    assert(holds[0].run_reservation_id);
    assertEquals(holds[0].installation_status, "held");
    assertEquals(holds[0].run_status, "held");
    const ownerA = await repository.acquireEngineOwner(
      runId,
      "issue40-owner-a",
      60_000,
    );
    assert(ownerA);
    assertEquals(
      await repository.acquireEngineOwner(runId, "issue40-owner-b", 60_000),
      undefined,
    );
    assertEquals(await repository.renewEngineOwner(ownerA), true);
    assertEquals(await repository.releaseEngineOwner(ownerA), true);
    const ownerC = await repository.acquireEngineOwner(
      runId,
      "issue40-owner-c",
      60_000,
    );
    assert(ownerC);
    await repository.markEngineFailure(
      runId,
      "WORKFLOW_ENGINE_FAILURE",
      ownerA.token,
    );
    assertEquals(
      (await owner`
      select status from bakery.workflow_runs
       where organization_id = ${organizationId} and id = ${runId}
    `)[0].status,
      "running",
    );
    await repository.markEngineFailure(
      runId,
      "WORKFLOW_ENGINE_FAILURE",
      ownerC,
    );
    assertEquals(await repository.releaseEngineOwner(ownerC), false);
    const failureState = await owner`
      select run.status as run_status,
             run.engine_owner_token as owner_token,
             run.engine_owner_lease_expires_at as owner_lease,
             step.status as step_status,
             step.error,
             task.status as task_status,
             task.current_run_id
        from bakery.workflow_runs run
        join bakery.run_steps step
          on step.organization_id = run.organization_id
         and step.run_id = run.id
        join bakery.tasks task
          on task.organization_id = run.organization_id
         and task.id = run.task_id
       where run.organization_id = ${organizationId}
         and run.id = ${runId}`;
    assertEquals(failureState[0].run_status, "failed");
    assertEquals(failureState[0].owner_token, null);
    assertEquals(failureState[0].owner_lease, null);
    assertEquals(failureState[0].step_status, "failed");
    assertEquals(failureState[0].task_status, "failed");
    assertEquals(failureState[0].current_run_id, runId);
    assertEquals(failureState[0].error, {
      code: "WORKFLOW_ENGINE_FAILURE",
      message: "WORKFLOW_ENGINE_FAILURE",
    });
    const lifecycleEvents = await owner`
      select event_type, aggregate_id, application_id, repository_id,
             task_id, conversation_id, trace_id
        from bakery.domain_events
       where organization_id = ${organizationId}
         and aggregate_id in (${runId}, ${taskId}, ${jobs[0].id})
       order by sequence`;
    assertEquals(
      lifecycleEvents.map((event) => event.event_type),
      ["run.requested", "run.updated", "run.updated", "tasks.updated"],
    );
    assertEquals(
      lifecycleEvents.some((event) => event.event_type === "job.updated"),
      false,
    );
    for (const event of lifecycleEvents) {
      assertEquals(event.application_id, applicationId);
      assertEquals(event.repository_id, repositoryId);
      assertEquals(event.task_id, taskId);
      assertEquals(event.conversation_id, conversationId);
      assertEquals(event.trace_id, requestTraceId);
    }
    const expiryTaskId = crypto.randomUUID();
    const expiryRunId = crypto.randomUUID();
    const expiryStepId = crypto.randomUUID();
    const expiryTraceId = crypto.randomUUID();
    await owner`
      insert into bakery.tasks (
        id, organization_id, application_id, repository_id, conversation_id,
        parent_task_id, title, description, task_type, status, created_by,
        repository_profile_id, repository_profile_revision, repository_profile_digest,
        observation_id, observation_digest, base_sha
      ) values (
        ${expiryTaskId}, ${organizationId}, ${applicationId}, ${repositoryId},
        ${conversationId}, null, 'Issue 40 lease expiry', '', 'feature',
        'queued', ${principalId}, ${repositoryProfileId}, 1, ${profileDigest},
        null, null, null
      )`;
    await provider.query(
      `insert into bakery.workflow_runs (
        id, organization_id, task_id, workflow_version_id, requested_by,
        status, snapshot, created_at, updated_at, version, budget_limit_usd,
        application_id, repository_id, repository_profile_id,
        repository_profile_revision, repository_profile_digest,
        observation_id, observation_digest, base_sha
      ) values (
        $1, $2, $3, $4, $5, 'queued', $6::jsonb, $7, $7, 1, '1.000000',
        $8, $9, $10, 1, $11, null, null, null
      )`,
      [
        expiryRunId,
        organizationId,
        expiryTaskId,
        workflowVersionId,
        principalId,
        JSON.stringify(snapshot),
        now,
        applicationId,
        repositoryId,
        repositoryProfileId,
        profileDigest,
      ],
    );
    await owner`
      update bakery.tasks
         set current_run_id = ${expiryRunId}
       where organization_id = ${organizationId} and id = ${expiryTaskId}`;
    await owner`
      insert into bakery.run_steps (
        id, organization_id, run_id, step_key, position, iteration, status, input
      ) values (
        ${expiryStepId}, ${organizationId}, ${expiryRunId}, 'step_1', 1, 0,
        'pending', ${owner.json(resolvedInput)}
      )`;
    await withPgTransaction(
      provider,
      (transaction) =>
        appendDomainEvent(transaction, {
          organizationId,
          applicationId,
          repositoryId,
          taskId: expiryTaskId,
          conversationId,
          eventType: "run.requested",
          aggregateId: expiryRunId,
          aggregateVersion: 1,
          payload: { runId: expiryRunId },
          traceId: expiryTraceId,
        }),
    );
    const expiryLogical = await repository.findNext(expiryRunId);
    assert(expiryLogical);
    await repository.admit(expiryLogical);
    const expiryStateWithoutAttempts = await repository.read(expiryLogical);
    assert(expiryStateWithoutAttempts);
    assertEquals(expiryStateWithoutAttempts.liveAttempts, 0);
    const expiryJobId = (await owner`
      select id
        from bakery.jobs
       where organization_id = ${organizationId}
         and run_step_id = ${expiryStepId}
    `)[0]?.id;
    if (!expiryJobId) throw new Error("EXPIRY_JOB_MISSING");
    const expiryHostId = crypto.randomUUID();
    const expirySessionId = crypto.randomUUID();
    const expiryPrincipalId = crypto.randomUUID();
    await owner`
      insert into bakery.principals (id, display_name, principal_type)
      values (${expiryPrincipalId}, 'Issue 40 expiry worker', 'service')`;
    await owner`
      insert into bakery.worker_hosts (
        id, organization_id, principal_id, principal_type, name, os,
        architecture, capabilities, slots, credential_hash
      ) values (
        ${expiryHostId}, ${organizationId}, ${expiryPrincipalId}, 'service',
        'Issue 40 expiry host', 'linux', 'x64',
        ${owner.json(workerFixtureCapabilities)}, 1,
        ${`issue40-expiry-${crypto.randomUUID()}`}
      )`;
    const expiryAttemptId = crypto.randomUUID();
    await owner`
      insert into bakery.job_attempts (
        id, organization_id, job_id, worker_host_id, worker_session_id,
        worker_session_generation, attempt_no, fence, lease_token_hash,
        lease_expires_at, status, result, started_at, ended_at
      ) values (
        ${expiryAttemptId}, ${organizationId}, ${expiryJobId}, ${expiryHostId},
        ${expirySessionId}, 0, 1, 1, ${`issue40-lease-${crypto.randomUUID()}`},
        now(), 'running', null, now(), null
      )`;
    const expiryStateWithLiveAttempt = await repository.read(expiryLogical);
    assert(expiryStateWithLiveAttempt);
    assertEquals(expiryStateWithLiveAttempt.liveAttempts, 1);
    await owner`
      update bakery.job_attempts
         set status = 'completed', result = '{}'::jsonb, ended_at = now()
       where organization_id = ${organizationId} and id = ${expiryAttemptId}
    `;
    const expiryOwner = await repository.acquireEngineOwner(
      expiryRunId,
      "issue40-expiry-owner",
      1_000,
    );
    assert(expiryOwner);
    const waitForEventClockWait = async (): Promise<void> => {
      let blocked = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const activity = await owner`
          select count(*)::int as count
            from pg_stat_activity
           where state = 'active'
             and wait_event_type = 'Lock'
             and query like '%insert into bakery.event_clock%';
        `;
        if (Number(activity[0]?.count ?? 0) > 0) {
          blocked = true;
          break;
        }
        await delay(25);
      }
      assertEquals(blocked, true);
    };
    const waitForExpiry = async (): Promise<void> => {
      let expired = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const state = await owner`
          select engine_owner_lease_expires_at <= clock_timestamp() as expired
            from bakery.workflow_runs
           where organization_id = ${organizationId} and id = ${expiryRunId}
        `;
        if (state[0]?.expired === true) {
          expired = true;
          break;
        }
        await delay(25);
      }
      assertEquals(expired, true);
    };
    const lockClient = await database.connect();
    let handoff: Promise<boolean> | undefined;
    try {
      await lockClient.query("begin");
      await lockClient.query(
        `select 1
           from bakery.event_clock
          where organization_id = $1 and stream = 'domain_events'
          for update`,
        [organizationId],
      );
      handoff = repository.handoffEngineOwner(expiryOwner);
      await waitForEventClockWait();
      await waitForExpiry();
      await lockClient.query("rollback");
      await assertRejects(
        () => handoff!,
        Error,
        "WORKFLOW_OWNER_HANDOFF_CONFLICT",
      );
      handoff = undefined;
    } finally {
      await lockClient.query("rollback").catch(() => {});
      lockClient.release();
      if (handoff) await handoff;
    }
    const handoffState = await owner`
      select run.engine_owner_token as owner_token,
             count(*) filter (
               where event.event_type = 'run.requested'
             )::int as request_count
        from bakery.workflow_runs run
        left join bakery.domain_events event
          on event.organization_id = run.organization_id
         and event.aggregate_id = run.id
       where run.organization_id = ${organizationId}
         and run.id = ${expiryRunId}
       group by run.engine_owner_token`;
    assertEquals(handoffState[0], {
      owner_token: expiryOwner.token,
      request_count: 1,
    });
    const expiryFailureOwner = await repository.acquireEngineOwner(
      expiryRunId,
      "issue40-expiry-failure-owner",
      1_000,
    );
    assert(expiryFailureOwner);
    const failureLockClient = await database.connect();
    let projection: Promise<void> | undefined;
    try {
      await failureLockClient.query("begin");
      await failureLockClient.query(
        `select 1
           from bakery.event_clock
          where organization_id = $1 and stream = 'domain_events'
          for update`,
        [organizationId],
      );
      projection = repository.markEngineFailure(
        expiryRunId,
        "WORKFLOW_ENGINE_FAILURE",
        expiryFailureOwner,
      );
      await waitForEventClockWait();
      await waitForExpiry();
      await failureLockClient.query("rollback");
      await assertRejects(
        () => projection!,
        Error,
        "WORKFLOW_FAILURE_PROJECTION_CONFLICT",
      );
      projection = undefined;
    } finally {
      await failureLockClient.query("rollback").catch(() => {});
      failureLockClient.release();
      if (projection) await projection;
    }
    const expiryState = await owner`
      select run.status as run_status,
             run.engine_owner_token as owner_token,
             step.status as step_status,
             task.status as task_status
        from bakery.workflow_runs run
        join bakery.run_steps step
          on step.organization_id = run.organization_id
         and step.run_id = run.id
        join bakery.tasks task
          on task.organization_id = run.organization_id
         and task.id = run.task_id
       where run.organization_id = ${organizationId}
         and run.id = ${expiryRunId}`;
    assertEquals(expiryState[0], {
      run_status: "running",
      owner_token: expiryFailureOwner.token,
      step_status: "running",
      task_status: "queued",
    });
  } finally {
    try {
      await closeWorkerOrganization(database, organizationId);
      await database.query("delete from bakery.principals where id = $1", [
        principalId,
      ]);
    } finally {
      await closePgDatabase(database);
      await closePgDatabase(provider);
      await closeDatabase(owner);
    }
  }
});
