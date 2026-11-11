import { assertEquals } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { TaskImplementedAction } from "../../packages/contracts/src/implemented-actions.ts";
import { createWorkTaskHandlers } from "../../apps/server/src/modules/work/index.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import type { Database } from "../../apps/server/src/platform/database.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";
import { openOutboxTestFixture } from "../helpers/outbox-fixture.ts";

const cursorSecret = "run-workspace-base-sha-test-secret";
const now = new Date("2026-10-21T00:00:00.000Z");
const baseA = "a".repeat(40);
const baseB = "b".repeat(40);

type StepSeed = {
  readonly key: string;
  readonly position: number;
  readonly iteration?: number;
  readonly action: string;
  readonly status: "completed" | "running" | "failed";
  readonly output: Record<string, unknown> | null;
};

type RunView = {
  readonly id: string;
  readonly baseSha: string | null;
  readonly workspaceBaseSha: string | null;
};

function contextFor(
  organizationId: string,
  principalId: string,
  params: Record<string, string>,
  path: string,
): ActionContext {
  return {
    request: new Request(`http://test${path}`, {
      headers: { "Bakery-Organization-Id": organizationId },
    }),
    params,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    signal: new AbortController().signal,
    principal: {
      principalId,
      principalType: "service",
      displayName: "Workspace base regression",
    },
  };
}

Deno.test("a run projects the base its first completed harness step started from", async () => {
  const fixture = await openOutboxTestFixture();
  const owner: Database = fixture.owner;
  const organizationId = fixture.organizationId;
  const principalId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const workflowVersionId = crypto.randomUUID();
  const insertRun = async (steps: readonly StepSeed[], runTaskId = taskId) => {
    const runId = crypto.randomUUID();
    await owner`
      insert into bakery.workflow_runs (
        id, organization_id, task_id, workflow_version_id, requested_by,
        status, snapshot, budget_limit_usd, created_at, updated_at, version
      ) values (
        ${runId}, ${organizationId}, ${runTaskId}, ${workflowVersionId},
        ${principalId}, 'running', ${owner.json({ name: "workspace-base" })}, 0,
        ${now}, ${now}, 1
      )`;
    for (const step of steps) {
      const stepId = crypto.randomUUID();
      await owner`
        insert into bakery.run_steps (
          id, organization_id, run_id, step_key, position, iteration, status,
          input, output, finished_at, created_at, updated_at, version
        ) values (
          ${stepId}, ${organizationId}, ${runId}, ${step.key}, ${step.position},
          ${step.iteration ?? 0}, ${step.status}, ${owner.json({})},
          ${step.output === null ? null : owner.json(step.output as never)},
          ${step.status === "running" ? null : now}, ${now}, ${now}, 1
        )`;
      await owner`
        insert into bakery.jobs (
          id, organization_id, run_step_id, action, input, requirements,
          status, current_fence
        ) values (
          ${crypto.randomUUID()}, ${organizationId}, ${stepId}, ${step.action},
          ${owner.json({})}, ${owner.json({})},
          ${step.status === "completed" ? "completed" : step.status}, 1
        )`;
    }
    return runId;
  };
  try {
    await owner`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (${principalId}, null, 'Workspace base regression', 'service')`;
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
      values (${applicationId}, ${organizationId}, 'workspace-base',
        'Workspace base regression', '')`;
    await owner`
      insert into bakery.conversations (
        id, organization_id, application_id, title, created_by
      ) values (${conversationId}, ${organizationId}, ${applicationId},
        'Workspace base regression', ${principalId})`;
    await owner`
      insert into bakery.tasks (
        id, organization_id, application_id, conversation_id, title,
        description, task_type, status, created_by
      ) values (${taskId}, ${organizationId}, ${applicationId},
        ${conversationId}, 'Workspace base regression', '', 'feature',
        'draft', ${principalId})`;
    await owner`
      insert into bakery.workflow_definitions (id, organization_id, slug, name)
      values (${workflowId}, ${organizationId}, 'workspace-base',
        'Workspace base regression')`;
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by
      ) values (
        ${workflowVersionId}, ${organizationId}, ${workflowId}, 1,
        'name: workspace-base', ${owner.json({ name: "workspace-base" })},
        'workspace-base-test-digest', 'published', ${principalId}
      )`;
    await owner`
      update bakery.workflow_definitions
         set active_version_id = ${workflowVersionId}
       where organization_id = ${organizationId} and id = ${workflowId}`;

    const cases = {
      harness: await insertRun([{
        key: "implement",
        position: 1,
        action: "harness.implement",
        status: "completed",
        output: { baseSha: baseA },
      }]),
      repairAfterImplement: await insertRun([
        {
          key: "implement",
          position: 1,
          action: "harness.implement",
          status: "completed",
          output: { baseSha: baseA },
        },
        {
          key: "repair",
          position: 3,
          action: "harness.repair",
          status: "completed",
          output: { baseSha: baseB },
        },
      ]),
      checkOnly: await insertRun([{
        key: "check",
        position: 2,
        action: "quality.check",
        status: "completed",
        output: { baseSha: baseA },
      }]),
      running: await insertRun([{
        key: "implement",
        position: 1,
        action: "harness.implement",
        status: "running",
        output: { baseSha: baseA },
      }]),
      failed: await insertRun([{
        key: "implement",
        position: 1,
        action: "harness.implement",
        status: "failed",
        output: { baseSha: baseA },
      }]),
      notAGitSha: await insertRun([
        {
          key: "implement",
          position: 1,
          action: "harness.implement",
          status: "completed",
          output: { baseSha: "base-before-promotion" },
        },
        {
          key: "repair",
          position: 3,
          action: "harness.repair",
          status: "completed",
          output: { baseSha: baseB },
        },
      ]),
      noSteps: await insertRun([]),
      bystander: await insertRun([]),
    };
    // Another run in the same organization completes a harness step; it must
    // not reach the runs above.
    const neighbour = await insertRun([{
      key: "implement",
      position: 1,
      action: "harness.implement",
      status: "completed",
      output: { baseSha: baseB },
    }]);

    const registry = createTaskActionRegistry(
      createWorkTaskHandlers(cursorSecret),
      { authorityRunner: new PostgresAuthorityRunner(fixture.appPg) },
    );
    const expected: Record<keyof typeof cases, string | null> = {
      harness: baseA,
      repairAfterImplement: baseA,
      checkOnly: null,
      running: null,
      failed: null,
      notAGitSha: null,
      noSteps: null,
      bystander: null,
    };
    for (const [name, runId] of Object.entries(cases)) {
      const run = await registry.execute(
        TaskImplementedAction.RunsGet,
        contextFor(
          organizationId,
          principalId,
          { id: runId },
          `/v1/runs/${runId}`,
        ),
        { id: runId },
      ) as RunView;
      assertEquals(run.id, runId, name);
      assertEquals(
        run.workspaceBaseSha,
        expected[name as keyof typeof cases],
        `runs.get ${name}`,
      );
      // The admission pin is untouched: strict-v1 runs keep a null pin.
      assertEquals(run.baseSha, null, `runs.get pin ${name}`);
    }
    const neighbourRun = await registry.execute(
      TaskImplementedAction.RunsGet,
      contextFor(
        organizationId,
        principalId,
        { id: neighbour },
        `/v1/runs/${neighbour}`,
      ),
      { id: neighbour },
    ) as RunView;
    assertEquals(neighbourRun.workspaceBaseSha, baseB);

    const listed = await registry.execute(
      TaskImplementedAction.RunsList,
      contextFor(
        organizationId,
        principalId,
        { id: taskId },
        `/v1/tasks/${taskId}/runs`,
      ),
      { limit: 25 },
    ) as { items: RunView[] };
    assertEquals(listed.items.length, Object.keys(cases).length + 1);
    for (const item of listed.items) {
      const name = Object.entries(cases).find(([, id]) => id === item.id)?.[0];
      assertEquals(
        item.workspaceBaseSha,
        name === undefined ? baseB : expected[name as keyof typeof cases],
        `runs.list ${name ?? "neighbour"}`,
      );
    }
  } finally {
    await owner`
      delete from bakery.organization_memberships
       where organization_id = ${organizationId}
         and principal_id = ${principalId}`;
    await fixture.close();
  }
});
