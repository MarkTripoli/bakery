import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  type AgentFixture,
  agentSession,
  copyRunTo,
  grantPower,
  insertChildTask,
  seedOtherRun,
  ungrantedWorkflowVersion,
} from "../helpers/agent-session.ts";

// #414 slice 2: an agent pauses, resumes, cancels or interrupts a run only where
// a person granted the run_control power to its workflow, and the control is
// recorded as an agent's action. Driven through the real app and the session
// gateway. The target run has no live attempt, where only a cancel is
// admissible, so a cancel is the control driven end to end.

const cancel = (
  session: Awaited<ReturnType<typeof agentSession>>,
  runId: string,
) => session.call("runs.control", { id: runId, action: "cancel" });

async function runStatus(fixture: AgentFixture, runId: string) {
  const row = await fixture.pgDatabase.query<{ status: string }>(
    `select status from bakery.workflow_runs where organization_id = $1 and id = $2`,
    [fixture.organizationId, runId],
  );
  return row.rows[0].status;
}

Deno.test("an agent cancels another run where its workflow is granted, labelled as an agent's action", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_control" });
    assert((await session.tools()).includes("runs.control"));
    // The target's workflow must hold the power too, not only the agent's own.
    const target = await seedOtherRun(fixture);
    await grantPower(fixture, target.workflowId, "run_control");
    const response = await cancel(session, target.runId);
    assertEquals(response.status, 200, await response.text());
    assertEquals(await runStatus(fixture, target.runId), "canceled");

    const audit = await fixture.pgDatabase.query<{
      details: { actorKind?: string; onBehalfOf?: string; fromRunId?: string };
      principal_id: string;
    }>(
      `select details, principal_id from bakery.audit_events
        where organization_id = $1 and operation = 'runs.control.agent'
          and resource_id = $2`,
      [fixture.organizationId, target.runId],
    );
    assertEquals(audit.rows.length, 1);
    // Attributed to the person, labelled as the agent's action, and naming the
    // run the agent acted from (O50).
    assertEquals(audit.rows[0].principal_id, fixture.principalId);
    assertEquals(audit.rows[0].details.actorKind, "agent");
    assertEquals(audit.rows[0].details.onBehalfOf, fixture.principalId);
    assertEquals(audit.rows[0].details.fromRunId, session.own.runId);
  }));

Deno.test("without a grant run control is not offered and not allowed", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: null });
    assert(!(await session.tools()).includes("runs.control"));
    const target = await seedOtherRun(fixture);
    const response = await cancel(session, target.runId);
    assertEquals(response.status, 403, await response.text());
    assertEquals(await runStatus(fixture, target.runId) === "canceled", false);
  }));

Deno.test("a decide grant does not give run control", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "decide" });
    assert(!(await session.tools()).includes("runs.control"));
    const target = await seedOtherRun(fixture);
    const response = await cancel(session, target.runId);
    assertEquals(response.status, 403, await response.text());
  }));

Deno.test("a revoked grant stops the next control", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_control" });
    const target = await seedOtherRun(fixture);
    await fixture.pgDatabase.query(
      `delete from bakery.agent_power_grants where id = $1`,
      [session.grantId],
    );
    // The scope was minted at claim, but the action rechecks the grant live.
    const response = await cancel(session, target.runId);
    assertEquals(response.status, 403, await response.text());
    assertEquals(await runStatus(fixture, target.runId) === "canceled", false);
  }));

Deno.test("runs.retry is never offered or callable, even with run_control", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_control" });
    assert(!(await session.tools()).includes("runs.retry"));
    const target = await seedOtherRun(fixture);
    const response = await session.call("runs.retry", { id: target.runId });
    // Refused by the gateway: not a tool, however the session is granted.
    assert(
      response.status >= 400 && response.status < 500,
      `runs.retry answered ${response.status}`,
    );
    await response.body?.cancel();
  }));

const noControlAudit = async (fixture: AgentFixture) =>
  (await fixture.pgDatabase.query(
    `select 1 from bakery.audit_events
      where organization_id = $1 and operation = 'runs.control.agent'`,
    [fixture.organizationId],
  )).rows.length;

Deno.test("an agent never controls its own run", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_control" });
    // Without the own-work guard the cancel stops the agent's own session and
    // never returns, and the stuck request then blocks teardown too, so a
    // race around the call cannot fail the test. A watchdog ends the run at
    // once with the reason instead of hanging.
    const watchdog = setTimeout(() => {
      console.error(
        "FAIL: cancelling the agent's own run did not return; is the own-work guard missing?",
      );
      Deno.exit(1);
    }, 60_000);
    const response = await cancel(session, session.own.runId).finally(() =>
      clearTimeout(watchdog)
    );
    assertEquals(response.status, 403, await response.text());
    assertEquals(
      await runStatus(fixture, session.own.runId) === "canceled",
      false,
    );
    assertEquals(await noControlAudit(fixture), 0);
  }));

Deno.test("an agent never controls another run of its own task, such as a retry", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_control" });
    const retry = await copyRunTo(fixture, session.own.runId);
    const response = await cancel(session, retry);
    assertEquals(response.status, 403, await response.text());
    assertEquals(await runStatus(fixture, retry) === "canceled", false);
    assertEquals(await noControlAudit(fixture), 0);
  }));

Deno.test("an agent never controls a run in its own task lineage", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_control" });
    const child = await insertChildTask(fixture, session.own);
    const below = await copyRunTo(fixture, session.own.runId, {
      taskId: child.taskId,
    });
    const response = await cancel(session, below);
    assertEquals(response.status, 403, await response.text());
    assertEquals(await runStatus(fixture, below) === "canceled", false);
  }));

Deno.test("an agent never controls a run of the task its own task hangs under", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_control" });
    const parent = await seedOtherRun(fixture);
    // The parent's workflow holds the power too, so a refusal is the lineage
    // check and not a missing grant.
    await grantPower(fixture, parent.workflowId, "run_control");
    await fixture.pgDatabase.query(
      `update bakery.tasks set parent_task_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, session.own.taskId, parent.taskId],
    );
    const response = await cancel(session, parent.runId);
    assertEquals(response.status, 403, await response.text());
    assertEquals(await runStatus(fixture, parent.runId) === "canceled", false);
    assertEquals(await noControlAudit(fixture), 0);
    // Control: with the parent link cut, the same cancel goes through.
    await fixture.pgDatabase.query(
      `update bakery.tasks set parent_task_id = null
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, session.own.taskId],
    );
    const allowed = await cancel(session, parent.runId);
    assertEquals(allowed.status, 200, await allowed.text());
    assertEquals(await runStatus(fixture, parent.runId), "canceled");
  }));

Deno.test("a run_control grant reaches only the workflows it names: the target's must be granted too", () =>
  withWorkerFixture(async (fixture) => {
    const session = await agentSession(fixture, { granted: "run_control" });
    const target = await seedOtherRun(fixture);
    const second = await ungrantedWorkflowVersion(fixture, session.own);
    await fixture.pgDatabase.query(
      `update bakery.workflow_runs set workflow_version_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, target.runId, second.versionId],
    );
    const refused = await cancel(session, target.runId);
    assertEquals(refused.status, 403, await refused.text());
    assertEquals(await runStatus(fixture, target.runId) === "canceled", false);
    // The control: once the target's workflow also grants it, the same control
    // goes through.
    await grantPower(fixture, second.workflowId, "run_control");
    const allowed = await cancel(session, target.runId);
    assertEquals(allowed.status, 200, await allowed.text());
    assertEquals(await runStatus(fixture, target.runId), "canceled");
  }));
