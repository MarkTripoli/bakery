import { assert, assertEquals } from "@std/assert";
import { commitArtifactVersion } from "../../apps/server/src/modules/knowledge/persistence.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import type { CoordinationFixture } from "./coordination-fixture.ts";

export type Lane = {
  laneKey: string;
  childTaskId: string | null;
  reusedFromLaneId: string | null;
  status: string;
  repositoryId: string;
  laneDigest: string;
  prerequisites: string[];
};
export type Plan = {
  id: string;
  parentTaskId: string;
  revision: number;
  status: string;
  digest: string;
  origin: { kind: string } & Record<string, unknown>;
  lanes: Lane[];
};

export async function createPlan(
  fx: CoordinationFixture,
  parentTaskId: string,
  spec: unknown,
  extra: Record<string, unknown> = {},
) {
  return await fx.send(fx.developer, "POST", "/v1/coordination-plans", {
    body: { parentTaskId, spec, ...extra },
  });
}

export async function createFromWorkflow(
  fx: CoordinationFixture,
  body: Record<string, unknown>,
) {
  return await fx.send(
    fx.developer,
    "POST",
    "/v1/coordination-plans/from-workflow",
    { body },
  );
}

export async function planOf(response: Response, status = 201): Promise<Plan> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as Plan;
}

export async function materialize(fx: CoordinationFixture, id: string) {
  return await planOf(
    await fx.send(
      fx.developer,
      "POST",
      `/v1/coordination-plans/${id}/materialize`,
      { body: {} },
    ),
  );
}

export async function getPlan(fx: CoordinationFixture, id: string) {
  return await planOf(
    await fx.send(fx.developer, "GET", `/v1/coordination-plans/${id}`),
    200,
  );
}

export const laneOf = (plan: Plan, key: string) => {
  const found = plan.lanes.find((l) => l.laneKey === key);
  assert(found, `lane ${key}`);
  return found;
};

export const childOf = (plan: Plan, key: string) =>
  laneOf(plan, key).childTaskId as string;

const hex64 = () =>
  (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "").slice(0, 64);

/**
 * Commits an artifact version on a lane child. The first call creates the
 * artifact; later calls with the same name and type add a new version and make
 * it current under the same artifact id, like a worker publishing again.
 */
export async function publishOutput(
  fx: CoordinationFixture,
  taskId: string,
  name: string,
  artifactType = "patch",
) {
  const existing = await fx.owner`
    select a.id, a.revision from bakery.artifacts a
     where a.organization_id = ${fx.organizationId} and a.task_id = ${taskId}
       and a.name = ${name} and a.artifact_type = ${artifactType}`;
  const artifactId = existing[0]?.id ??
    (await fx.owner`
      insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name)
      values (${crypto.randomUUID()}, ${fx.organizationId}, ${taskId}, ${artifactType}, ${name})
      returning id`)[0].id;
  // Like the commit path: the version takes the artifact's current revision,
  // then the artifact advances.
  const revision = existing[0]?.revision ?? 1;
  const versionId = crypto.randomUUID();
  const sha = hex64();
  await fx.owner`
    insert into bakery.artifact_versions (
      id, organization_id, artifact_id, task_id, author_id, revision, content,
      sha256, size_bytes, media_type
    ) values (${versionId}, ${fx.organizationId}, ${artifactId}, ${taskId},
      ${fx.admin.principalId}, ${revision}, ${new Uint8Array([
    1,
    2,
    3,
  ])}, ${sha}, 3,
      'application/json')`;
  await fx.owner`
    update bakery.artifacts set current_version_id = ${versionId}, revision = ${
    revision + 1
  }
     where organization_id = ${fx.organizationId} and id = ${artifactId}`;
  return { artifactId, versionId, sha };
}

export async function startRun(fx: CoordinationFixture, taskId: string) {
  const pinned = await fx.owner`
    select repository_profile_id as id from bakery.tasks
     where organization_id = ${fx.organizationId} and id = ${taskId}`;
  return await fx.sendTask(fx.developer, "POST", `/v1/tasks/${taskId}/runs`, {
    body: {
      workflowVersionId: fx.workflowVersionId,
      repositoryProfileId: pinned[0].id,
      executionMode: "repository",
      budgetLimitUsd: "0.005000",
      inputs: { taskId },
    },
  });
}

/** Consumed inputs the admission froze into a run snapshot. */
export async function runInputs(fx: CoordinationFixture, runId: string) {
  const rows = await fx.owner`
    select snapshot->'coordination'->'inputs' as inputs
      from bakery.workflow_runs
     where organization_id = ${fx.organizationId} and id = ${runId}`;
  return (rows[0].inputs ?? []) as {
    fromLane: string;
    outputKey: string;
    artifactVersionId: string;
    sha256: string;
  }[];
}

/** Marks the run completed and the lane child's task completed. */
export async function finishRun(
  fx: CoordinationFixture,
  runId: string,
  taskId: string,
) {
  await fx.owner`
    update bakery.workflow_runs
       set status = 'completed', finished_at = now(), version = version + 1
     where organization_id = ${fx.organizationId} and id = ${runId}`;
  await fx.owner`
    update bakery.tasks set status = 'completed', version = version + 1
     where organization_id = ${fx.organizationId} and id = ${taskId}`;
}

/**
 * Runs one lane the way a worker would: admits a run (which freezes the
 * consumed inputs), commits the lane's output if any, completes run and task.
 * Throws on a refused admission so a test never hides an ordering bug.
 */
export async function completeLane(
  fx: CoordinationFixture,
  plan: Plan,
  key: string,
  outputName?: string,
) {
  const taskId = childOf(plan, key);
  const response = await startRun(fx, taskId);
  const text = await response.text();
  assertEquals(response.status, 201, `${key}: ${text}`);
  const run = JSON.parse(text) as { id: string };
  const output = outputName
    ? await publishOutput(fx, taskId, outputName)
    : null;
  await finishRun(fx, run.id, taskId);
  return { runId: run.id, output };
}

/** Reconciles through the same hook the worker result and artifact paths use. */
export async function reconcileTask(fx: CoordinationFixture, taskId: string) {
  const { withPgTransaction } = await import(
    "../../apps/server/src/platform/database.ts"
  );
  const { reconcileCoordinationForTerminalTask } = await import(
    "../../apps/server/src/modules/work/coordination-projection.ts"
  );
  await withPgTransaction(fx.ownerPg, async (transaction) => {
    await reconcileCoordinationForTerminalTask(transaction, {
      organizationId: fx.organizationId,
      taskId,
      traceId: "lane-test-trace",
    });
  });
}

/**
 * Commits an artifact version through the real artifact commit path workers
 * use (`commitArtifactVersion`). Creates the artifact on first use. The commit
 * reconciles the coordination plan when the artifact is a declared lane output.
 */
export async function commitArtifact(
  fx: CoordinationFixture,
  taskId: string,
  name: string,
  artifactType = "patch",
) {
  const task = (await fx.owner`
    select application_id, repository_id, conversation_id from bakery.tasks
     where organization_id = ${fx.organizationId} and id = ${taskId}`)[0];
  const existing = await fx.owner`
    select id, revision, version, current_version_id from bakery.artifacts
     where organization_id = ${fx.organizationId} and task_id = ${taskId}
       and name = ${name} and artifact_type = ${artifactType}`;
  const artifact = existing[0] ?? (await fx.owner`
    insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name)
    values (${crypto.randomUUID()}, ${fx.organizationId}, ${taskId}, ${artifactType}, ${name})
    returning id, revision, version, current_version_id`)[0];
  const content = new TextEncoder().encode(`commit ${crypto.randomUUID()}`);
  const digest = await crypto.subtle.digest("SHA-256", content);
  const sha256 = [...new Uint8Array(digest)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  await withPgTransaction(fx.ownerPg, async (transaction) => {
    await commitArtifactVersion(transaction, {
      scope: {
        organizationId: fx.organizationId,
        taskId,
        applicationId: task.application_id,
        repositoryId: task.repository_id,
        conversationId: task.conversation_id,
      },
      parent: {
        id: artifact.id,
        revision: artifact.revision,
        version: artifact.version,
        currentVersionId: artifact.current_version_id,
      },
      version: {
        parentVersionId: artifact.current_version_id
          ? `"${artifact.current_version_id}"`
          : null,
        runStepId: null,
        authorId: fx.admin.principalId,
        subjectHeadSha: null,
        subjectBaseSha: null,
        stepKey: null,
        metadata: {},
        content,
        sha256,
        mediaType: "application/json",
      },
      promotion: { kind: "human" },
    });
  });
}
