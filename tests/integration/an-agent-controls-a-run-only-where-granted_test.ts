import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  type AgentFixture,
  agentSession,
  seedOtherRun,
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
    const target = await seedOtherRun(fixture);
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
