import { assert, assertEquals } from "@std/assert";
import { FIXED_CODING_PRESET } from "../../packages/contracts/src/workflow-presets.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  apiCall,
  createPresetTask,
  expectJson,
  presetBudgetEnv,
  seedFundedCodingAgent,
  seedPresetRepository,
  startPresetRun,
} from "../helpers/fixed-coding-preset.ts";

type Fixture = Parameters<typeof startPresetRun>[0] & {
  pgDatabase: Parameters<typeof seedPresetRepository>[0];
  organizationId: string;
};
type RunBody = { id: string; status: string; workflowVersionId: string };
type Problem = { code: string; status: number; reason?: string };

const definition = JSON.parse(JSON.stringify(FIXED_CODING_PRESET.spec));

Deno.test("run admission by workflowId pins the active published version", () =>
  withWorkerFixture(async (fixture) => {
    const scope = fixture;
    const agent = await seedFundedCodingAgent(fixture, scope, "pin");
    const repository = await seedPresetRepository(fixture.pgDatabase, scope, {
      agentVersionId: agent,
    });
    let taskCount = 0;
    const startById = async (workflowId: string): Promise<Response> => {
      taskCount += 1;
      const task = await createPresetTask(fixture, scope, repository, {
        title: `Pinned task ${taskCount}`,
      });
      return await apiCall(
        fixture,
        scope,
        "POST",
        `/v1/tasks/${task.id}/runs`,
        {
          body: {
            workflowId,
            executionMode: "repository",
            repositoryProfileId: repository.profileId,
            budgetLimitUsd: "5.00",
            inputs: { brief: "Retry failed uploads twice." },
          },
        },
      );
    };
    const runCount = async (): Promise<number> =>
      Number(
        (await fixture.pgDatabase.query<{ count: string }>(
          `select count(*)::text as count from bakery.workflow_runs
            where organization_id = $1`,
          [scope.organizationId],
        )).rows[0].count,
      );
    const definitionVersion = async (id: string): Promise<number> =>
      (await expectJson<{ version: number }>(
        await apiCall(fixture, scope, "GET", `/v1/workflows/${id}`),
        200,
      )).version;
    // The problem body does not expose STATE_CONFLICT reasons; the setup of each
    // case names the reason, the code and the unchanged run count prove it.
    const conflictCode = async (response: Response) =>
      (await expectJson<Problem>(response, 409)).code;
    const publish = async (workflowId: string): Promise<string> => {
      const draft = await expectJson<{ id: string }>(
        await apiCall(
          fixture,
          scope,
          "POST",
          `/v1/workflows/${workflowId}/versions`,
          { body: { definition } },
        ),
        201,
      );
      const published = await expectJson<{ id: string }>(
        await apiCall(
          fixture,
          scope,
          "POST",
          `/v1/workflows/${workflowId}/versions/${draft.id}/publish`,
          { body: {}, headers: { "If-Match": '"1"' } },
        ),
        200,
      );
      return published.id;
    };
    const activate = async (workflowId: string, versionId: string) =>
      await expectJson<{ activeVersionId: string }>(
        await apiCall(
          fixture,
          scope,
          "POST",
          `/v1/workflows/${workflowId}/activations`,
          {
            body: { versionId },
            headers: {
              "If-Match": `"${await definitionVersion(workflowId)}"`,
            },
          },
        ),
        200,
      );
    const setEnabled = async (workflowId: string, enabled: boolean) =>
      await expectJson(
        await apiCall(fixture, scope, "PATCH", `/v1/workflows/${workflowId}`, {
          body: { enabled },
          headers: {
            "If-Match": `"${await definitionVersion(workflowId)}"`,
          },
        }),
        200,
      );

    const workflow = await expectJson<{ id: string }>(
      await apiCall(fixture, scope, "POST", "/v1/workflows", {
        body: {
          slug: "pinned-flow",
          name: "Pinned flow",
          description: "Synthetic workflow for run pinning.",
        },
      }),
      201,
    );

    // 6-3 no active version yet.
    const before = await runCount();
    assertEquals(
      await conflictCode(
        await startById(workflow.id),
      ),
      "STATE_CONFLICT",
    );
    assertEquals(await runCount(), before);

    // 6-1 pinning across r1 and r2.
    const r1 = await publish(workflow.id);
    await activate(workflow.id, r1);
    const runA = await expectJson<RunBody>(await startById(workflow.id), 201);
    assertEquals(runA.workflowVersionId, r1);
    const stepsOf = async (runId: string) =>
      (await fixture.pgDatabase.query<{ step_key: string }>(
        `select step_key from bakery.run_steps
          where organization_id = $1 and run_id = $2 order by step_key`,
        [scope.organizationId, runId],
      )).rows.map((row) => row.step_key);
    const stepsA = await stepsOf(runA.id);
    assert(stepsA.length > 0);

    const r2 = await publish(workflow.id);
    assert(r2 !== r1);
    await activate(workflow.id, r2);
    const pinnedA = await fixture.pgDatabase.query<{
      workflow_version_id: string;
    }>(
      `select workflow_version_id from bakery.workflow_runs
        where organization_id = $1 and id = $2`,
      [scope.organizationId, runA.id],
    );
    assertEquals(pinnedA.rows[0].workflow_version_id, r1);
    assertEquals(await stepsOf(runA.id), stepsA);
    const runB = await expectJson<RunBody>(await startById(workflow.id), 201);
    assertEquals(runB.workflowVersionId, r2);

    // 6-2 disable blocks new starts, leaves running runs, re-enable restores.
    await setEnabled(workflow.id, false);
    const statusA = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.workflow_runs
        where organization_id = $1 and id = $2`,
      [scope.organizationId, runA.id],
    );
    assertEquals(statusA.rows[0].status, runA.status);
    const disabledCount = await runCount();
    assertEquals(
      await conflictCode(
        await startById(workflow.id),
      ),
      "STATE_CONFLICT",
    );
    const explicitTask = await createPresetTask(fixture, scope, repository, {
      title: "Explicit version while disabled",
    });
    assertEquals(
      await conflictCode(
        await apiCall(
          fixture,
          scope,
          "POST",
          `/v1/tasks/${explicitTask.id}/runs`,
          {
            body: {
              workflowVersionId: r2,
              executionMode: "repository",
              repositoryProfileId: repository.profileId,
              budgetLimitUsd: "5.00",
              inputs: { brief: "Retry failed uploads twice." },
            },
          },
        ),
      ),
      "STATE_CONFLICT",
    );
    assertEquals(await runCount(), disabledCount);
    await setEnabled(workflow.id, true);
    const runC = await expectJson<RunBody>(await startById(workflow.id), 201);
    assertEquals(runC.workflowVersionId, r2);

    // 6-4 workflowId naming the preset definition is locked; preset still works.
    const presetTask = await createPresetTask(fixture, scope, repository, {
      title: "Preset start",
    });
    await expectJson<RunBody>(
      await startPresetRun(fixture, scope, presetTask, repository),
      201,
    );
    const presetDefinition = await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.workflow_definitions
        where organization_id = $1 and slug = $2`,
      [scope.organizationId, FIXED_CODING_PRESET.slug],
    );
    assertEquals(presetDefinition.rows.length, 1);
    const lockedCount = await runCount();
    assertEquals(
      await conflictCode(
        await startById(presetDefinition.rows[0].id),
      ),
      "STATE_CONFLICT",
    );
    assertEquals(await runCount(), lockedCount);
    const nextPreset = await createPresetTask(fixture, scope, repository, {
      title: "Preset start again",
    });
    await expectJson<RunBody>(
      await startPresetRun(fixture, scope, nextPreset, repository),
      201,
    );

    // Unknown workflow id is a plain 404.
    assertEquals((await startById(crypto.randomUUID())).status, 404);
  }, { env: presetBudgetEnv }));
