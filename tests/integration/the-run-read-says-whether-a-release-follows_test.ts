import { assertEquals } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { TaskImplementedAction } from "../../packages/contracts/src/implemented-actions.ts";
import { createWorkTaskHandlers } from "../../apps/server/src/modules/work/index.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import type { Database } from "../../apps/server/src/platform/database.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";
import { openOutboxTestFixture } from "../helpers/outbox-fixture.ts";

const cursorSecret = "run-release-step-test-secret";
const now = new Date("2026-11-24T00:00:00.000Z");
const inputs = { repo: { type: "uuid", required: true } };

const mergeStep = {
  id: "ship",
  uses: "delivery.merge",
  with: { repositoryId: "$input.repo", candidate: "$step.seed.candidate" },
  effectKey: ["merge", "$input.repo"],
};

const deployStep = {
  id: "release",
  uses: "delivery.deploy",
  with: { releaseId: "$step.seed.releaseId", environment: "production" },
  effectKey: ["deploy", "$input.repo"],
};

type RunView = { readonly id: string; readonly releaseStep?: string };

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
      displayName: "Release step regression",
    },
  };
}

Deno.test("the run read says whether a release step follows its merge", async () => {
  const fixture = await openOutboxTestFixture();
  const owner: Database = fixture.owner;
  const organizationId = fixture.organizationId;
  const principalId = crypto.randomUUID();
  const applicationId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const workflowVersionId = crypto.randomUUID();
  const insertRun = async (snapshot: unknown) => {
    const runId = crypto.randomUUID();
    await owner`
      insert into bakery.workflow_runs (
        id, organization_id, task_id, workflow_version_id, requested_by,
        status, snapshot, budget_limit_usd, created_at, updated_at, version
      ) values (
        ${runId}, ${organizationId}, ${taskId}, ${workflowVersionId},
        ${principalId}, 'running', ${owner.json(snapshot as never)}, 0,
        ${now}, ${now}, 1
      )`;
    return runId;
  };
  try {
    await owner`
      insert into bakery.principals (
        id, provider_user_id, display_name, principal_type
      ) values (${principalId}, null, 'Release step regression', 'service')`;
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
      values (${applicationId}, ${organizationId}, 'release-step',
        'Release step regression', '')`;
    await owner`
      insert into bakery.conversations (
        id, organization_id, application_id, title, created_by
      ) values (${conversationId}, ${organizationId}, ${applicationId},
        'Release step regression', ${principalId})`;
    await owner`
      insert into bakery.tasks (
        id, organization_id, application_id, conversation_id, title,
        description, task_type, status, created_by
      ) values (${taskId}, ${organizationId}, ${applicationId},
        ${conversationId}, 'Release step regression', '', 'feature',
        'draft', ${principalId})`;
    await owner`
      insert into bakery.workflow_definitions (id, organization_id, slug, name)
      values (${workflowId}, ${organizationId}, 'release-step',
        'Release step regression')`;
    await owner`
      insert into bakery.workflow_versions (
        id, organization_id, workflow_id, revision, source_yaml,
        normalized_spec, digest, status, created_by
      ) values (
        ${workflowVersionId}, ${organizationId}, ${workflowId}, 1,
        'name: release-step', ${owner.json({ name: "release-step" })},
        'release-step-test-digest', 'published', ${principalId}
      )`;
    await owner`
      update bakery.workflow_definitions
         set active_version_id = ${workflowVersionId}
       where organization_id = ${organizationId} and id = ${workflowId}`;

    const plan = async (steps: readonly object[]) => ({
      schemaVersion: 1,
      runtime: { document: await compiled(steps as never, inputs) },
    });
    const flat = (uses: readonly string[]) => ({
      schemaVersion: 1,
      workflow: {
        normalizedSpec: {
          steps: uses.map((use, index) => ({ id: `step_${index}`, uses: use })),
        },
      },
    });

    const cases = {
      releasesAfterMerge: await insertRun(
        await plan([noop("seed"), mergeStep, deployStep]),
      ),
      mergesAndStops: await insertRun(await plan([noop("seed"), mergeStep])),
      flatRelease: await insertRun(
        flat(["workflow.noop", "delivery.merge", "delivery.deploy"]),
      ),
      noMerge: await insertRun(await plan([noop("seed"), noop("after")])),
      unreadable: await insertRun({ schemaVersion: 1 }),
    };
    const expected: Record<keyof typeof cases, string> = {
      releasesAfterMerge: "yes",
      mergesAndStops: "no",
      flatRelease: "yes",
      noMerge: "no",
      unreadable: "unknown",
    };

    const registry = createTaskActionRegistry(
      createWorkTaskHandlers(cursorSecret),
      { authorityRunner: new PostgresAuthorityRunner(fixture.appPg) },
    );
    for (const [name, runId] of Object.entries(cases)) {
      const run = await registry.execute(
        TaskImplementedAction.RunsGet,
        contextFor(organizationId, principalId, runId),
        { id: runId },
      ) as RunView;
      assertEquals(
        run.releaseStep,
        expected[name as keyof typeof cases],
        `runs.get ${name}`,
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
