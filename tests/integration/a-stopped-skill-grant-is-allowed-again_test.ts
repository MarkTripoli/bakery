import { assert, assertEquals } from "@std/assert";
import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  closePgDatabase,
  openDatabase,
  openPgDatabase,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import {
  bakeryPlatformMigrationSource,
  loadMigrations,
  migrate,
  migrateProvider,
} from "../../apps/server/src/platform/migrate.ts";
import {
  authBakeryMigrationSource,
  betterAuthMigrationSource,
  preserveProviderInvitationState,
} from "../../apps/server/src/modules/auth/migrations.ts";
import { workBakeryMigrationSource } from "../../apps/server/src/modules/work/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { artifactKindsBakeryMigrationSource } from "../../apps/server/src/modules/artifact-kinds/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { mcpBakeryMigrationSource } from "../../apps/server/src/modules/mcp/migrations.ts";
import { knowledgeBakeryMigrationSource } from "../../apps/server/src/modules/knowledge/migrations.ts";
import { catalogBakeryMigrationSource } from "../../apps/server/src/modules/catalog/migrations.ts";
import { migrateData } from "../../apps/server/src/platform/data-migrate.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { createRunCommand } from "../../apps/server/src/modules/work/run-command.ts";
import {
  createSkillUseGrant,
  deleteSkillUseGrant,
} from "../../apps/server/src/modules/catalog/skill-use-grants.ts";
import { internalContext } from "../../apps/server/src/modules/workflows/automations/start.ts";
import { resolveOrganizationActor } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import type {
  OrganizationId,
  PrincipalId,
} from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

const { databaseUrl } = readTestDatabaseConfig();
const now = new Date("2026-11-23T00:00:00.000Z");

async function digest(value: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(value));
}

type Seeded = {
  organizationId: string;
  principalId: string;
  otherPrincipalId: string;
  skillId: string;
  versionId: string;
  workflowId: string;
  otherWorkflowId: string;
  workflowVersionId: string;
  taskId: string;
};

const STEP = "/steps/0/steps/0";

async function seed(
  sql: ReturnType<typeof openDatabase>,
  label: string,
): Promise<Seeded> {
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const otherPrincipalId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const skillId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const otherWorkflowId = crypto.randomUUID();
  const workflowVersionId = crypto.randomUUID();
  const otherWorkflowVersionId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const versionDigest = `sha256:${"d".repeat(64)}`;
  await sql`
    insert into bakery.organizations (
      id, name, slug, metadata, created_at, updated_at, version
    ) values (
      ${organizationId}, ${label}, ${`allow-${organizationId}`},
      '{}'::jsonb, ${now}, ${now}, 1
    )`;
  for (
    const [id, role] of [
      [principalId, "developer"],
      [otherPrincipalId, "admin"],
    ] as const
  ) {
    const userId = crypto.randomUUID();
    await sql`
      insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values (
        ${userId}, 'Person', ${`allow-${userId}@example.test`}, true,
        ${now}, ${now}
      )`;
    await sql`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (${id}, ${userId}, 'Person', 'human')`;
    await sql`
      insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at, version
      ) values (
        ${crypto.randomUUID()}, ${organizationId}, ${id}, ${role},
        'active', ${now}, ${now}, ${now}, 1
      )`;
  }
  await sql`
    insert into bakery.applications (
      id, organization_id, slug, name, description
    ) values (
      ${applicationId}, ${organizationId}, ${`allow-${applicationId}`},
      'Allow App', ''
    )`;
  await sql`
    insert into bakery.skills (
      id, organization_id, slug, name, scope, owner_principal_id
    ) values (
      ${skillId}, ${organizationId}, 'my-notes', 'My notes', 'personal',
      ${principalId}
    )`;
  await sql`
    insert into bakery.skill_versions (
      id, organization_id, skill_id, revision, source_revision, digest,
      entry_path, manifest, status, created_by
    ) values (
      ${versionId}, ${organizationId}, ${skillId}, 1, 'rev-1',
      ${versionDigest}, 'SKILL.md', '{}'::jsonb, 'published', ${principalId}
    )`;
  for (
    const [wfId, wfVersionId, slug] of [
      [workflowId, workflowVersionId, "allow-again"],
      [otherWorkflowId, otherWorkflowVersionId, "allow-other"],
    ] as const
  ) {
    const definition = {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: slug,
      inputs: { taskId: { type: "uuid", required: true } },
      steps: [{
        id: "flow",
        steps: [{
          id: "write",
          uses: "workflow.noop",
          with: {},
          skills: [versionId],
        }],
      }],
    };
    await sql`
      insert into bakery.workflow_definitions (
        id, organization_id, slug, name, enabled, version
      ) values (${wfId}, ${organizationId}, ${slug}, ${slug}, true, 1)`;
    await sql`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by, version
      ) values (
        ${wfVersionId}, ${organizationId}, ${wfId}, 1, '',
        ${sql.json(definition)}, ${await digest(definition)}, 'published',
        ${principalId}, 1
      )`;
    await sql`
      update bakery.workflow_definitions
         set active_version_id = ${wfVersionId}, updated_at = ${now}
       where organization_id = ${organizationId} and id = ${wfId}`;
  }
  await sql`
    insert into bakery.conversations (
      id, organization_id, application_id, repository_id, title,
      created_by, created_at, updated_at, version
    ) values (
      ${conversationId}, ${organizationId}, ${applicationId}, null,
      'Allow task', ${principalId}, ${now}, ${now}, 1
    )`;
  await sql`
    insert into bakery.tasks (
      id, organization_id, application_id, repository_id, conversation_id,
      title, description, task_type, status, priority, created_by,
      created_at, updated_at, version
    ) values (
      ${taskId}, ${organizationId}, ${applicationId}, null,
      ${conversationId}, 'Allow task', '', 'feature', 'draft', 50,
      ${principalId}, ${now}, ${now}, 1
    )`;
  return {
    organizationId,
    principalId,
    otherPrincipalId,
    skillId,
    versionId,
    workflowId,
    otherWorkflowId,
    workflowVersionId,
    taskId,
  };
}

async function refusal(promise: Promise<unknown>): Promise<StandardError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  assert(error instanceof StandardError, `expected a refusal, got ${error}`);
  return error;
}

Deno.test("a stopped skill grant is allowed again and runs start", async () => {
  const owner = openPgDatabase(databaseUrl);
  const authDb = openPgDatabase(databaseUrl);
  const sql = openDatabase(databaseUrl);
  try {
    await migrateProvider(
      authDb,
      await loadMigrations(betterAuthMigrationSource),
      { beforeApply: preserveProviderInvitationState },
    );
    await migrate(sql, [
      ...await loadMigrations(bakeryPlatformMigrationSource),
      ...await loadMigrations(authBakeryMigrationSource),
      ...await loadMigrations(workBakeryMigrationSource),
      ...await loadMigrations(projectsBakeryMigrationSource),
      ...await loadMigrations(agentsBakeryMigrationSource),
      ...await loadMigrations(repositoryRulesBakeryMigrationSource),
      ...await loadMigrations(artifactKindsBakeryMigrationSource),
      ...await loadMigrations(integrationsBakeryMigrationSource),
      ...await loadMigrations(deliveryBakeryMigrationSource),
      ...await loadMigrations(mcpBakeryMigrationSource),
      ...await loadMigrations(knowledgeBakeryMigrationSource),
      ...await loadMigrations(catalogBakeryMigrationSource),
    ]);
    await migrateData(sql, bakeryDataMigrations);

    const a = await seed(sql, "Allow Org A");
    const b = await seed(sql, "Allow Org B");

    const act = async <T>(
      org: Seeded,
      principalId: string,
      params: Record<string, string>,
      metadata: Record<string, unknown> | undefined,
      run: (context: ReturnType<typeof internalContext>) => Promise<T>,
    ): Promise<T> =>
      await withPgTransaction(owner, async (transaction) => {
        const actor = await resolveOrganizationActor(
          transaction,
          principalId as PrincipalId,
          org.organizationId as OrganizationId,
        );
        const context = internalContext(
          transaction,
          actor,
          { requestId: crypto.randomUUID(), traceId: crypto.randomUUID() },
          params,
        );
        return await run(
          metadata === undefined
            ? context
            : { ...context, commandMetadata: metadata } as typeof context,
        );
      });
    const allow = (org: Seeded, workflowId: string, by = org.principalId) =>
      act(
        org,
        by,
        { id: org.skillId },
        undefined,
        (context) =>
          createSkillUseGrant(context, {
            workflowId,
            skillVersionId: org.versionId,
            stepPath: STEP,
          }),
      );
    const stop = (org: Seeded, grantId: string, version: number) =>
      act(
        org,
        org.principalId,
        { id: org.skillId, grantId },
        { expectedVersion: version },
        (context) => deleteSkillUseGrant(context),
      );
    const startRun = (org: Seeded, key: string) =>
      act(org, org.principalId, { id: org.taskId }, {
        operation: "runs.create",
        idempotencyKey: key,
        target: `/v1/tasks/${org.taskId}/runs`,
      }, (context) =>
        createRunCommand(context, {
          workflowVersionId: org.workflowVersionId,
          executionMode: "cloud_only",
          budgetLimitUsd: "0.005000",
          inputs: { taskId: org.taskId },
        }));
    const runs = async (org: Seeded) =>
      (await owner.query<{ id: string; status: string }>(
        `select id, status from bakery.workflow_runs
          where organization_id = $1 order by created_at`,
        [org.organizationId],
      )).rows;
    const draftTask = async (org: Seeded) => {
      await sql`
        update bakery.tasks
           set status = 'draft', current_run_id = null, updated_at = ${now},
               version = version + 1
         where organization_id = ${org.organizationId} and id = ${org.taskId}`;
    };

    const first = await allow(a, a.workflowId);
    assertEquals(first.stepPath, STEP);
    assertEquals(first.skillVersionId, a.versionId);
    assertEquals(first.revision, 1);
    const admitted = await startRun(a, "allow-first") as { id: string };
    assertEquals((await runs(a)).length, 1);
    await draftTask(a);

    assertEquals((await allow(a, a.workflowId)).id, first.id);

    await allow(a, a.otherWorkflowId);
    await allow(b, b.workflowId);

    const before = await runs(a);
    await stop(a, first.id, first.version);
    const stopped = await refusal(startRun(a, "allow-stopped"));
    assertEquals(stopped.code, "STATE_CONFLICT");
    assertEquals(stopped.params?.reason, "step_skill_stopped");
    assertEquals(stopped.params?.step, STEP);
    assertEquals(await runs(a), before, "a refused run changed the runs");
    assertEquals(before[0].id, admitted.id);

    await startRun(b, "allow-b");
    assertEquals((await runs(b)).length, 1);

    assertEquals(
      (await refusal(allow(a, a.workflowId, a.otherPrincipalId))).code,
      "RESOURCE_NOT_FOUND",
    );
    assertEquals(
      (await refusal(
        act(
          b,
          b.principalId,
          { id: a.skillId },
          undefined,
          (context) =>
            createSkillUseGrant(context, {
              workflowId: b.workflowId,
              skillVersionId: a.versionId,
              stepPath: STEP,
            }),
        ),
      )).code,
      "RESOURCE_NOT_FOUND",
    );
    const wrongStep = await refusal(
      act(
        a,
        a.principalId,
        { id: a.skillId },
        undefined,
        (context) =>
          createSkillUseGrant(context, {
            workflowId: a.workflowId,
            skillVersionId: a.versionId,
            stepPath: "/steps/0",
          }),
      ),
    );
    assertEquals(wrongStep.code, "UNPROCESSABLE");
    assertEquals(await runs(a), before);

    const byAgent = await refusal(
      act(
        a,
        a.principalId,
        { id: a.skillId },
        undefined,
        (context) =>
          createSkillUseGrant(
            {
              ...context,
              agentSession: { attemptId: crypto.randomUUID() },
            } as typeof context,
            {
              workflowId: a.workflowId,
              skillVersionId: a.versionId,
              stepPath: STEP,
            },
          ),
      ),
    );
    assertEquals(byAgent.code, "AUTH_FORBIDDEN");
    assertEquals(byAgent.params?.reason, "personal_skill_use_requires_person");

    const again = await allow(a, a.workflowId);
    assert(again.id !== first.id, "allow again reused the stopped grant");
    await startRun(a, "allow-again");
    assertEquals((await runs(a)).length, 2);
    const audit = await owner.query<{ operation: string }>(
      `select operation from bakery.audit_events
        where organization_id = $1 and resource_id = $2`,
      [a.organizationId, again.id],
    );
    assertEquals(audit.rows.map((row) => row.operation), [
      "skills.useGrants.create",
    ]);
  } finally {
    await closeDatabase(sql);
    await closePgDatabase(authDb);
  }
});
