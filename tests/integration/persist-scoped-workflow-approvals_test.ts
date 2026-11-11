import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import {
  type ApprovalFixture,
  HUMAN_APPROVAL,
  openApprovalFixture,
  PLAN_EFFECT,
} from "../helpers/scoped-approvals.ts";
import {
  admitStagePolicy,
} from "../../apps/server/src/modules/work/stage-admission.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { expireDueQuestions } from "../../apps/server/src/modules/conversation/questions.ts";
import {
  presetBriefInputs,
} from "../../apps/server/src/modules/work/workflow-presets.ts";
import { renderImplementInstructions } from "../../packages/contracts/src/workflow-presets.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";

async function withFixture(
  work: (f: ApprovalFixture) => Promise<void>,
): Promise<void> {
  const fixture = await openApprovalFixture();
  try {
    await work(fixture);
  } finally {
    await fixture.close();
  }
}

const reasonOf = async (work: () => Promise<unknown>) => {
  try {
    await work();
  } catch (error) {
    if (error instanceof StandardError) {
      return `${error.code}:${error.params?.reason}`;
    }
    throw error;
  }
  return "no error";
};

Deno.test("a plan effect creates an immutable digest-bound revision and a bound approval", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    await f.askAgent(task, [PLAN_EFFECT("First")]);
    const [revision] = await f.revisionsFor(task.taskId);
    assertEquals(revision.revision, 1);
    assertEquals(
      revision.digest,
      await sha256Hex(canonicalJson({
        taskId: task.taskId,
        revision: 1,
        body: revision.body,
      })),
    );
    const [approval] = await f.approvalsFor(task.taskId);
    assertEquals(approval.status, "open");
    assertEquals(approval.subjectType, "plan_revision");
    assertEquals(approval.subjectId, revision.id);
    assertEquals(approval.subjectDigest, revision.digest);
    assertEquals(approval.scope.stage, "plan");
    assertEquals(
      approval.policyDigest,
      await sha256Hex(canonicalJson(HUMAN_APPROVAL)),
    );
    assert(approval.expiresAt !== null);
    // Revision rows are immutable for the application role.
    const update = await f.fx.appPg.query(
      `update bakery.plan_revisions set body = '{}'::jsonb where id = $1`,
      [revision.id],
    ).then(() => "updated", () => "denied");
    assertEquals(update, "denied");
  }));

Deno.test("an automatic policy proposes revisions without an approval request", () =>
  withFixture(async (f) => {
    const task = await f.newTask();
    await f.askAgent(task, [PLAN_EFFECT("Auto")]);
    assertEquals((await f.revisionsFor(task.taskId)).length, 1);
    assertEquals((await f.approvalsFor(task.taskId)).length, 0);
  }));

Deno.test("double decide: first wins, identical replay acknowledges, conflicting or stale fails", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    await f.askAgent(task, [PLAN_EFFECT("Race")]);
    const [approval] = await f.approvalsFor(task.taskId);
    const [a, b] = await Promise.all([
      f.decide(approval, "approve", { identity: await f.as(f.fx.developer) }),
      f.decide(approval, "reject", { identity: await f.as(f.fx.admin) }),
    ]);
    assertEquals([a.status, b.status].sort(), [200, 409]);
    const stored = await f.getApproval(approval.id);
    assertEquals(stored.status, "answered");
    const winner = a.status === 200 ? "approve" : "reject";
    assertEquals(stored.decision, winner);
    const replay = await f.decide(approval, winner as "approve", {
      expectedVersion: approval.version,
    });
    assertEquals(replay.status, 200);
    assertEquals((await f.getApproval(approval.id)).version, stored.version);
    const other = await f.decide(
      approval,
      winner === "approve" ? "reject" : "approve",
    );
    assertEquals(other.status, 409);
    const [revision] = await f.revisionsFor(task.taskId);
    assertEquals(
      revision.status,
      winner === "approve" ? "approved" : "rejected",
    );
  }));

Deno.test("stale expected version and missing comment are refused with no effect", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    await f.askAgent(task, [PLAN_EFFECT("Stale")]);
    const [approval] = await f.approvalsFor(task.taskId);
    assertEquals(
      (await f.decide(approval, "approve", { expectedVersion: 99 })).status,
      409,
    );
    assertEquals(
      (await f.decide(approval, "request_changes")).status,
      422,
    );
    assertEquals((await f.getApproval(approval.id)).status, "open");
  }));

Deno.test("request changes yields revision N+1; approving N is refused; N+1 admits exactly once", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    await f.askAgent(task, [PLAN_EFFECT("v1")]);
    const [first] = await f.approvalsFor(task.taskId);
    const changed = await f.decide(first, "request_changes", {
      comment: "Add a rollback step",
    });
    assertEquals(changed.status, 200);
    const requests = await f.fx.owner`
      select body from bakery.messages
       where conversation_id = ${task.conversationId} and intent = 'agent_request'
         and message_type = 'system'`;
    assertEquals(requests.length, 1);
    assert(String(requests[0].body).includes("Add a rollback step"));
    await f.askAgent(task, [PLAN_EFFECT("v2")], "revise");
    const revisions = await f.revisionsFor(task.taskId);
    assertEquals(revisions.map((r) => [r.revision, r.status]), [
      [1, "superseded"],
      [2, "proposed"],
    ]);
    assertEquals(revisions[1].supersedesRevision, 1);
    // The old request cannot be approved any more.
    assertEquals((await f.decide(first, "approve")).status, 409);
    const approvals = await f.approvalsFor(task.taskId);
    assertEquals(approvals.length, 2);
    const second = approvals[1];
    assertEquals(second.subjectId, revisions[1].id);
    const approved = await (await f.decide(second, "approve")).json();
    assertEquals(approved.status, "answered");
    // Revision 1's approval never admits a run.
    assertEquals(
      (await f.startRun(task.taskId, { approvalId: first.id })).status,
      409,
    );
    assertEquals(await f.runCount(task.taskId), 0);
    const started = await f.startRun(task.taskId, { approvalId: second.id });
    assertEquals(started.status, 201, await started.clone().text());
    const consumed = await f.getApproval(second.id);
    assertEquals(consumed.status, "consumed");
    assertEquals(consumed.consumedByRunId, (await started.json()).id);
  }));

Deno.test("two concurrent runs.create with one approvalId admit exactly one run", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    const approval = await f.approvedPlan(task);
    const [a, b] = await Promise.all([
      f.startRun(task.taskId, { approvalId: approval.id }),
      f.startRun(task.taskId, { approvalId: approval.id }),
    ]);
    assertEquals([a.status, b.status].sort(), [201, 409]);
    assertEquals(await f.runCount(task.taskId), 1);
    assertEquals((await f.getApproval(approval.id)).status, "consumed");
  }));

Deno.test("consumption failures name approval_unavailable and approval_required", () =>
  withFixture(async (f) => {
    const gated = await f.newTask({ policy: HUMAN_APPROVAL });
    const approval = await f.approvedPlan(gated);
    const row = await f.fx.owner`
      select id, approval_policy, planning_only from bakery.tasks
       where organization_id = ${f.fx.organizationId} and id = ${gated.taskId}`;
    const facts = (approvalId: string | undefined) => ({
      organizationId: f.fx.organizationId,
      principalId: f.fx.developer.principalId,
      task: {
        id: gated.taskId,
        approval_policy: row[0].approval_policy,
        planning_only: false,
      },
      approvalId,
      runId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
    });
    const admit = (approvalId: string | undefined) =>
      reasonOf(() =>
        withPgTransaction(
          f.fx.appPg,
          (transaction) => admitStagePolicy(transaction, facts(approvalId)),
        )
      );
    assertEquals(await admit(undefined), "STATE_CONFLICT:approval_required");
    assertEquals(
      await admit(crypto.randomUUID()),
      "STATE_CONFLICT:approval_unavailable",
    );
    // Nothing was consumed by the failed attempts, and the HTTP path agrees.
    assertEquals((await f.getApproval(approval.id)).status, "answered");
    // The 409 body names the rule, so a client can tell the two apart.
    const withoutApproval = await f.startRun(gated.taskId);
    assertEquals(withoutApproval.status, 409);
    const missing = await withoutApproval.json();
    assertEquals([missing.code, missing.reason], [
      "STATE_CONFLICT",
      "approval_required",
    ]);
    const unknownApproval = await f.startRun(gated.taskId, {
      approvalId: crypto.randomUUID(),
    });
    assertEquals(unknownApproval.status, 409);
    const unavailable = await unknownApproval.json();
    assertEquals([unavailable.code, unavailable.reason], [
      "STATE_CONFLICT",
      "approval_unavailable",
    ]);
    assertEquals(await f.runCount(gated.taskId), 0);
  }));

Deno.test("legacy and automatic tasks start without approval; planning-only tasks start nothing", () =>
  withFixture(async (f) => {
    const legacy = await f.newTask();
    assertEquals((await f.startRun(legacy.taskId)).status, 201);
    const automatic = await f.newTask({ policy: { plan: "automatic" } });
    assertEquals((await f.startRun(automatic.taskId)).status, 201);
    const planning = await f.newTask({ planningOnly: true });
    assertEquals((await f.startRun(planning.taskId)).status, 409);
    assertEquals(await f.runCount(planning.taskId), 0);
    const cleared = await f.call(
      await f.as(f.fx.developer),
      "PATCH",
      `/v1/tasks/${planning.taskId}`,
      { body: { planningOnly: false }, ifMatch: 1 },
    );
    assertEquals(cleared.status, 200, await cleared.clone().text());
    assertEquals((await f.startRun(planning.taskId)).status, 201);
  }));

Deno.test("tasks.create stores an explicit policy, defaults to none and rejects unknown ones", () =>
  withFixture(async (f) => {
    const identity = await f.as(f.fx.developer);
    const create = (extra: Record<string, unknown>) =>
      f.call(identity, "POST", "/v1/tasks", {
        body: {
          applicationId: f.fx.applicationId,
          taskType: "feature",
          title: "Policy task",
          ...extra,
        },
      });
    const gated = await create({ approvalPolicy: HUMAN_APPROVAL });
    assertEquals(gated.status, 201, await gated.clone().text());
    assertEquals((await gated.json()).approvalPolicy, HUMAN_APPROVAL);
    const plain = await (await create({})).json();
    assertEquals(plain.approvalPolicy, null);
    assertEquals(plain.planningOnly, false);
    assertEquals(
      (await create({ approvalPolicy: { plan: "never" } })).status,
      422,
    );
    assertEquals(
      (await create({ approvalPolicy: { plan: "human_approval", extra: 1 } }))
        .status,
      422,
    );
  }));

Deno.test("an approval for task A with an identical plan cannot admit task B", () =>
  withFixture(async (f) => {
    const a = await f.newTask({ policy: HUMAN_APPROVAL, title: "A" });
    const b = await f.newTask({ policy: HUMAN_APPROVAL, title: "B" });
    const approvalA = await f.approvedPlan(a, "Identical");
    const approvalB = await f.approvedPlan(b, "Identical");
    const [revA] = await f.revisionsFor(a.taskId);
    const [revB] = await f.revisionsFor(b.taskId);
    assertEquals(JSON.stringify(revA.body), JSON.stringify(revB.body));
    assertNotEquals(revA.digest, revB.digest);
    assertEquals(
      (await f.startRun(b.taskId, { approvalId: approvalA.id })).status,
      409,
    );
    assertEquals(await f.runCount(b.taskId), 0);
    assertEquals((await f.getApproval(approvalA.id)).status, "answered");
    assertEquals(
      (await f.startRun(b.taskId, { approvalId: approvalB.id })).status,
      201,
    );
    assertEquals(
      (await f.startRun(a.taskId, { approvalId: approvalA.id })).status,
      201,
    );
  }));

Deno.test("expired or revoked approvals keep the stage paused while discussion continues", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    const approval = await f.approvedPlan(task);
    await f.fx.owner`
      update bakery.questions set expires_at = now() - interval '1 minute'
       where id = ${approval.id}`;
    assertEquals((await f.getApproval(approval.id)).status, "expired");
    assertEquals(
      (await f.startRun(task.taskId, { approvalId: approval.id })).status,
      409,
    );
    assertEquals(await f.runCount(task.taskId), 0);
    const message = await f.call(
      await f.as(f.fx.admin),
      "POST",
      `/v1/conversations/${task.conversationId}/messages`,
      {
        body: {
          body: "still talking",
          clientMessageId: crypto.randomUUID(),
          intent: "discussion",
        },
      },
    );
    assertEquals(message.status, 201);

    const second = await f.newTask({
      policy: HUMAN_APPROVAL,
      title: "revoked",
    });
    const approved = await f.approvedPlan(second);
    assertEquals((await f.revoke(approved)).status, 200);
    assertEquals((await f.getApproval(approved.id)).status, "revoked");
    assertEquals(
      (await f.startRun(second.taskId, { approvalId: approved.id })).status,
      409,
    );
    assertEquals(await f.runCount(second.taskId), 0);
  }));

Deno.test("revoke after consumption is approval_consumed and the run keeps its identity", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    const approval = await f.approvedPlan(task);
    const started = await f.startRun(task.taskId, { approvalId: approval.id });
    assertEquals(started.status, 201);
    const run = await started.json();
    const before = await f.fx.owner`
      select status, workflow_version_id, snapshot from bakery.workflow_runs where id = ${run.id}`;
    const revoked = await f.revoke(approval);
    assertEquals(revoked.status, 409);
    const after = await f.fx.owner`
      select status, workflow_version_id, snapshot from bakery.workflow_runs where id = ${run.id}`;
    assertEquals(JSON.stringify(after), JSON.stringify(before));
    assertEquals((await f.getApproval(approval.id)).status, "consumed");
    // Revoking an unconsumed approval twice is idempotent.
    const other = await f.approvedPlan(
      await f.newTask({ policy: HUMAN_APPROVAL }),
    );
    assertEquals((await f.revoke(other)).status, 200);
    assertEquals((await f.revoke(other)).status, 200);
  }));

Deno.test("approval does not override failed checks and is not consumed by them", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    const approval = await f.approvedPlan(task);
    const failed = await f.startRun(task.taskId, {
      approvalId: approval.id,
      repositoryProfileId: crypto.randomUUID(),
    });
    assert(failed.status >= 400 && failed.status < 500, String(failed.status));
    assertEquals(await f.runCount(task.taskId), 0);
    assertEquals((await f.getApproval(approval.id)).status, "answered");
    assertEquals(
      (await f.startRun(task.taskId, { approvalId: approval.id })).status,
      201,
    );
  }));

Deno.test("merge and deploy subjects are unsupported and a reject keeps the stage paused", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    await f.askAgent(task, [PLAN_EFFECT("Reject me")]);
    const [approval] = await f.approvalsFor(task.taskId);
    await f.fx.owner`
      update bakery.questions set subject_type = 'merge' where id = ${approval.id}`;
    assertEquals((await f.decide(approval, "approve")).status, 409);
    assertEquals((await f.getApproval(approval.id)).status, "open");
    await f.fx.owner`
      update bakery.questions set subject_type = 'plan_revision' where id = ${approval.id}`;
    assertEquals((await f.decide(approval, "reject")).status, 200);
    assertEquals(
      (await f.startRun(task.taskId, { approvalId: approval.id })).status,
      409,
    );
    assertEquals(await f.runCount(task.taskId), 0);
  }));

Deno.test("a plan effect on a taskless conversation or non-plan flow leaves questions unaffected", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    await f.askAgent(task, [{
      type: "question",
      prompt: "Which branch?",
      options: [{ id: "a", label: "A" }],
    }]);
    const questions = await f.call(
      await f.as(f.fx.developer),
      "GET",
      `/v1/questions?taskId=${task.taskId}`,
    );
    assertEquals((await questions.json()).items.length, 1);
    await f.askAgent(task, [PLAN_EFFECT("With approval")]);
    // Approvals never appear as plain questions.
    const after = await f.call(
      await f.as(f.fx.developer),
      "GET",
      `/v1/questions?taskId=${task.taskId}`,
    );
    assertEquals((await after.json()).items.length, 1);
  }));

const countOf = async (
  f: ApprovalFixture,
  table: "messages" | "conversation_turns",
  conversationId: string,
) =>
  Number(
    (await f.fx.owner`
    select count(*)::int as n from ${f.fx.owner("bakery." + table)}
     where conversation_id = ${conversationId}`)[0].n,
  );

Deno.test("request_changes on an archived conversation is refused with no message, turn or decision", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    await f.askAgent(task, [PLAN_EFFECT("Archived")]);
    const [approval] = await f.approvalsFor(task.taskId);
    await f.fx.owner`
      update bakery.conversations set archived_at = now()
       where id = ${task.conversationId}`;
    const messages = await countOf(f, "messages", task.conversationId);
    const turns = await countOf(f, "conversation_turns", task.conversationId);
    const response = await f.decide(approval, "request_changes", {
      comment: "Add a rollback step",
    });
    assertEquals(response.status, 409);
    assertEquals(await countOf(f, "messages", task.conversationId), messages);
    assertEquals(
      await countOf(f, "conversation_turns", task.conversationId),
      turns,
    );
    const stored = await f.getApproval(approval.id);
    assertEquals(stored.status, "open");
    assertEquals(stored.version, approval.version);
  }));

Deno.test("answering a question resumes the turn while a sibling approval from the same turn is open", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    await f.askAgent(task, [
      {
        type: "question",
        prompt: "Which database?",
        options: [{ id: "pg", label: "Postgres" }, {
          id: "my",
          label: "MySQL",
        }],
      },
      PLAN_EFFECT("With question"),
    ]);
    const [approval] = await f.approvalsFor(task.taskId);
    assertEquals(approval.status, "open");
    const questions = await f.fx.owner<{ id: string }[]>`
      select id from bakery.questions
       where conversation_id = ${task.conversationId} and kind = 'question'`;
    assertEquals(questions.length, 1);
    const before = await countOf(f, "conversation_turns", task.conversationId);
    const answered = await f.call(
      await f.as(f.fx.developer),
      "PUT",
      `/v1/questions/${questions[0].id}/answer`,
      { body: { answer: { optionId: "pg" } } },
    );
    assertEquals(answered.status, 200, await answered.clone().text());
    assertEquals(
      await countOf(f, "conversation_turns", task.conversationId),
      before + 1,
    );
    const note = await f.fx.owner<{ body: string }[]>`
      select body from bakery.messages
       where conversation_id = ${task.conversationId}
         and message_type = 'system' and body like '%Which database?%'`;
    assertEquals(note.length, 1);
    assertEquals((await f.getApproval(approval.id)).status, "open");
  }));

Deno.test("the expiry sweep labels expired approvals as approvals and queues nothing in archived scopes", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    await f.askAgent(task, [PLAN_EFFECT("Sweep")]);
    const [approval] = await f.approvalsFor(task.taskId);
    await f.fx.owner`
      update bakery.questions set expires_at = now() - interval '1 second'
       where id = ${approval.id}`;
    await f.fx.owner`
      update bakery.conversations set archived_at = now()
       where id = ${task.conversationId}`;
    const turns = await countOf(f, "conversation_turns", task.conversationId);
    assertEquals(await expireDueQuestions(f.fx.appPg), 1);
    assertEquals(
      await countOf(f, "conversation_turns", task.conversationId),
      turns,
    );
    const events = await f.fx.owner<{ event_type: string }[]>`
      select event_type from bakery.domain_events
       where aggregate_id = ${approval.id} and event_type like '%.expired'`;
    assertEquals(events.map((e) => e.event_type), ["approval.expired"]);
    const audits = await f.fx.owner<{ operation: string }[]>`
      select operation from bakery.audit_events
       where resource_id = ${approval.id} and operation like '%.expire'`;
    assertEquals(audits.map((a) => a.operation), ["approvals.expire"]);
  }));

Deno.test("consuming an approval returns the exact approved revision, which reaches the brief and instructions", () =>
  withFixture(async (f) => {
    const task = await f.newTask({ policy: HUMAN_APPROVAL });
    const approval = await f.approvedPlan(task, "Ship it");
    const [revision] = await f.revisionsFor(task.taskId);
    const row = await f.fx.owner`
      select approval_policy from bakery.tasks
       where organization_id = ${f.fx.organizationId} and id = ${task.taskId}`;
    // The consume rolls back: the run row it names does not exist here.
    const holder: { plan: Awaited<ReturnType<typeof admitStagePolicy>> } = {
      plan: null,
    };
    const rollback = new Error("rollback");
    await withPgTransaction(f.fx.appPg, async (transaction) => {
      holder.plan = await admitStagePolicy(transaction, {
        organizationId: f.fx.organizationId,
        principalId: f.fx.developer.principalId,
        task: {
          id: task.taskId,
          approval_policy: row[0].approval_policy,
          planning_only: false,
        },
        approvalId: approval.id,
        runId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
      });
      throw rollback;
    }).catch((error) => {
      if (error !== rollback) throw error;
    });
    const consumed = holder.plan;
    assert(consumed !== null);
    assertEquals(consumed.planRevisionId, revision.id);
    assertEquals(consumed.revision, revision.revision);
    assertEquals(consumed.digest, revision.digest);
    assertEquals(consumed.title, revision.body.title);
    assertEquals(consumed.steps, revision.body.steps as typeof consumed.steps);
    const taskRow = { title: "T", description: "D", task_type: "feature" };
    const inputs = presetBriefInputs(taskRow, consumed);
    assertEquals(inputs.brief.approvedPlan, consumed);
    assertEquals(
      inputs.instructions,
      renderImplementInstructions({
        title: "T",
        description: "D",
        approvedPlan: consumed,
      }),
    );
    assert(inputs.instructions.includes(revision.body.title));
    // A real run consumes the approval; a second consume finds nothing.
    assertEquals(
      (await f.startRun(task.taskId, { approvalId: approval.id })).status,
      201,
    );
    assertEquals(
      await reasonOf(() =>
        withPgTransaction(
          f.fx.appPg,
          (transaction) =>
            admitStagePolicy(transaction, {
              organizationId: f.fx.organizationId,
              principalId: f.fx.developer.principalId,
              task: {
                id: task.taskId,
                approval_policy: row[0].approval_policy,
                planning_only: false,
              },
              approvalId: approval.id,
              runId: crypto.randomUUID(),
              requestId: crypto.randomUUID(),
              traceId: crypto.randomUUID(),
            }),
        )
      ),
      "STATE_CONFLICT:approval_unavailable",
    );
  }));
