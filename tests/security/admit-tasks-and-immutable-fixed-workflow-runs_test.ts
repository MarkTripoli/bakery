import { assertEquals, assertRejects } from "@std/assert";
import type {
  PgDatabase,
  PgTransactionClient,
} from "../../apps/server/src/platform/database.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  authTestOrigin,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";

const { adminDatabaseUrl } = readTestDatabaseConfig(
  Deno.env.toObject(),
  { requireAdmin: true },
);
const now = new Date();

type SeededScope = {
  organizationId: string;
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  taskId: string;
  stepIds: string[];
};

async function seedRun(
  pgDatabase: PgTransactionClient,
  principalId: string,
  organizationId: string,
  label: string,
): Promise<SeededScope> {
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const workflowVersionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const stepIds = [crypto.randomUUID(), crypto.randomUUID()];
  const workflowSpec = {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    name: `${label}-workflow`,
    steps: [
      { id: "review", uses: "review.independent" },
      { id: "research", uses: "rpi.research" },
    ],
  };

  await pgDatabase.query(
    `insert into bakery.applications (
       id, organization_id, slug, name, description
     ) values ($1, $2, $3, $4, '')`,
    [
      applicationId,
      organizationId,
      `${label}-${applicationId}`,
      `${label} application`,
    ],
  );
  await pgDatabase.query(
    `insert into bakery.conversations (
       id, organization_id, application_id, repository_id, title,
       created_by, created_at, updated_at, version
     ) values ($1, $2, $3, null, $4, $5, $6, $6, 1)`,
    [
      conversationId,
      organizationId,
      applicationId,
      `${label} conversation`,
      principalId,
      now,
    ],
  );
  await pgDatabase.query(
    `insert into bakery.tasks (
       id, organization_id, application_id, repository_id, conversation_id,
       title, description, task_type, status, priority, created_by,
       created_at, updated_at, version
     ) values ($1, $2, $3, null, $4, $5, '', 'feature', 'draft', 50, $6, $7, $7, 1)`,
    [
      taskId,
      organizationId,
      applicationId,
      conversationId,
      `${label} task`,
      principalId,
      now,
    ],
  );
  await pgDatabase.query(
    `insert into bakery.workflow_definitions (
       id, organization_id, slug, name, enabled, version
     ) values ($1, $2, $3, $4, true, 1)`,
    [workflowId, organizationId, `${label}-${workflowId}`, `${label} workflow`],
  );
  await pgDatabase.query(
    `insert into bakery.workflow_versions (
       id, organization_id, workflow_id, revision, source_yaml,
       normalized_spec, digest, status, created_by, created_at, updated_at, version
     ) values ($1, $2, $3, 1, '', $4::jsonb, $5, 'published', $6, $7, $7, 1)`,
    [
      workflowVersionId,
      organizationId,
      workflowId,
      JSON.stringify(workflowSpec),
      "0".repeat(64),
      principalId,
      now,
    ],
  );
  await pgDatabase.query(
    `update bakery.workflow_definitions
        set active_version_id = $1, updated_at = $2
      where organization_id = $3 and id = $4`,
    [workflowVersionId, now, organizationId, workflowId],
  );
  await pgDatabase.query(
    `insert into bakery.workflow_runs (
       id, organization_id, task_id, workflow_version_id,
       repository_profile_id, requested_by, inngest_run_id, status,
       snapshot, budget_limit_usd, created_at, updated_at, version
     ) values ($1, $2, $3, $4, null, $5, null, 'queued', $6::jsonb, 0, $7, $7, 1)`,
    [
      runId,
      organizationId,
      taskId,
      workflowVersionId,
      principalId,
      JSON.stringify({ label, taskId, organizationId }),
      now,
    ],
  );
  await pgDatabase.query(
    `update bakery.tasks
        set current_run_id = $1, updated_at = $2
      where organization_id = $3 and id = $4`,
    [runId, now, organizationId, taskId],
  );
  await pgDatabase.query(
    `insert into bakery.run_steps (
       id, organization_id, run_id, step_key, position, iteration,
       status, input, output, error, created_at, updated_at, version
     ) values
       ($1, $2, $3, 'review', 0, 0, 'pending', $4::jsonb, null, null, $6, $6, 1),
       ($5, $2, $3, 'research', 1, 0, 'pending', $4::jsonb, null, null, $6, $6, 1)`,
    [
      stepIds[0],
      organizationId,
      runId,
      JSON.stringify({ label, taskId }),
      stepIds[1],
      now,
    ],
  );
  return {
    organizationId,
    runId,
    workflowId,
    workflowVersionId,
    taskId,
    stepIds,
  };
}
type SeededDependencyScope = {
  organizationId: string;
  taskIds: string[];
};

async function seedDependencyScope(
  pgDatabase: PgDatabase,
  principalId: string,
  organizationId: string,
  label: string,
): Promise<SeededDependencyScope> {
  const applicationId = crypto.randomUUID();
  await pgDatabase.query(
    `insert into bakery.applications (
       id, organization_id, slug, name, description
     ) values ($1, $2, $3, $4, '')`,
    [
      applicationId,
      organizationId,
      `${label}-${applicationId}`,
      `${label} application`,
    ],
  );
  const taskIds = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ];
  for (const [index, taskId] of taskIds.entries()) {
    const conversationId = crypto.randomUUID();
    await pgDatabase.query(
      `insert into bakery.conversations (
         id, organization_id, application_id, repository_id, title,
         created_by, created_at, updated_at, version
       ) values ($1, $2, $3, null, $4, $5, $6, $6, 1)`,
      [
        conversationId,
        organizationId,
        applicationId,
        `${label} conversation ${index}`,
        principalId,
        now,
      ],
    );
    await pgDatabase.query(
      `insert into bakery.tasks (
         id, organization_id, application_id, repository_id, conversation_id,
         title, description, task_type, status, priority, created_by,
         created_at, updated_at, version
       ) values ($1, $2, $3, null, $4, $5, '', 'feature', 'draft', 50, $6, $7, $7, 1)`,
      [
        taskId,
        organizationId,
        applicationId,
        conversationId,
        `${label} task ${index}`,
        principalId,
        now,
      ],
    );
  }
  return { organizationId, taskIds };
}
type SecurityFixtureResources = {
  organizationIds: string[];
  principalIds: string[];
  providerUserIds: string[];
  sessionTokens: string[];
};

async function cleanupSecurityFixture(
  pgDatabase: PgDatabase,
  resources: SecurityFixtureResources,
): Promise<void> {
  const organizationIds = resources.organizationIds;
  const principalIds = resources.principalIds;
  if (organizationIds.length > 0) {
    await pgDatabase.query(
      `delete from bakery.outbox
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.run_steps
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.workflow_runs
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.task_dependencies
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.workflow_versions
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.workflow_definitions
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.audit_events
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.domain_events
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.idempotency_records
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.tasks
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.conversations
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.repository_profiles
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.repositories
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.applications
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.organization_invitations
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.organization_memberships
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.event_clock
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    await pgDatabase.query(
      `delete from bakery.organizations
        where id = any($1::uuid[])`,
      [organizationIds],
    );
  }
  if (principalIds.length > 0) {
    await pgDatabase.query(
      `delete from bakery.installation_administrators
        where principal_id = any($1::uuid[])
           or granted_by_principal_id = any($1::uuid[])`,
      [principalIds],
    );
    await pgDatabase.query(
      `delete from bakery.idempotency_records
        where principal_id = any($1::uuid[])`,
      [principalIds],
    );
    await pgDatabase.query(
      `delete from bakery.permission_grants
        where principal_id = any($1::uuid[])
           or granted_by_principal_id = any($1::uuid[])`,
      [principalIds],
    );
    await pgDatabase.query(
      `delete from bakery.principals
        where id = any($1::uuid[])`,
      [principalIds],
    );
  }
  if (resources.sessionTokens.length > 0) {
    await pgDatabase.query(
      `delete from public.session where token = any($1::text[])`,
      [resources.sessionTokens],
    );
  }
  if (resources.providerUserIds.length > 0) {
    await pgDatabase.query(
      `delete from public."user" where id = any($1::uuid[])`,
      [resources.providerUserIds],
    );
  }
}

Deno.test("production run and step reads isolate real PostgreSQL organizations", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `issue36-security-${suffix}@example.test`;
  const userId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const organizationA = crypto.randomUUID();
  const organizationB = crypto.randomUUID();
  const resources: SecurityFixtureResources = {
    organizationIds: [organizationA, organizationB],
    principalIds: [],
    providerUserIds: [],
    sessionTokens: [],
  };
  try {
    await fixture.pgDatabase.query(
      `insert into public."user" (
         id, name, email, "emailVerified", "createdAt", "updatedAt"
       ) values ($1, $2, $3, true, $4, $4)`,
      [userId, "Issue 36 Security Principal", email, now],
    );
    resources.providerUserIds.push(userId);
    await fixture.pgDatabase.query(
      `insert into bakery.principals (
         id, provider_user_id, display_name, principal_type
       ) values ($1, $2, $3, 'human')`,
      [principalId, userId, "Issue 36 Security Principal"],
    );
    resources.principalIds.push(principalId);
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (
         id, name, slug, metadata, created_at, updated_at, version
       ) values
         ($1, 'Issue 36 Organization A', $3, '{}'::jsonb, $4, $4, 1),
         ($2, 'Issue 36 Organization B', $5, '{}'::jsonb, $4, $4, 1)`,
      [
        organizationA,
        organizationB,
        `issue36-a-${suffix}`,
        now,
        `issue36-b-${suffix}`,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id, organization_id, principal_id, role, status,
         joined_at, created_at, updated_at, version
       ) values
         ($1, $2, $4, 'developer', 'active', $5, $5, $5, 1),
         ($3, $6, $4, 'developer', 'active', $5, $5, $5, 1)`,
      [
        crypto.randomUUID(),
        organizationA,
        crypto.randomUUID(),
        principalId,
        now,
        organizationB,
      ],
    );

    const scopeA = await seedRun(
      fixture.pgDatabase,
      principalId,
      organizationA,
      "org-a",
    );
    const scopeB = await seedRun(
      fixture.pgDatabase,
      principalId,
      organizationB,
      "org-b",
    );
    const dependencyScopeA = await seedDependencyScope(
      fixture.pgDatabase,
      principalId,
      organizationA,
      "org-a-dependencies",
    );

    const dependencyScopeB = await seedDependencyScope(
      fixture.pgDatabase,
      principalId,
      organizationB,
      "org-b-dependencies",
    );
    const sessionToken = `issue36-security-session-${crypto.randomUUID()}`;
    await fixture.pgDatabase.query(
      `insert into public.session (
         id, token, "userId", "expiresAt", "createdAt", "updatedAt"
       ) values ($1, $2, $3, $4, $5, $5)`,
      [
        crypto.randomUUID(),
        sessionToken,
        userId,
        new Date(now.getTime() + 3_600_000),
        now,
      ],
    );
    resources.sessionTokens.push(sessionToken);
    const cookie = await signSessionCookie(
      sessionToken,
      fixture.config.auth!.secret,
    );

    const read = async (
      organizationId: string,
      path: string,
      withCookie = true,
    ) => {
      const headers = new Headers({ "Bakery-Organization-Id": organizationId });
      if (withCookie) headers.set("cookie", cookie);
      return await fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, { headers }),
      );
    };
    const mutate = async (
      organizationId: string,
      method: string,
      path: string,
      body?: unknown,
      idempotencyKey?: string,
    ) => {
      const headers = new Headers({
        "Bakery-Organization-Id": organizationId,
        cookie,
        origin: authTestOrigin,
      });
      if (body !== undefined) {
        headers.set("content-type", "application/json");
      }
      if (idempotencyKey !== undefined) {
        headers.set("Idempotency-Key", idempotencyKey);
      }
      return await fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    };
    const ownRunA = await read(
      scopeA.organizationId,
      `/v1/runs/${scopeA.runId}`,
    );
    const ownStepsA = await read(
      scopeA.organizationId,
      `/v1/runs/${scopeA.runId}/steps`,
    );
    const ownRunB = await read(
      scopeB.organizationId,
      `/v1/runs/${scopeB.runId}`,
    );
    const ownStepsB = await read(
      scopeB.organizationId,
      `/v1/runs/${scopeB.runId}/steps`,
    );
    assertEquals(ownRunA.status, 200);
    assertEquals(ownStepsA.status, 200);
    assertEquals(ownRunB.status, 200);
    assertEquals(ownStepsB.status, 200);
    assertEquals((await ownRunA.json() as { id: string }).id, scopeA.runId);
    assertEquals(
      (await ownStepsA.json() as { items: unknown[] }).items.length,
      scopeA.stepIds.length,
    );
    assertEquals((await ownRunB.json() as { id: string }).id, scopeB.runId);
    assertEquals(
      (await ownStepsB.json() as { items: unknown[] }).items.length,
      scopeB.stepIds.length,
    );

    for (
      const [organizationId, runId] of [
        [scopeB.organizationId, scopeA.runId],
        [scopeA.organizationId, scopeB.runId],
      ]
    ) {
      for (const suffixPath of ["", "/steps"]) {
        const hostile = await read(
          organizationId,
          `/v1/runs/${runId}${suffixPath}`,
        );
        const body = await hostile.text();
        assertEquals(hostile.status, 404);
        assertEquals(body.includes(runId), false);
        assertEquals(body.includes("RESOURCE_NOT_FOUND"), true);
      }
    }
    for (
      const path of [
        `/v1/runs/${scopeA.runId}`,
        `/v1/runs/${scopeA.runId}/steps`,
      ]
    ) {
      const anonymous = await read(scopeA.organizationId, path, false);
      const body = await anonymous.text();
      assertEquals(anonymous.status, 401);
      assertEquals(body.includes(scopeA.runId), false);
    }
    const firstDependency = await mutate(
      organizationA,
      "POST",
      `/v1/tasks/${dependencyScopeA.taskIds[0]}/dependencies`,
      {
        dependsOnTaskId: dependencyScopeA.taskIds[1],
        condition: "completed",
      },
      "issue36-security-dependency-a",
    );
    assertEquals(firstDependency.status, 201);
    const firstDependencyBody = await firstDependency.json() as { id: string };
    const crossOrganizationCreate = await mutate(
      organizationA,
      "POST",
      `/v1/tasks/${dependencyScopeA.taskIds[0]}/dependencies`,
      {
        dependsOnTaskId: dependencyScopeB.taskIds[0],
        condition: "completed",
      },
      "issue36-security-cross-create",
    );
    assertEquals(crossOrganizationCreate.status, 404);
    assertEquals(
      (await crossOrganizationCreate.json() as { code: string }).code,
      "RESOURCE_NOT_FOUND",
    );
    const crossOrganizationDelete = await mutate(
      organizationB,
      "DELETE",
      `/v1/tasks/${
        dependencyScopeA.taskIds[0]
      }/dependencies/${firstDependencyBody.id}`,
    );
    assertEquals(crossOrganizationDelete.status, 404);
    const retainedAfterCrossTenantAttempts = await fixture.pgDatabase.query(
      `select count(*)::int as count from bakery.task_dependencies
        where organization_id = $1 and id = $2`,
      [organizationA, firstDependencyBody.id],
    );
    assertEquals(retainedAfterCrossTenantAttempts.rows[0].count, 1);
    const secondDependency = await mutate(
      organizationA,
      "POST",
      `/v1/tasks/${dependencyScopeA.taskIds[1]}/dependencies`,
      {
        dependsOnTaskId: dependencyScopeA.taskIds[2],
        condition: "completed",
      },
      "issue36-security-dependency-b",
    );
    assertEquals(secondDependency.status, 201);
    const secondDependencyBody = await secondDependency.json() as {
      id: string;
    };
    const transitiveCycle = await mutate(
      organizationA,
      "POST",
      `/v1/tasks/${dependencyScopeA.taskIds[2]}/dependencies`,
      {
        dependsOnTaskId: dependencyScopeA.taskIds[0],
        condition: "completed",
      },
      "issue36-security-dependency-cycle",
    );
    assertEquals(transitiveCycle.status, 422);
    assertEquals(
      (await transitiveCycle.json() as { code: string }).code,
      "UNPROCESSABLE",
    );
    const retainedCycleEdges = await fixture.pgDatabase.query(
      `select count(*)::int as count from bakery.task_dependencies
        where organization_id = $1 and id = any($2::uuid[])`,
      [organizationA, [firstDependencyBody.id, secondDependencyBody.id]],
    );
    assertEquals(retainedCycleEdges.rows[0].count, 2);
    assertEquals(
      (await mutate(
        organizationA,
        "DELETE",
        `/v1/tasks/${
          dependencyScopeA.taskIds[0]
        }/dependencies/${firstDependencyBody.id}`,
      )).status,
      204,
    );
    assertEquals(
      (await mutate(
        organizationA,
        "DELETE",
        `/v1/tasks/${
          dependencyScopeA.taskIds[1]
        }/dependencies/${secondDependencyBody.id}`,
      )).status,
      204,
    );
  } finally {
    try {
      await cleanupSecurityFixture(fixture.pgDatabase, resources);
    } finally {
      await fixture.close();
    }
  }
});

Deno.test(
  "application role preserves immutable published workflow versions",
  async () => {
    const adminPool = openPgDatabase(adminDatabaseUrl, 1);
    const admin = await adminPool.connect();
    const suffix = crypto.randomUUID();
    const email = `issue36-workflow-grants-${suffix}@example.test`;
    const userId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    let transactionOpen = false;
    try {
      await admin.query("begin");
      transactionOpen = true;
      await admin.query(
        `insert into public."user" (
           id, name, email, "emailVerified", "createdAt", "updatedAt"
         ) values ($1, $2, $3, true, $4, $4)`,
        [userId, "Issue 36 Workflow Grants", email, now],
      );
      await admin.query(
        `insert into bakery.principals (
           id, provider_user_id, display_name, principal_type
         ) values ($1, $2, $3, 'human')`,
        [principalId, userId, "Issue 36 Workflow Grants"],
      );
      await admin.query(
        `insert into bakery.organizations (
           id, name, slug, metadata, created_at, updated_at, version
         ) values ($1, $2, $3, '{}'::jsonb, $4, $4, 1)`,
        [
          organizationId,
          "Issue 36 Workflow Grants",
          `issue36-workflow-grants-${suffix}`,
          now,
        ],
      );
      await admin.query(
        `insert into bakery.organization_memberships (
           id, organization_id, principal_id, role, status,
           joined_at, created_at, updated_at, version
         ) values ($1, $2, $3, 'developer', 'active', $4, $4, $4, 1)`,
        [crypto.randomUUID(), organizationId, principalId, now],
      );
      const scope = await seedRun(
        admin,
        principalId,
        organizationId,
        "workflow-grants",
      );
      const expectPermissionDenied = async (
        sql: string,
        values: unknown[] = [],
      ): Promise<void> => {
        await admin.query("savepoint privilege_check");
        try {
          const error = await assertRejects(
            () => admin.query(sql, values),
            Error,
          );
          assertEquals((error as { code?: string }).code, "42501");
        } finally {
          await admin.query("rollback to savepoint privilege_check");
          await admin.query("release savepoint privilege_check");
        }
      };

      await admin.query("set local role bakery_app");
      const lifecycleColumnGrants = await admin.query(
        `select
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'organization_id', 'UPDATE'
           ) as run_organization_id,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'status', 'UPDATE'
           ) as run_status,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'inngest_run_id', 'UPDATE'
           ) as run_inngest_run_id,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'started_at', 'UPDATE'
           ) as run_started_at,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'finished_at', 'UPDATE'
           ) as run_finished_at,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'updated_at', 'UPDATE'
           ) as run_updated_at,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'version', 'UPDATE'
           ) as run_version,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'id', 'UPDATE'
           ) as run_id,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'task_id', 'UPDATE'
           ) as run_task_id,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'workflow_version_id', 'UPDATE'
           ) as run_workflow_version_id,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'repository_profile_id', 'UPDATE'
           ) as run_repository_profile_id,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'requested_by', 'UPDATE'
           ) as run_requested_by,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'snapshot', 'UPDATE'
           ) as run_snapshot,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'budget_limit_usd', 'UPDATE'
           ) as run_budget_limit_usd,
           has_column_privilege(
             'bakery_app', 'bakery.workflow_runs', 'created_at', 'UPDATE'
           ) as run_created_at,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'organization_id', 'UPDATE'
           ) as step_organization_id,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'status', 'UPDATE'
           ) as step_status,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'output', 'UPDATE'
           ) as step_output,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'error', 'UPDATE'
           ) as step_error,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'started_at', 'UPDATE'
           ) as step_started_at,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'finished_at', 'UPDATE'
           ) as step_finished_at,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'updated_at', 'UPDATE'
           ) as step_updated_at,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'version', 'UPDATE'
           ) as step_version,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'id', 'UPDATE'
           ) as step_id,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'run_id', 'UPDATE'
           ) as step_run_id,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'step_key', 'UPDATE'
           ) as step_key,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'position', 'UPDATE'
           ) as step_position,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'iteration', 'UPDATE'
           ) as step_iteration,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'input', 'UPDATE'
           ) as step_input,
           has_column_privilege(
             'bakery_app', 'bakery.run_steps', 'created_at', 'UPDATE'
           ) as step_created_at`,
      );
      assertEquals(lifecycleColumnGrants.rows[0], {
        run_organization_id: false,
        run_status: true,
        run_inngest_run_id: true,
        run_started_at: true,
        run_finished_at: true,
        run_updated_at: true,
        run_version: true,
        run_id: false,
        run_task_id: false,
        run_workflow_version_id: false,
        run_repository_profile_id: false,
        run_requested_by: false,
        run_snapshot: false,
        run_budget_limit_usd: false,
        run_created_at: false,
        step_organization_id: false,
        step_status: true,
        step_output: true,
        step_error: true,
        step_started_at: true,
        step_finished_at: true,
        step_updated_at: true,
        step_version: true,
        step_id: false,
        step_run_id: false,
        step_key: false,
        step_position: false,
        step_iteration: false,
        step_input: false,
        step_created_at: false,
      });
      const readable = await admin.query(
        `select id, status
           from bakery.workflow_versions
          where organization_id = $1 and id = $2`,
        [scope.organizationId, scope.workflowVersionId],
      );
      assertEquals(readable.rows, [{
        id: scope.workflowVersionId,
        status: "published",
      }]);

      const insertedWorkflowVersionId = crypto.randomUUID();
      await admin.query(
        `insert into bakery.workflow_versions (
           id, organization_id, workflow_id, revision, source_yaml,
           normalized_spec, digest, status, created_by, created_at, updated_at,
           version
         ) values ($1, $2, $3, 2, '', $4::jsonb, $5, 'published', $6, $7, $7, 1)`,
        [
          insertedWorkflowVersionId,
          scope.organizationId,
          scope.workflowId,
          JSON.stringify({
            apiVersion: "bakery.dev/v1",
            kind: "workflow",
            steps: [],
          }),
          "1".repeat(64),
          principalId,
          now,
        ],
      );
      await expectPermissionDenied(
        `update bakery.workflow_versions
            set status = 'draft'
          where organization_id = $1 and id = $2`,
        [scope.organizationId, scope.workflowVersionId],
      );
      await expectPermissionDenied(
        `delete from bakery.workflow_versions
          where organization_id = $1 and id = $2`,
        [scope.organizationId, scope.workflowVersionId],
      );

      const runtimeRunId = crypto.randomUUID();
      const runtimeStepId = crypto.randomUUID();
      await admin.query(
        `insert into bakery.workflow_runs (
           id, organization_id, task_id, workflow_version_id,
           repository_profile_id, requested_by, inngest_run_id, status,
           snapshot, budget_limit_usd, created_at, updated_at, version
         ) values ($1, $2, $3, $4, null, $5, null, 'completed',
           '{}'::jsonb, 0, $6, $6, 1)`,
        [
          runtimeRunId,
          scope.organizationId,
          scope.taskId,
          scope.workflowVersionId,
          principalId,
          now,
        ],
      );
      await admin.query(
        `insert into bakery.run_steps (
           id, organization_id, run_id, step_key, position, iteration,
           status, input, output, error, created_at, updated_at, version
         ) values ($1, $2, $3, 'runtime_check', 2, 0, 'pending',
           '{}'::jsonb, null, null, $4, $4, 1)`,
        [runtimeStepId, scope.organizationId, runtimeRunId, now],
      );
      const runtimeRows = await admin.query(
        `select
           (select count(*)::int from bakery.workflow_runs
             where organization_id = $1 and id = $2) as run_count,
           (select count(*)::int from bakery.run_steps
             where organization_id = $1 and id = $3) as step_count`,
        [scope.organizationId, runtimeRunId, runtimeStepId],
      );
      assertEquals(runtimeRows.rows[0], { run_count: 1, step_count: 1 });
      await admin.query(
        `update bakery.workflow_runs
            set updated_at = updated_at
          where organization_id = $1 and id = $2`,
        [scope.organizationId, runtimeRunId],
      );
      await admin.query(
        `update bakery.run_steps
            set updated_at = updated_at
          where organization_id = $1 and id = $2`,
        [scope.organizationId, runtimeStepId],
      );
      await expectPermissionDenied(
        `delete from bakery.workflow_runs
          where organization_id = $1 and id = $2`,
        [scope.organizationId, runtimeRunId],
      );
      await expectPermissionDenied(
        `delete from bakery.run_steps
          where organization_id = $1 and id = $2`,
        [scope.organizationId, runtimeStepId],
      );

      await admin.query("reset role");
      const ownerRows = await admin.query(
        `select
           (select count(*)::int from bakery.workflow_versions
             where organization_id = $1
               and id = any($2::uuid[])) as version_count,
           (select count(*)::int from bakery.workflow_runs
             where organization_id = $1 and id = $3) as run_count,
           (select count(*)::int from bakery.run_steps
             where organization_id = $1 and id = $4) as step_count`,
        [
          scope.organizationId,
          [scope.workflowVersionId, insertedWorkflowVersionId],
          runtimeRunId,
          runtimeStepId,
        ],
      );
      assertEquals(ownerRows.rows[0], {
        version_count: 2,
        run_count: 1,
        step_count: 1,
      });
    } finally {
      try {
        if (transactionOpen) await admin.query("rollback");
      } finally {
        admin.release();
        await closePgDatabase(adminPool);
      }
    }
  },
);
