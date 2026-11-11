import { assertEquals } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { TaskImplementedAction } from "../../packages/contracts/src/implemented-actions.ts";
import { createWorkTaskHandlers } from "../../apps/server/src/modules/work/index.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import {
  type Database,
  type PgTransactionClient,
} from "../../apps/server/src/platform/database.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";
import { openOutboxTestFixture } from "../helpers/outbox-fixture.ts";

const cursorSecret = "run-query-terminal-read-test-secret";
const now = new Date("2026-09-27T00:00:00.000Z");

type RunCase = {
  runId: string;
  stepId: string;
  terminalStatus: "completed" | "canceled";
};

async function insertRunFixture(
  owner: Database,
  organizationId: string,
  principalId: string,
  runCase: RunCase,
  taskId: string,
  workflowVersionId: string,
): Promise<void> {
  await owner`
    insert into bakery.workflow_runs (
      id, organization_id, task_id, workflow_version_id, requested_by,
      status, snapshot, budget_limit_usd, created_at, updated_at, version
    ) values (
      ${runCase.runId}, ${organizationId}, ${taskId}, ${workflowVersionId},
      ${principalId}, 'queued', ${owner.json({ name: "terminal-read" })}, 0,
      ${now}, ${now}, 1
    )`;
  await owner`
    insert into bakery.run_steps (
      id, organization_id, run_id, step_key, position, iteration, status,
      input, created_at, updated_at, version
    ) values (
      ${runCase.stepId}, ${organizationId}, ${runCase.runId}, 'review', 0, 0,
      'pending', ${owner.json({})}, ${now}, ${now}, 1
    )`;
}

async function commitTerminalState(
  owner: Database,
  organizationId: string,
  runCase: RunCase,
): Promise<void> {
  await owner.begin(async (transaction) => {
    await transaction`
      update bakery.workflow_runs
         set status = ${runCase.terminalStatus},
             finished_at = ${now},
             updated_at = ${now},
             version = version + 1
       where organization_id = ${organizationId} and id = ${runCase.runId}`;
    await transaction`
      update bakery.run_steps
         set status = ${runCase.terminalStatus},
             finished_at = ${now},
             updated_at = ${now},
             version = version + 1
       where organization_id = ${organizationId} and id = ${runCase.stepId}`;
  });
}

function contextFor(
  organizationId: string,
  principalId: string,
  runId: string,
  requestId: string,
  traceId: string,
): ActionContext {
  return {
    request: new Request(`http://test/v1/runs/${runId}/steps`, {
      headers: { "Bakery-Organization-Id": organizationId },
    }),
    params: { id: runId },
    requestId,
    traceId,
    signal: new AbortController().signal,
    principal: {
      principalId,
      principalType: "service",
      displayName: "Terminal GET regression",
    },
  };
}

function withInterleave(
  transaction: PgTransactionClient,
  interleave: () => Promise<void>,
): PgTransactionClient {
  let queryCount = 0;
  return {
    async query(queryTextOrConfig: unknown, values?: unknown[]) {
      queryCount += 1;
      if (queryCount === 2) await interleave();
      return values === undefined
        ? transaction.query(queryTextOrConfig as never)
        : transaction.query(queryTextOrConfig as never, values);
    },
  } as unknown as PgTransactionClient;
}

async function terminalAuditRows(
  owner: Database,
  organizationId: string,
  requestId: string,
) {
  return await owner`
    select operation, resource_type, resource_id, outcome, request_id,
           trace_id, details
      from bakery.audit_events
     where organization_id = ${organizationId}
       and request_id = ${requestId}
     order by created_at asc, id asc`;
}

Deno.test("terminal run-step GETs keep one snapshot across completion and cancellation", async () => {
  const fixture = await openOutboxTestFixture();
  const principalId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const workflowVersionId = crypto.randomUUID();
  const runCases: RunCase[] = [
    {
      runId: crypto.randomUUID(),
      stepId: crypto.randomUUID(),
      terminalStatus: "completed",
    },
    {
      runId: crypto.randomUUID(),
      stepId: crypto.randomUUID(),
      terminalStatus: "canceled",
    },
  ];
  try {
    await fixture.owner`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (
        ${principalId}, null, 'Terminal GET regression', 'service'
      )`;
    await fixture.owner`
      insert into bakery.organization_memberships (
        id, organization_id, principal_id, role, status, joined_at,
        created_at, updated_at, version
      ) values (
        ${crypto.randomUUID()}, ${fixture.organizationId}, ${principalId},
        'developer', 'active', ${now}, ${now}, ${now}, 1
      )`;
    await fixture.owner`
      insert into bakery.applications (
        id, organization_id, slug, name, description
      ) values (
        ${applicationId}, ${fixture.organizationId}, 'terminal-read',
        'Terminal GET regression', ''
      )`;
    await fixture.owner`
      insert into bakery.conversations (
        id, organization_id, application_id, title, created_by
      ) values (
        ${conversationId}, ${fixture.organizationId}, ${applicationId},
        'Terminal GET regression', ${principalId}
      )`;
    await fixture.owner`
      insert into bakery.tasks (
        id, organization_id, application_id, conversation_id, title,
        description, task_type, status, created_by
      ) values (
        ${taskId}, ${fixture.organizationId}, ${applicationId}, ${conversationId},
        'Terminal GET regression', '', 'feature', 'draft', ${principalId}
      )`;
    await fixture.owner`
      insert into bakery.workflow_definitions (
        id, organization_id, slug, name
      ) values (
        ${workflowId}, ${fixture.organizationId}, 'terminal-read',
        'Terminal GET regression'
      )`;
    await fixture.owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by
      ) values (
        ${workflowVersionId}, ${fixture.organizationId}, ${workflowId}, 1,
        'name: terminal-read', ${fixture.owner.json({ name: "terminal-read" })},
        'terminal-read-test-digest', 'published', ${principalId}
      )`;
    await fixture.owner`
      update bakery.workflow_definitions
         set active_version_id = ${workflowVersionId}
       where organization_id = ${fixture.organizationId} and id = ${workflowId}`;
    for (const runCase of runCases) {
      await insertRunFixture(
        fixture.owner,
        fixture.organizationId,
        principalId,
        runCase,
        taskId,
        workflowVersionId,
      );
    }

    const authorityRunner = new PostgresAuthorityRunner(fixture.appPg);
    const registry = createTaskActionRegistry(
      createWorkTaskHandlers(cursorSecret),
      { authorityRunner },
    );
    const action = registry.get(TaskImplementedAction.RunStepsList);

    for (const runCase of runCases) {
      const interleavedRequestId =
        `terminal-read-interleaved-${runCase.terminalStatus}`;
      const interleavedTraceId =
        `terminal-read-trace-${runCase.terminalStatus}`;
      const interleavedContext = contextFor(
        fixture.organizationId,
        principalId,
        runCase.runId,
        interleavedRequestId,
        interleavedTraceId,
      );
      const interleaved = await authorityRunner.run(
        action,
        interleavedContext,
        { limit: 25 },
        async (authorizedContext) => {
          const transaction = withInterleave(
            (authorizedContext as ActionContext & {
              transaction: PgTransactionClient;
            }).transaction,
            () =>
              commitTerminalState(
                fixture.owner,
                fixture.organizationId,
                runCase,
              ),
          );
          return await action.handler(
            { ...authorizedContext, transaction } as ActionContext,
            { limit: 25 },
          );
        },
      ) as { items: Array<{ status: string }> };
      assertEquals(interleaved.items[0]?.status, "pending");
      assertEquals(
        (await terminalAuditRows(
          fixture.owner,
          fixture.organizationId,
          interleavedRequestId,
        )).length,
        0,
      );

      const terminalRequestId =
        `terminal-read-terminal-${runCase.terminalStatus}`;
      const terminalTraceId =
        `terminal-read-terminal-trace-${runCase.terminalStatus}`;
      const terminal = await registry.execute(
        TaskImplementedAction.RunStepsList,
        contextFor(
          fixture.organizationId,
          principalId,
          runCase.runId,
          terminalRequestId,
          terminalTraceId,
        ),
        { limit: 25 },
      ) as { items: Array<{ id: string; status: string }> };
      assertEquals(terminal.items[0]?.id, runCase.stepId);
      assertEquals(terminal.items[0]?.status, runCase.terminalStatus);

      const audits = await terminalAuditRows(
        fixture.owner,
        fixture.organizationId,
        terminalRequestId,
      );
      assertEquals(audits.length, 1);
      assertEquals(audits[0]?.operation, "runs.steps.list");
      assertEquals(audits[0]?.resource_type, "workflow_run");
      assertEquals(audits[0]?.resource_id, runCase.runId);
      assertEquals(audits[0]?.outcome, "allowed");
      assertEquals(audits[0]?.request_id, terminalRequestId);
      assertEquals(audits[0]?.trace_id, terminalTraceId);
      assertEquals(audits[0]?.details, {
        observedStepId: runCase.stepId,
        observedStepStatus: runCase.terminalStatus,
      });
    }
  } finally {
    await fixture.owner`
      delete from bakery.organization_memberships
       where organization_id = ${fixture.organizationId}
         and principal_id = ${principalId}`;
    await fixture.close();
  }
});
