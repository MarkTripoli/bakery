import { assertEquals } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { TaskImplementedAction } from "../../packages/contracts/src/implemented-actions.ts";
import { createWorkTaskHandlers } from "../../apps/server/src/modules/work/index.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import {
  type Database,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import { appendAudit } from "../../packages/persistence/src/event-audit.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";
import { openOutboxTestFixture } from "../helpers/outbox-fixture.ts";

const cursorSecret = "run-limit-stop-test-secret";
const now = new Date("2026-11-24T00:00:00.000Z");

type RunView = { readonly id: string; readonly limitStop?: unknown };

function contextFor(
  organizationId: string,
  principalId: string,
  runId: string,
): ActionContext {
  return {
    request: new Request(`http://test/v1/runs/${runId}`, {
      headers: { "Bakery-Organization-Id": organizationId },
    }),
    params: { id: runId },
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    signal: new AbortController().signal,
    principal: {
      principalId,
      principalType: "service",
      displayName: "Limit stop regression",
    },
  };
}

Deno.test("the run read says where a failed run stopped to ask a person", async () => {
  const fixture = await openOutboxTestFixture();
  const owner: Database = fixture.owner;
  const organizationId = fixture.organizationId;
  const principalId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const workflowVersionId = crypto.randomUUID();
  const insertRun = async (status: string) => {
    const runId = crypto.randomUUID();
    await owner`
      insert into bakery.workflow_runs (
        id, organization_id, task_id, workflow_version_id, requested_by,
        status, snapshot, budget_limit_usd, created_at, updated_at, version
      ) values (
        ${runId}, ${organizationId}, ${taskId}, ${workflowVersionId},
        ${principalId}, ${status}, ${owner.json({ schemaVersion: 1 })}, 0,
        ${now}, ${now}, 1
      )`;
    return runId;
  };
  try {
    await owner`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (${principalId}, null, 'Limit stop regression', 'service')`;
    await owner`
      insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at, version
      ) values (
        ${crypto.randomUUID()}, ${organizationId}, ${principalId},
        'developer', 'active', ${now}, ${now}, ${now}, 1
      )`;
    await owner`
      insert into bakery.applications (id, organization_id, slug, name, description)
      values (${applicationId}, ${organizationId}, 'limit-stop',
        'Limit stop regression', '')`;
    await owner`
      insert into bakery.conversations (
        id, organization_id, application_id, title, created_by
      ) values (${conversationId}, ${organizationId}, ${applicationId},
        'Limit stop regression', ${principalId})`;
    await owner`
      insert into bakery.tasks (
        id, organization_id, application_id, conversation_id, title,
        description, task_type, status, created_by
      ) values (${taskId}, ${organizationId}, ${applicationId},
        ${conversationId}, 'Limit stop regression', '', 'feature',
        'draft', ${principalId})`;
    await owner`
      insert into bakery.workflow_definitions (id, organization_id, slug, name)
      values (${workflowId}, ${organizationId}, 'limit-stop',
        'Limit stop regression')`;
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by
      ) values (
        ${workflowVersionId}, ${organizationId}, ${workflowId}, 1,
        'name: limit-stop', ${owner.json({ name: "limit-stop" })},
        'limit-stop-test-digest', 'published', ${principalId}
      )`;
    await owner`
      update bakery.workflow_definitions
         set active_version_id = ${workflowVersionId}
       where organization_id = ${organizationId} and id = ${workflowId}`;

    const stop = {
      repeatKey: "flow.fix",
      iterations: 3,
      allowed: 3,
      max: 5,
    };
    const failedWith = (runId: string, details: Record<string, unknown>) =>
      withPgTransaction(
        fixture.appPg,
        (transaction) =>
          appendAudit(transaction, {
            organizationId,
            principalId,
            operation: "workflow.plan_failed",
            resourceType: "workflow_run",
            resourceId: runId,
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
            details,
          }),
      );
    const atLimit = await insertRun("failed");
    await failedWith(atLimit, { code: "limit_reached", ...stop });
    const failedOtherwise = await insertRun("failed");
    await failedWith(failedOtherwise, { code: "limit_reached", ...stop });
    await failedWith(failedOtherwise, { code: "step_failed" });
    const reopened = await insertRun("running");
    await failedWith(reopened, { code: "limit_reached", ...stop });

    const registry = createTaskActionRegistry(
      createWorkTaskHandlers(cursorSecret),
      { authorityRunner: new PostgresAuthorityRunner(fixture.appPg) },
    );
    const limitStopOf = async (runId: string) =>
      (await registry.execute(
        TaskImplementedAction.RunsGet,
        contextFor(organizationId, principalId, runId),
        { id: runId },
      ) as RunView).limitStop;
    assertEquals(await limitStopOf(atLimit), stop);
    assertEquals(await limitStopOf(failedOtherwise), null);
    assertEquals(await limitStopOf(reopened), null);
  } finally {
    await owner`
      delete from bakery.organization_memberships
       where organization_id = ${organizationId}
         and principal_id = ${principalId}`;
    await fixture.close();
  }
});
