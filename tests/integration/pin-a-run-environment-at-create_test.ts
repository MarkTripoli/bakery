import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { JobSeed } from "../helpers/worker-execution.ts";
import { type AgentFixture, agentSession } from "../helpers/agent-session.ts";

// #427: a run's environment is pinned at creation. A spawned run inherits its
// parent's unless it asks for offline, and an offline parent can never open a
// live child. Driven through the real app and the session gateway.

/** A child task below the session's own task, inserted as the job seeder does. */
async function childTask(
  fixture: AgentFixture,
  parent: JobSeed,
): Promise<{ taskId: string; profileId: string }> {
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.conversations (
       id, organization_id, application_id, title, created_by, repository_id
     ) select $3, organization_id, application_id, 'child', created_by,
              repository_id
         from bakery.conversations
        where organization_id = $1 and id = $2`,
    [fixture.organizationId, parent.conversationId, conversationId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.tasks (
       id, organization_id, application_id, conversation_id, title, task_type,
       status, priority, created_by, repository_id, repository_profile_id,
       repository_profile_revision, repository_profile_digest, parent_task_id
     ) select $3, organization_id, application_id, $4, 'child', task_type,
              'draft', priority, created_by, repository_id,
              repository_profile_id, repository_profile_revision,
              repository_profile_digest, id
         from bakery.tasks
        where organization_id = $1 and id = $2`,
    [fixture.organizationId, parent.taskId, taskId, conversationId],
  );
  const profile = await fixture.pgDatabase.query<{ id: string }>(
    `select repository_profile_id as id from bakery.tasks
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, taskId],
  );
  return { taskId, profileId: profile.rows[0].id };
}

async function giveBudget(fixture: AgentFixture, runId: string, usd: string) {
  await fixture.pgDatabase.query(
    `update bakery.workflow_runs set budget_limit_usd = $3
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, runId, usd],
  );
}
const runCount = async (fixture: AgentFixture) =>
  Number(
    (await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.workflow_runs where organization_id = $1`,
      [fixture.organizationId],
    )).rows[0].n,
  );

const envOf = async (fixture: AgentFixture, id: string) =>
  (await fixture.pgDatabase.query<{ environment: string }>(
    `select environment from bakery.workflow_runs where organization_id = $1 and id = $2`,
    [fixture.organizationId, id],
  )).rows[0].environment;

const spawnEnv = (
  session: Awaited<ReturnType<typeof agentSession>>,
  child: { taskId: string; profileId: string },
  environment?: "live" | "offline",
) =>
  session.call("runs.create", {
    id: child.taskId,
    workflowVersionId: session.own.workflowVersionId,
    repositoryProfileId: child.profileId,
    executionMode: "repository",
    budgetLimitUsd: "0.010000",
    ...(environment === undefined ? {} : { environment }),
    inputs: { taskId: child.taskId },
  });

async function parentIs(fixture: AgentFixture, runId: string, env: string) {
  await fixture.pgDatabase.query(
    `update bakery.workflow_runs set environment = $3 where organization_id = $1 and id = $2`,
    [fixture.organizationId, runId, env],
  );
}

Deno.test("an offline parent's spawned child is offline (row and response)", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_start" });
    await giveBudget(fixture, session.own.runId, "0.050000");
    await parentIs(fixture, session.own.runId, "offline");
    const child = await childTask(fixture, session.own);
    const response = await spawnEnv(session, child);
    const text = await response.text();
    assertEquals(response.status, 200, text);
    const run =
      (JSON.parse(text) as { result: { id: string; environment: string } })
        .result;
    assertEquals(await envOf(fixture, run.id), "offline");
    assertEquals(run.environment, "offline");
  }));

Deno.test("an offline parent cannot open a live child, and nothing is written", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_start" });
    await giveBudget(fixture, session.own.runId, "0.050000");
    await parentIs(fixture, session.own.runId, "offline");
    const child = await childTask(fixture, session.own);
    const before = await runCount(fixture);
    const response = await spawnEnv(session, child, "live");
    const text = await response.text();
    assert(
      response.status !== 200,
      "live child of offline parent was admitted: " + text,
    );
    assertEquals(await runCount(fixture), before);
  }));

Deno.test("a live parent's child is live", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_start" });
    await giveBudget(fixture, session.own.runId, "0.050000");
    const child = await childTask(fixture, session.own);
    const response = await spawnEnv(session, child);
    const text = await response.text();
    assertEquals(response.status, 200, text);
    const run = (JSON.parse(text) as { result: { id: string } }).result;
    assertEquals(await envOf(fixture, run.id), "live");
  }));

Deno.test("a live parent may open an offline child, stored as asked", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_start" });
    await giveBudget(fixture, session.own.runId, "0.050000");
    const child = await childTask(fixture, session.own);
    const response = await spawnEnv(session, child, "offline");
    const text = await response.text();
    assertEquals(response.status, 200, text);
    const run = (JSON.parse(text) as { result: { id: string } }).result;
    assertEquals(await envOf(fixture, run.id), "offline");
  }));
