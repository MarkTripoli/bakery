import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import type { JobSeed } from "../helpers/worker-execution.ts";
import { type AgentFixture, agentSession } from "../helpers/agent-session.ts";

// #413 spawn half: an agent starts a run only where its workflow holds run_start
// along the whole spawn chain, inside its own task tree, and under depth, count
// and budget checks made at admission, before anything is written. Driven
// through the real app and the session gateway.

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

const spawn = (
  session: Awaited<ReturnType<typeof agentSession>>,
  child: { taskId: string; profileId: string },
  budgetLimitUsd?: string,
) =>
  session.call("runs.create", {
    id: child.taskId,
    workflowVersionId: session.own.workflowVersionId,
    repositoryProfileId: child.profileId,
    executionMode: "repository",
    ...(budgetLimitUsd === undefined ? {} : { budgetLimitUsd }),
    inputs: { taskId: child.taskId },
  });

async function giveBudget(fixture: AgentFixture, runId: string, usd: string) {
  await fixture.pgDatabase.query(
    `update bakery.workflow_runs set budget_limit_usd = $3
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, runId, usd],
  );
}

Deno.test("an agent spawns a child run in its own tree, recorded and linked", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_start" });
    await giveBudget(fixture, session.own.runId, "0.050000");
    assert((await session.tools()).includes("runs.create"));
    const child = await childTask(fixture, session.own);
    const response = await spawn(session, child, "0.010000");
    const text = await response.text();
    assertEquals(response.status, 200, text);
    const run = (JSON.parse(text) as { result: { id: string } }).result;

    const row = await fixture.pgDatabase.query<
      { spawned_by_run_id: string | null; task_id: string }
    >(
      `select spawned_by_run_id, task_id from bakery.workflow_runs
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, run.id],
    );
    assertEquals(row.rows[0].spawned_by_run_id, session.own.runId);
    assertEquals(row.rows[0].task_id, child.taskId);
    const audit = await fixture.pgDatabase.query<{
      details: { actorKind?: string; fromRunId?: string; depth?: number };
    }>(
      `select details from bakery.audit_events
        where organization_id = $1 and operation = 'runs.spawn.agent'
          and resource_id = $2`,
      [fixture.organizationId, run.id],
    );
    assertEquals(audit.rows.length, 1);
    assertEquals(audit.rows[0].details.actorKind, "agent");
    assertEquals(audit.rows[0].details.fromRunId, session.own.runId);
    assertEquals(audit.rows[0].details.depth, 1);
  }));

type Session = Awaited<ReturnType<typeof agentSession>>;

/** A run row copied from the session's own, optionally linked to a parent. */
async function copyRun(
  fixture: AgentFixture,
  ownRunId: string,
  spawnedBy: string | null,
  status = "running",
): Promise<string> {
  const id = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.workflow_runs (
       id, organization_id, task_id, workflow_version_id, requested_by, status,
       snapshot, budget_limit_usd, spawned_by_run_id
     ) select $3, organization_id, task_id, workflow_version_id, requested_by,
              $4, snapshot, 0, $5
         from bakery.workflow_runs
        where organization_id = $1 and id = $2`,
    [fixture.organizationId, ownRunId, id, status, spawnedBy],
  );
  return id;
}

const runCount = async (fixture: AgentFixture) =>
  Number(
    (await fixture.pgDatabase.query<{ n: string }>(
      `select count(*)::text as n from bakery.workflow_runs
      where organization_id = $1`,
      [fixture.organizationId],
    )).rows[0].n,
  );

/** Calls the spawn and returns its status and Problem reason, if any. */
async function refusedWith(response: Response) {
  const body = JSON.parse(await response.text()) as { reason?: string };
  return { status: response.status, reason: body.reason };
}

async function granted(
  fixture: AgentFixture,
  usd = "0.050000",
): Promise<Session> {
  const session = await agentSession(fixture, { granted: "run_start" });
  await giveBudget(fixture, session.own.runId, usd);
  return session;
}

Deno.test("without the run_start grant a spawn is not offered and is refused", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: null });
    assert(!(await session.tools()).includes("runs.create"));
    const child = await childTask(fixture, session.own);
    const before = await runCount(fixture);
    // Refused at the gateway, which never minted the scope: nothing was written.
    const response = await spawn(session, child, "0.001000");
    assertEquals(response.status, 403, await response.text());
    assertEquals(await runCount(fixture), before);
  }));

Deno.test("an agent cannot start a run on a task outside its own tree", () =>
  withWorkerFixture(async (fixture) => {
    const session = await granted(fixture);
    // A task that hangs under no task of the session's: detached from its parent.
    const outsider = await childTask(fixture, session.own);
    await fixture.pgDatabase.query(
      `update bakery.tasks set parent_task_id = null
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, outsider.taskId],
    );
    const before = await runCount(fixture);
    const response = await spawn(session, outsider, "0.001000");
    assertEquals(response.status, 404, await response.text());
    assertEquals(await runCount(fixture), before);
  }));

Deno.test("the live children of one run are bounded, and a refusal writes nothing", () =>
  withWorkerFixture(async (fixture) => {
    const session = await granted(fixture);
    // Five live children: the configured default bound.
    for (let index = 0; index < 5; index += 1) {
      await copyRun(fixture, session.own.runId, session.own.runId);
    }
    const child = await childTask(fixture, session.own);
    const before = await runCount(fixture);
    const refused = await refusedWith(await spawn(session, child, "0.001000"));
    assertEquals(refused, { status: 409, reason: "spawn_count_exceeded" });
    assertEquals(await runCount(fixture), before);
  }));

Deno.test("a finished child frees its slot: the count reads live values", () =>
  withWorkerFixture(async (fixture) => {
    const session = await granted(fixture);
    const finished: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      finished.push(
        await copyRun(fixture, session.own.runId, session.own.runId),
      );
    }
    const child = await childTask(fixture, session.own);
    assertEquals(
      (await refusedWith(await spawn(session, child, "0.001000"))).reason,
      "spawn_count_exceeded",
    );
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set status = 'completed'
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, finished[0]],
    );
    const response = await spawn(session, child, "0.001000");
    assertEquals(response.status, 200, await response.text());
  }));

Deno.test("depth is bounded at admission: the chain stops at the limit", () =>
  withWorkerFixture(async (fixture) => {
    const session = await granted(fixture);
    // Two ancestors put the session at depth 2, so a child is depth 3: allowed.
    const first = await copyRun(fixture, session.own.runId, null);
    const second = await copyRun(fixture, session.own.runId, first);
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set spawned_by_run_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, session.own.runId, second],
    );
    const child = await childTask(fixture, session.own);
    const allowed = await spawn(session, child, "0.001000");
    assertEquals(allowed.status, 200, await allowed.text());

    // One more ancestor puts it at depth 3, so a child would be depth 4.
    const third = await copyRun(fixture, session.own.runId, second);
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set spawned_by_run_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, session.own.runId, third],
    );
    const deeper = await childTask(fixture, session.own);
    const before = await runCount(fixture);
    const refused = await refusedWith(await spawn(session, deeper, "0.001000"));
    assertEquals(refused, { status: 409, reason: "spawn_depth_exceeded" });
    assertEquals(await runCount(fixture), before);
  }));

Deno.test("a child's budget must be named and fit the parent's headroom", () =>
  withWorkerFixture(async (fixture) => {
    const session = await granted(fixture, "0.010000");
    const child = await childTask(fixture, session.own);
    const before = await runCount(fixture);
    assertEquals(
      await refusedWith(await spawn(session, child)),
      { status: 409, reason: "spawn_budget_required" },
    );
    assertEquals(
      await refusedWith(await spawn(session, child, "0.010001")),
      { status: 409, reason: "spawn_budget_exceeded" },
    );
    assertEquals(await runCount(fixture), before);
    // Exactly the headroom fits.
    const fits = await spawn(session, child, "0.010000");
    assertEquals(fits.status, 200, await fits.text());
  }));

Deno.test("a child's budget is taken from what live siblings already hold", () =>
  withWorkerFixture(async (fixture) => {
    const session = await granted(fixture, "0.010000");
    const sibling = await copyRun(
      fixture,
      session.own.runId,
      session.own.runId,
    );
    await giveBudget(fixture, sibling, "0.008000");
    const child = await childTask(fixture, session.own);
    assertEquals(
      (await refusedWith(await spawn(session, child, "0.003000"))).reason,
      "spawn_budget_exceeded",
    );
    const fits = await spawn(session, child, "0.002000");
    assertEquals(fits.status, 200, await fits.text());
  }));

/** A second workflow with its own version, which no grant covers. */
async function ungrantedWorkflowVersion(
  fixture: AgentFixture,
  from: { workflowId: string; workflowVersionId: string },
): Promise<string> {
  const workflowId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name)
     select $3::uuid, organization_id, 'ungranted-' || gen_random_uuid()::text,
            'Ungranted'
       from bakery.workflow_definitions
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, from.workflowId, workflowId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.workflow_versions (
       id, organization_id, workflow_id, revision, source_yaml, normalized_spec,
       digest, status, created_by
     ) select $3, organization_id, $4, 1, source_yaml, normalized_spec,
              digest || '-ungranted', status, created_by
         from bakery.workflow_versions
        where organization_id = $1 and id = $2`,
    [fixture.organizationId, from.workflowVersionId, versionId, workflowId],
  );
  return versionId;
}

Deno.test("a child never holds more authority than its parent", () =>
  withWorkerFixture(async (fixture) => {
    const session = await granted(fixture);
    // The session's own workflow holds run_start, but it was itself spawned by a
    // run of a workflow that does not. The power is the intersection along the
    // chain, so it is gone: a child cannot launder authority its parent lacked.
    const ancestor = await copyRun(fixture, session.own.runId, null);
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set workflow_version_id = $3
        where organization_id = $1 and id = $2`,
      [
        fixture.organizationId,
        ancestor,
        await ungrantedWorkflowVersion(fixture, session.own),
      ],
    );
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set spawned_by_run_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, session.own.runId, ancestor],
    );
    const child = await childTask(fixture, session.own);
    const before = await runCount(fixture);
    const refused = await refusedWith(await spawn(session, child, "0.001000"));
    assertEquals(refused, { status: 403, reason: "spawn_requires_grant" });
    assertEquals(await runCount(fixture), before);
  }));

Deno.test("when every workflow along the chain holds run_start the spawn proceeds", () =>
  withWorkerFixture(async (fixture) => {
    // The control for the intersection case: the same chain, with the ancestor's
    // workflow granted too, is allowed. Without it the refusal above would pass
    // against an implementation that never allows a spawned run to spawn.
    const session = await granted(fixture);
    const ancestor = await copyRun(fixture, session.own.runId, null);
    const versionId = await ungrantedWorkflowVersion(fixture, session.own);
    const workflow = await fixture.pgDatabase.query<{ workflow_id: string }>(
      `select workflow_id from bakery.workflow_versions
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, versionId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.agent_power_grants
         (organization_id, power, workflow_id, granted_by)
       values ($1, 'run_start', $2, $3)`,
      [
        fixture.organizationId,
        workflow.rows[0].workflow_id,
        fixture.principalId,
      ],
    );
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set workflow_version_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, ancestor, versionId],
    );
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set spawned_by_run_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, session.own.runId, ancestor],
    );
    const child = await childTask(fixture, session.own);
    const allowed = await spawn(session, child, "0.001000");
    assertEquals(allowed.status, 200, await allowed.text());
  }));

Deno.test("permission is checked before depth, count and budget", () =>
  withWorkerFixture(async (fixture) => {
    // The grant is gone while every limit is also breached: the answer is the
    // permission refusal, so a caller who may not spawn learns nothing about
    // the limits.
    const session = await granted(fixture, "0.010000");
    for (let index = 0; index < 5; index += 1) {
      await copyRun(fixture, session.own.runId, session.own.runId);
    }
    const child = await childTask(fixture, session.own);
    await fixture.pgDatabase.query(
      `delete from bakery.agent_power_grants where id = $1`,
      [session.grantId],
    );
    const refused = await refusedWith(await spawn(session, child));
    assertEquals(refused, { status: 403, reason: "spawn_requires_grant" });
  }));

Deno.test("a revoked run_start grant stops the next spawn", () =>
  withWorkerFixture(async (fixture) => {
    const session = await granted(fixture);
    const child = await childTask(fixture, session.own);
    await fixture.pgDatabase.query(
      `delete from bakery.agent_power_grants where id = $1`,
      [session.grantId],
    );
    const refused = await refusedWith(await spawn(session, child, "0.001000"));
    assertEquals(refused, { status: 403, reason: "spawn_requires_grant" });
  }));

Deno.test("two spawns racing for the last slot: exactly one proceeds", () =>
  withWorkerFixture(async (fixture) => {
    const session = await granted(fixture);
    // Four live children of five: one slot left, and two spawns want it.
    for (let index = 0; index < 4; index += 1) {
      await copyRun(fixture, session.own.runId, session.own.runId);
    }
    const [first, second] = [
      await childTask(fixture, session.own),
      await childTask(fixture, session.own),
    ];
    const before = await runCount(fixture);
    const answers = await Promise.all([
      spawn(session, first, "0.001000"),
      spawn(session, second, "0.001000"),
    ]);
    const outcomes = await Promise.all(
      answers.map((answer) => refusedWith(answer)),
    );
    const won = outcomes.filter((outcome) => outcome.status === 200);
    const lost = outcomes.filter((outcome) => outcome.status === 409);
    assertEquals(won.length, 1, JSON.stringify(outcomes));
    assertEquals(lost.length, 1, JSON.stringify(outcomes));
    assertEquals(lost[0].reason, "spawn_count_exceeded");
    // The loser wrote nothing: one new run, not two.
    assertEquals(await runCount(fixture), before + 1);
  }));
