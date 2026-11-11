import { assertEquals } from "@std/assert";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { readRuntimeConfig } from "../../packages/config/src/env.ts";
import { authRequest, sessionCookie } from "../helpers/auth.ts";
import { type Stack, upStack } from "../e2e/helpers/stack.ts";

type Scope = { principalId: string; organizationId: string };
type Fixture = Scope & { runId: string; attemptId: string };

async function seedUser(stack: Stack, email: string, password: string) {
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  try {
    await createSuperuser({
      pgDatabase: database,
      config: readRuntimeConfig({
        BAKERY_ENV: "test",
        BAKERY_APP_DATABASE_URL: stack.ownerDatabaseUrl,
        BAKERY_PUBLIC_BASE_URL: stack.origin,
        BETTER_AUTH_SECRET: stack.authSecret,
      }).auth!,
    }, { email, displayName: "Control read tester", password });
    const result = await database.query<Scope>(
      `select principal.id as "principalId", membership.organization_id as "organizationId"
         from bakery.principals principal
         join public."user" provider_user on provider_user.id = principal.provider_user_id
         join bakery.organization_memberships membership on membership.principal_id = principal.id
        where provider_user.email = $1`,
      [email],
    );
    if (!result.rows[0]) throw new Error("CONTROL_READ_SCOPE_REQUIRED");
    return result.rows[0];
  } finally {
    await closePgDatabase(database);
  }
}

async function seedOrganization(
  stack: Stack,
  principalId: string,
): Promise<Scope> {
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  const organizationId = crypto.randomUUID();
  try {
    await database.query(
      `insert into bakery.organizations (id, name, slug, created_at, updated_at)
       values ($1, 'Foreign control read organization', $2, clock_timestamp(), clock_timestamp())`,
      [organizationId, `control-foreign-${organizationId}`],
    );
    await database.query(
      `insert into bakery.organization_memberships (id, organization_id, principal_id, role,
         status, joined_at, created_at, updated_at)
       values ($1, $2, $3, 'developer', 'active', clock_timestamp(), clock_timestamp(), clock_timestamp())`,
      [crypto.randomUUID(), organizationId, principalId],
    );
    return { principalId, organizationId };
  } finally {
    await closePgDatabase(database);
  }
}

async function seedRun(
  stack: Stack,
  scope: Scope,
  active = false,
): Promise<Fixture> {
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  const ids = {
    applicationId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    workflowId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    stepId: crypto.randomUUID(),
    jobId: crypto.randomUUID(),
    hostId: crypto.randomUUID(),
    workerPrincipalId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
  };
  const sessionId = crypto.randomUUID();
  try {
    await database.query(
      `insert into bakery.applications (id, organization_id, slug, name)
       values ($1, $2, $3, 'Control read app')`,
      [ids.applicationId, scope.organizationId, `control-${ids.applicationId}`],
    );
    await database.query(
      `insert into bakery.conversations (id, organization_id, application_id, title, created_by)
       values ($1, $2, $3, 'Control read conversation', $4)`,
      [
        ids.conversationId,
        scope.organizationId,
        ids.applicationId,
        scope.principalId,
      ],
    );
    await database.query(
      `insert into bakery.tasks (id, organization_id, application_id, conversation_id, title,
         description, task_type, status, created_by)
       values ($1, $2, $3, $4, 'Control read task', 'real postgres fixture', 'feature', 'queued', $5)`,
      [
        ids.taskId,
        scope.organizationId,
        ids.applicationId,
        ids.conversationId,
        scope.principalId,
      ],
    );
    await database.query(
      `insert into bakery.workflow_definitions (id, organization_id, slug, name)
       values ($1, $2, $3, 'Control read workflow')`,
      [ids.workflowId, scope.organizationId, `control-${ids.workflowId}`],
    );
    await database.query(
      `insert into bakery.workflow_versions (id, organization_id, workflow_id, revision,
         source_yaml, normalized_spec, digest, status, created_by)
       values ($1, $2, $3, 1, 'name: control-read', '{"name":"control-read"}', $4, 'published', $5)`,
      [
        ids.versionId,
        scope.organizationId,
        ids.workflowId,
        `control-${ids.versionId}`,
        scope.principalId,
      ],
    );
    await database.query(
      `insert into bakery.workflow_runs (id, organization_id, task_id, workflow_version_id,
         requested_by, status, snapshot, budget_limit_usd)
       values ($1, $2, $3, $4, $5, 'running', '{"name":"control-read"}', 0)`,
      [
        ids.runId,
        scope.organizationId,
        ids.taskId,
        ids.versionId,
        scope.principalId,
      ],
    );
    await database.query(
      `insert into bakery.run_steps (id, organization_id, run_id, step_key, position, iteration,
         status, input) values ($1, $2, $3, 'inspect', 1, 0, 'running', '{}')`,
      [ids.stepId, scope.organizationId, ids.runId],
    );
    await database.query(
      `insert into bakery.jobs (id, organization_id, run_step_id, action, input, requirements, status, current_fence)
       values ($1, $2, $3, 'harness.implement', '{}', '{}', 'running', 1)`,
      [ids.jobId, scope.organizationId, ids.stepId],
    );
    await database.query(
      `insert into bakery.principals (id, display_name, principal_type)
       values ($1, 'Control read worker', 'worker')`,
      [ids.workerPrincipalId],
    );
    await database.query(
      `insert into bakery.worker_hosts (id, organization_id, principal_id, principal_type, name,
         os, architecture, capabilities, slots, credential_hash, worker_session_id,
         worker_session_generation, adapter_capabilities)
       values ($1, $2, $3, 'worker', 'Control read host', 'linux', 'x64', '[]', 1, $4, $5, 0,
         '["steer","follow_up"]'::jsonb)`,
      [
        ids.hostId,
        scope.organizationId,
        ids.workerPrincipalId,
        `control-${ids.hostId}`,
        sessionId,
      ],
    );
    await database.query(
      `insert into bakery.job_attempts (id, organization_id, job_id, worker_host_id,
         worker_session_id, worker_session_generation, attempt_no, fence, lease_token_hash,
         lease_expires_at, status, started_at)
       values ($1, $2, $3, $4, $5, 0, 1, 1, $6, clock_timestamp() + interval '5 minutes', 'running', clock_timestamp())`,
      [
        ids.attemptId,
        scope.organizationId,
        ids.jobId,
        ids.hostId,
        sessionId,
        `lease-${ids.attemptId}`,
      ],
    );
    if (!active) {
      await database.query(
        `delete from bakery.job_attempts where organization_id = $1 and id = $2`,
        [scope.organizationId, ids.attemptId],
      );
    }
    return { ...scope, runId: ids.runId, attemptId: ids.attemptId };
  } finally {
    await closePgDatabase(database);
  }
}

async function seedShadowingStaleAttempt(stack: Stack, fixture: Fixture) {
  const database = openPgDatabase(stack.ownerDatabaseUrl);
  const stepId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  try {
    await database.query(
      `insert into bakery.run_steps (id, organization_id, run_id, step_key, position, iteration,
         status, input) values ($1, $2, $3, 'stale', 0, 0, 'running', '{}')`,
      [stepId, fixture.organizationId, fixture.runId],
    );
    await database.query(
      `insert into bakery.jobs (id, organization_id, run_step_id, action, input, requirements,
         status, current_fence)
       values ($1, $2, $3, 'harness.implement', '{}', '{}', 'running', 2)`,
      [jobId, fixture.organizationId, stepId],
    );
    await database.query(
      `insert into bakery.job_attempts (id, organization_id, job_id, worker_host_id,
         worker_session_id, worker_session_generation, attempt_no, fence, lease_token_hash,
         lease_expires_at, status, started_at)
       select $1, organization_id, $2, worker_host_id, worker_session_id,
         worker_session_generation, 1, 1, $3, clock_timestamp() + interval '5 minutes',
         'running', clock_timestamp() - interval '10 minutes'
       from bakery.job_attempts
       where organization_id = $4 and id = $5`,
      [
        attemptId,
        jobId,
        `lease-${attemptId}`,
        fixture.organizationId,
        fixture.attemptId,
      ],
    );
  } finally {
    await closePgDatabase(database);
  }
}

Deno.test("control capability read uses real authorization and current lease state", async () => {
  const stack = await upStack("control-capabilities-postgres");
  const email = `control-read-${crypto.randomUUID()}@example.test`;
  const password = `Control-Read-${crypto.randomUUID()}`;
  try {
    const scope = await seedUser(stack, email, password);
    const noAttempt = await seedRun(stack, scope);
    const signIn = await stack.fetch(
      authRequest("/api/auth/sign-in/email", { email, password }),
    );
    assertEquals(signIn.status, 200);
    const cookie = sessionCookie(signIn);
    const get = (organizationId: string, runId: string) =>
      stack.fetch(
        new Request(
          `${stack.origin}/v1/runs/${runId}/controls`,
          { headers: { cookie, "Bakery-Organization-Id": organizationId } },
        ),
      );
    const read = async (runId: string) => {
      const response = await get(scope.organizationId, runId);
      const body = await response.json() as {
        actions?: Array<{ action: string; canRequest: boolean }>;
        code?: string;
      };
      assertEquals(response.status, 200, JSON.stringify(body));
      if (!body.actions) throw new Error("CONTROL_ACTIONS_REQUIRED");
      return body as {
        actions: Array<{ action: string; canRequest: boolean }>;
      };
    };

    assertEquals(
      (await read(noAttempt.runId)).actions.every((action) =>
        !action.canRequest
      ),
      true,
    );
    const active = await seedRun(stack, scope, true);
    assertEquals(
      (await read(active.runId)).actions.every((action) => action.canRequest),
      true,
    );
    await seedShadowingStaleAttempt(stack, active);
    assertEquals(
      (await read(active.runId)).actions.every((action) => action.canRequest),
      true,
    );

    const database = openPgDatabase(stack.ownerDatabaseUrl);
    try {
      await database.query(
        `update bakery.job_attempts set lease_expires_at = clock_timestamp() - interval '1 second'
          where organization_id = $1 and id = $2`,
        [scope.organizationId, active.attemptId],
      );
    } finally {
      await closePgDatabase(database);
    }
    assertEquals(
      (await read(active.runId)).actions.map(({ action, canRequest }) => ({
        action,
        canRequest,
      })),
      [
        { action: "pause", canRequest: false },
        { action: "resume", canRequest: true },
        { action: "cancel", canRequest: false },
        { action: "interrupt", canRequest: false },
      ],
    );

    const sourceId = crypto.randomUUID();
    const importRunId = crypto.randomUUID();
    await stack.psql(
      `insert into bakery.skill_sources
         (id, organization_id, source_type, locator, display_name)
       values ($1, $2, 'git', 'https://example.test/fixture.git', 'Control kind fixture')`,
      [sourceId, scope.organizationId],
    );
    await stack.psql(
      `insert into bakery.workflow_runs
         (id, organization_id, kind, skill_source_id, requested_by, status, snapshot)
       values ($1, $2, 'skill_import', $3, $4, 'running', '{}')`,
      [importRunId, scope.organizationId, sourceId, scope.principalId],
    );
    const unsupported = await get(scope.organizationId, importRunId);
    assertEquals(unsupported.status, 409);
    const unsupportedBody = await unsupported.json();
    assertEquals(unsupportedBody.code, "STATE_CONFLICT");
    // The public problem encoder strips internal params; the unit test retains
    // the exact run_kind_unsupported reason. No capability snapshot is returned.
    assertEquals(unsupportedBody.actions, undefined);
    assertEquals(
      unsupported.headers.get("content-type")?.split(";", 1)[0],
      "application/problem+json",
    );

    const otherScope = await seedOrganization(stack, scope.principalId);
    const otherRun = await seedRun(stack, otherScope);
    assertEquals((await get(scope.organizationId, otherRun.runId)).status, 404);
  } finally {
    await stack.down();
  }
});
