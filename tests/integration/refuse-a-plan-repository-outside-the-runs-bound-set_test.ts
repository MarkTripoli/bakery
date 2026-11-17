/**
 * A plan binds a repository through its inputs. `$task.repositoryId` is the
 * task's own repository and is nullable, so a plan that needs a repository
 * binds `$input.repositoryId` instead - a value the caller supplies. Admission
 * must therefore check that the supplied repository is one the run is actually
 * bound to, or a caller could point a step at a repository the task never had.
 *
 * The check is SET MEMBERSHIP, not equality with the profile: a coordination
 * lane binds its own repository, which is deliberately not the profile's. Both
 * directions are asserted here, because a profile-equality check passes the
 * refusal direction and only fails the acceptance direction.
 */
import { assert, assertEquals } from "@std/assert";
import { apiCall, createPresetTask } from "../helpers/fixed-coding-preset.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  planDefinition,
  publishWorkflow,
  seedRulesRepository,
} from "../helpers/pinned-rules.ts";

const PLAN = planDefinition({
  inputs: {
    plan: { type: "uuid", required: true },
    repositoryId: { type: "uuid", required: true },
    instructions: { type: "string", required: true },
  },
  steps: [{
    id: "implement",
    uses: "harness.implement",
    with: {
      repositoryId: "$input.repositoryId",
      planArtifact: "$input.plan",
      instructions: "$input.instructions",
    },
  }],
});

type Fixture =
  & Parameters<typeof createPresetTask>[0]
  & Parameters<typeof createPresetTask>[1]
  & Parameters<typeof withWorkerFixture>[0] extends (f: infer F) => unknown ? F
  : never;

async function startWith(
  fixture: Fixture,
  repository: Awaited<ReturnType<typeof seedRulesRepository>>,
  workflowId: string,
  repositoryId: string,
) {
  const task = await createPresetTask(fixture, fixture, repository);
  const response = await apiCall(
    fixture,
    fixture,
    "POST",
    `/v1/tasks/${task.id}/runs`,
    {
      body: {
        executionMode: "repository",
        repositoryProfileId: repository.profileId,
        workflowId,
        budgetLimitUsd: "5",
        inputs: {
          plan: crypto.randomUUID(),
          repositoryId,
          instructions: "Do it.",
        },
      },
    },
  );
  return {
    task,
    response,
    body: await response.json() as Record<string, unknown>,
  };
}

Deno.test("a plan naming a repository the run is not bound to is refused", async () => {
  await withWorkerFixture(async (fixture) => {
    const repository = await seedRulesRepository(fixture, fixture, "bound-set");
    const workflow = await publishWorkflow(
      fixture,
      fixture,
      "bound-set",
      PLAN,
      { activate: true },
    );
    const { response, body } = await startWith(
      fixture,
      repository,
      workflow.workflowId,
      crypto.randomUUID(),
    );
    assertEquals(response.status, 422);
    assertEquals(body.code, "UNPROCESSABLE");
    const issues = body.issues as { path: string[]; code: string }[];
    assert(
      issues.some((issue) =>
        issue.code === "repository_not_bound_to_task" &&
        issue.path.join("/") === "inputs/repositoryId"
      ),
      `expected a repository_not_bound_to_task refusal, got ${
        JSON.stringify(issues)
      }`,
    );
  });
});

Deno.test("a plan naming a bound repository that is not the profile's is admitted", async () => {
  await withWorkerFixture(async (fixture) => {
    const repository = await seedRulesRepository(
      fixture,
      fixture,
      "bound-set-2",
    );
    const workflow = await publishWorkflow(
      fixture,
      fixture,
      "bound-set-2",
      PLAN,
      { activate: true },
    );
    // A coordination lane's repository: a real repository in the same
    // application, linked to the task, deliberately not the profile's. A
    // profile-equality check would refuse it.
    const laneRepositoryId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.repositories (
         id, organization_id, application_id, integration_connection_id,
         provider_repo_id, owner, name, default_branch
       )
       select $1, organization_id, application_id, integration_connection_id,
              provider_repo_id || '-lane', owner, name || '-lane', default_branch
         from bakery.repositories where id = $2`,
      [laneRepositoryId, repository.repositoryId],
    );
    const task = await createPresetTask(fixture, fixture, repository);
    await fixture.pgDatabase.query(
      `insert into bakery.task_repositories (
         organization_id, application_id, task_id, repository_id,
         role, provenance, created_by
       ) select $1, $2, $3, $4, 'lane', 'coordination', created_by
           from bakery.tasks where id = $3`,
      [
        repository.organizationId,
        repository.applicationId,
        task.id,
        laneRepositoryId,
      ],
    );
    const response = await apiCall(
      fixture,
      fixture,
      "POST",
      `/v1/tasks/${task.id}/runs`,
      {
        body: {
          executionMode: "repository",
          repositoryProfileId: repository.profileId,
          workflowId: workflow.workflowId,
          budgetLimitUsd: "5",
          inputs: {
            plan: crypto.randomUUID(),
            repositoryId: laneRepositoryId,
            instructions: "Do it.",
          },
        },
      },
    );
    const body = await response.json() as Record<string, unknown>;
    const issues = (body.issues ?? []) as { code: string }[];
    assert(
      !issues.some((issue) => issue.code === "repository_not_bound_to_task"),
      `a bound lane repository must be admitted, got ${JSON.stringify(body)}`,
    );
  });
});
