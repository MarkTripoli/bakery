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

/**
 * A run whose version names a personal skill its owner has stopped allowing is
 * refused at admission.
 *
 * The grant is what the owner's confirmation records, and Stop allowing deletes
 * it. Before this check nothing that admits a run read the grants table, so the
 * next run went ahead with the skill and the confirmation's own sentence was
 * false. The refusal is the step's, not a silent drop: a step compiled to use a
 * named version and given nothing would answer a different question than its
 * author asked.
 *
 * The run is started through `createRunCommand`, the one command every intake
 * uses, so this is the admission path and not a copy of it.
 */
Deno.test("a run is refused when a step's skill grant is gone", async () => {
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

    const organizationId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const applicationId = crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    const workflowVersionId = crypto.randomUUID();
    const personalSkillId = crypto.randomUUID();
    const personalVersionId = crypto.randomUUID();
    const sharedSkillId = crypto.randomUUID();
    const sharedVersionId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const versionDigest = `sha256:${"c".repeat(64)}`;

    await sql`
      insert into public."user" (
        id, name, email, "emailVerified", "createdAt", "updatedAt"
      ) values (
        ${userId}, 'Grant Owner', ${`grant-${userId}@example.test`}, true,
        ${now}, ${now}
      )`;
    await sql`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (${principalId}, ${userId}, 'Grant Owner', 'human')`;
    await sql`
      insert into bakery.organizations (
        id, name, slug, metadata, created_at, updated_at, version
      ) values (
        ${organizationId}, 'Grant Org', ${`grant-${organizationId}`},
        '{}'::jsonb, ${now}, ${now}, 1
      )`;
    await sql`
      insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at, version
      ) values (
        ${crypto.randomUUID()}, ${organizationId}, ${principalId}, 'developer',
        'active', ${now}, ${now}, ${now}, 1
      )`;
    await sql`
      insert into bakery.applications (
        id, organization_id, slug, name, description
      ) values (
        ${applicationId}, ${organizationId}, ${`grant-${applicationId}`},
        'Grant App', ''
      )`;
    await sql`
      insert into bakery.skills (
        id, organization_id, slug, name, scope, owner_principal_id
      ) values (
        ${personalSkillId}, ${organizationId}, 'my-notes', 'My notes',
        'personal', ${principalId}
      )`;
    await sql`
      insert into bakery.skills (
        id, organization_id, slug, name, scope
      ) values (
        ${sharedSkillId}, ${organizationId}, 'team-notes', 'Team notes',
        'organization'
      )`;
    for (
      const [skillId, id] of [
        [personalSkillId, personalVersionId],
        [sharedSkillId, sharedVersionId],
      ] as const
    ) {
      await sql`
        insert into bakery.skill_versions (
          id, organization_id, skill_id, revision, source_revision, digest,
          entry_path, manifest, status, created_by
        ) values (
          ${id}, ${organizationId}, ${skillId}, 1, 'rev-1', ${versionDigest},
          'SKILL.md', '{}'::jsonb, 'published', ${principalId}
        )`;
    }

    // A compiled plan: one container, one worker-free step that names both
    // skills. The personal one is the one that needs a grant.
    const definition = {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: "grant-admission",
      inputs: { taskId: { type: "uuid", required: true } },
      steps: [{
        id: "flow",
        steps: [{
          id: "write",
          uses: "workflow.noop",
          with: {},
          skills: [personalVersionId, sharedVersionId],
        }],
      }],
    };
    await sql`
      insert into bakery.workflow_definitions (
        id, organization_id, slug, name, enabled, version
      ) values (
        ${workflowId}, ${organizationId}, 'grant-admission', 'Grant admission',
        true, 1
      )`;
    await sql`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by, version
      ) values (
        ${workflowVersionId}, ${organizationId}, ${workflowId}, 1, '',
        ${sql.json(definition)}, ${await digest(definition)}, 'published',
        ${principalId}, 1
      )`;
    await sql`
      update bakery.workflow_definitions
         set active_version_id = ${workflowVersionId}, updated_at = ${now}
       where organization_id = ${organizationId} and id = ${workflowId}`;
    await sql`
      insert into bakery.conversations (
        id, organization_id, application_id, repository_id, title,
        created_by, created_at, updated_at, version
      ) values (
        ${conversationId}, ${organizationId}, ${applicationId}, null,
        'Grant task', ${principalId}, ${now}, ${now}, 1
      )`;
    await sql`
      insert into bakery.tasks (
        id, organization_id, application_id, repository_id, conversation_id,
        title, description, task_type, status, priority, created_by,
        created_at, updated_at, version
      ) values (
        ${taskId}, ${organizationId}, ${applicationId}, null,
        ${conversationId}, 'Grant task', '', 'feature', 'draft', 50,
        ${principalId}, ${now}, ${now}, 1
      )`;

    // A task starts a run while it is a draft with none; a finished run puts it
    // back to draft, which is how the same task starts a second one.
    const setTaskStatus = async (status: string) => {
      await sql`
        update bakery.tasks
           set status = ${status}, current_run_id = null, updated_at = ${now},
               version = version + 1
         where organization_id = ${organizationId} and id = ${taskId}`;
    };
    const startRun = async (key: string) =>
      await withPgTransaction(owner, async (transaction) => {
        const actor = await resolveOrganizationActor(
          transaction,
          principalId as PrincipalId,
          organizationId as OrganizationId,
        );
        return await createRunCommand(
          internalContext(
            transaction,
            actor,
            { requestId: crypto.randomUUID(), traceId: crypto.randomUUID() },
            { id: taskId },
            {
              operation: "runs.create",
              idempotencyKey: key,
              target: `/v1/tasks/${taskId}/runs`,
            },
          ),
          {
            workflowVersionId,
            executionMode: "cloud_only",
            budgetLimitUsd: "0.005000",
            inputs: { taskId },
          },
        );
      });
    const runCount = async (): Promise<number> => {
      const result = await owner.query<{ n: number }>(
        `select count(*)::int as n from bakery.workflow_runs
          where organization_id = $1`,
        [organizationId],
      );
      return result.rows[0].n;
    };

    // The owner has not confirmed the personal skill: the run is refused, and
    // the refusal names the step and the version rather than the whole workflow.
    const unconfirmed = await startRun("grant-unconfirmed").then(
      () => null,
      (error: unknown) => error,
    );
    assert(
      unconfirmed instanceof StandardError,
      `a run started with no grant: ${unconfirmed}`,
    );
    assertEquals(unconfirmed.code, "STATE_CONFLICT");
    assertEquals(unconfirmed.params?.reason, "step_skill_stopped");
    assertEquals(unconfirmed.params?.step, "/steps/0/steps/0");
    assertEquals(unconfirmed.params?.skillVersionId, personalVersionId);
    assertEquals(await runCount(), 0, "a refused run left a row behind");

    // The owner confirms: the grant exists and the same run is admitted.
    await sql`
      insert into bakery.skill_use_grants (
        id, organization_id, workflow_id, step_path, skill_id,
        skill_version_id, granted_by, revision, revision_digest
      ) values (
        ${crypto.randomUUID()}, ${organizationId}, ${workflowId},
        '/steps/0/steps/0', ${personalSkillId}, ${personalVersionId},
        ${principalId}, 1, ${versionDigest}
      )`;
    const admitted = await startRun("grant-confirmed") as { status: string };
    assertEquals(admitted.status, "queued");
    assertEquals(await runCount(), 1);
    await setTaskStatus("draft");

    // Stop allowing deletes the grant, and the next run is refused again: the
    // owner's act takes effect at the next run, which is what the confirmation
    // says. The run already admitted is untouched.
    await sql`
      delete from bakery.skill_use_grants
       where organization_id = ${organizationId} and workflow_id = ${workflowId}`;
    const stopped = await startRun("grant-stopped").then(
      () => null,
      (error: unknown) => error,
    );
    assert(
      stopped instanceof StandardError,
      `a run started after the grant was stopped: ${stopped}`,
    );
    assertEquals(stopped.code, "STATE_CONFLICT");
    assertEquals(stopped.params?.reason, "step_skill_stopped");
    assertEquals(await runCount(), 1, "a refused run left a row behind");
  } finally {
    await closeDatabase(sql);
    await closePgDatabase(authDb);
  }
});
