import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  type AgentFixture,
  agentSession,
  seedOtherRun,
} from "../helpers/agent-session.ts";
import { requestHumanApproval } from "../../apps/server/src/modules/work/human-approval-store.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";

// #414 slice 1: an agent decides an approval only where a person granted the
// power to its workflow, never on its own run's output, and the decision is
// labelled as an agent's action. Driven through the real app and the session
// gateway, because each rule can hold below it and still be missing from the
// path an agent actually takes.

type Fixture = AgentFixture;

/** An open step approval in the given run, addressed to the person. */
async function approvalIn(
  fixture: Fixture,
  run: {
    runId: string;
    taskId: string;
    conversationId: string;
    applicationId: string;
  },
): Promise<string> {
  const asked = await requestHumanApproval(
    fixture.pgDatabase as unknown as PgTransactionClient,
    {
      organizationId: fixture.organizationId,
      runId: run.runId,
      taskId: run.taskId,
      conversationId: run.conversationId,
      stepKey: "human.approval",
      prompt: "Ship it?",
      ownerPrincipalId: fixture.principalId,
      traceId: crypto.randomUUID(),
      applicationId: run.applicationId,
      repositoryId: null,
    },
  );
  return asked.approvalId;
}

/** The agent's decision tool, over the shared session helper. */
async function sessionFor(fixture: Fixture, options: { granted: boolean }) {
  const session = await agentSession(fixture, {
    granted: options.granted ? "decide" : null,
  });
  const decide = (id: string) =>
    session.call("approvals.decide", {
      id,
      decision: "approve",
      expectedVersion: 1,
    });
  return { ...session, decide };
}

const otherRun = () => seedOtherRun;

Deno.test("an agent decides another run's approval where its workflow is granted", () =>
  withWorkerFixture(async (fixture) => {
    const { decide, tools } = await sessionFor(fixture, { granted: true });
    assert((await tools()).includes("approvals.decide"));
    const approvalId = await approvalIn(fixture, await otherRun()(fixture));
    const response = await decide(approvalId);
    assertEquals(response.status, 200, await response.text());

    const ledger = await fixture.pgDatabase.query<{
      kind: string;
      decided_by: string;
      detail: { actorKind?: string; onBehalfOf?: string };
    }>(
      `select kind, decided_by, detail from bakery.decisions_ledger
        where organization_id = $1 and subject_id = $2`,
      [fixture.organizationId, approvalId],
    );
    assertEquals(ledger.rows.length, 1);
    // Attributed to the person, labelled as the agent's action (O50).
    assertEquals(ledger.rows[0].decided_by, fixture.principalId);
    assertEquals(ledger.rows[0].detail.actorKind, "agent");
    assertEquals(ledger.rows[0].detail.onBehalfOf, fixture.principalId);
  }));

Deno.test("without a grant the decision is not offered and not allowed", () =>
  withWorkerFixture(async (fixture) => {
    const { decide, tools } = await sessionFor(fixture, { granted: false });
    assert(!(await tools()).includes("approvals.decide"));
    const approvalId = await approvalIn(fixture, await otherRun()(fixture));
    const response = await decide(approvalId);
    assertEquals(response.status, 403, await response.text());
  }));

Deno.test("a revoked grant stops the next call", () =>
  withWorkerFixture(async (fixture) => {
    const { grantId, decide } = await sessionFor(fixture, { granted: true });
    const approvalId = await approvalIn(fixture, await otherRun()(fixture));
    await fixture.pgDatabase.query(
      `delete from bakery.agent_power_grants where id = $1`,
      [grantId],
    );
    // The scope was minted at claim, but the action rechecks the grant live.
    const response = await decide(approvalId);
    assertEquals(response.status, 403, await response.text());
  }));

Deno.test("an agent never decides the approval of its own run", () =>
  withWorkerFixture(async (fixture) => {
    const { own, decide } = await sessionFor(fixture, { granted: true });
    const approvalId = await approvalIn(fixture, own);
    const response = await decide(approvalId);
    assertEquals(response.status, 403, await response.text());
    // Refused before anything is written: the approval is still open and the
    // ledger holds no decision for it.
    const state = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.questions
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, approvalId],
    );
    assertEquals(state.rows[0].status, "open");
    const ledger = await fixture.pgDatabase.query(
      `select 1 from bakery.decisions_ledger
        where organization_id = $1 and subject_id = $2`,
      [fixture.organizationId, approvalId],
    );
    assertEquals(ledger.rows.length, 0);
  }));

Deno.test("an agent cannot decide a stage or plan approval, only a step's", () =>
  withWorkerFixture(async (fixture) => {
    const { decide, own } = await sessionFor(fixture, { granted: true });
    const other = await otherRun()(fixture);
    // An approval whose subject is a run stage, not a run step: the one path
    // that records who decided is the step path, so an agent is refused here.
    const approvalId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.questions
         (id, organization_id, kind, conversation_id, task_id, run_id,
          generation, prompt, allow_free_text, audience, expires_at, status,
          subject_type, subject_id, subject_digest, policy_digest)
       values ($1, $2, 'approval', $3, $4, $5, 1, 'Ship the stage?', true,
               $6::jsonb, now() + interval '1 day', 'open', 'run_stage', $5,
               'digest', 'policy')`,
      [
        approvalId,
        fixture.organizationId,
        other.conversationId,
        other.taskId,
        other.runId,
        JSON.stringify({
          type: "principals",
          principalIds: [fixture.principalId],
        }),
      ],
    );
    void own;
    const response = await decide(approvalId);
    const refusal = JSON.parse(await response.text()) as { reason?: string };
    assertEquals(response.status, 409);
    // The named reason is what proves the step-only rule refused it: a stage
    // approval is refused with a 409 for other reasons too once that rule is
    // gone, so the status alone would pass without the rule.
    assertEquals(refusal.reason, "agent_decision_unsupported");
    // Nothing written: still open, no ledger entry.
    const state = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.questions
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, approvalId],
    );
    assertEquals(state.rows[0].status, "open");
    const ledger = await fixture.pgDatabase.query(
      `select 1 from bakery.decisions_ledger
        where organization_id = $1 and subject_id = $2`,
      [fixture.organizationId, approvalId],
    );
    assertEquals(ledger.rows.length, 0);
  }));

Deno.test("a grant naming no workflow and no seat covers nobody", () =>
  withWorkerFixture(async (fixture) => {
    // The scope is minted from a workflow grant at claim; it is then replaced by
    // a grant with neither a workflow nor a seat, which the guard must not honor
    // (the writer refuses to create one, so only a direct row can).
    const { decide, grantId } = await sessionFor(fixture, { granted: true });
    const other = await otherRun()(fixture);
    const approvalId = await approvalIn(fixture, other);
    await fixture.pgDatabase.query(
      `delete from bakery.agent_power_grants where id = $1`,
      [grantId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.agent_power_grants
         (organization_id, power, granted_by)
       values ($1, 'decide', $2)`,
      [fixture.organizationId, fixture.principalId],
    );
    const response = await decide(approvalId);
    assertEquals(response.status, 403, await response.text());
  }));
