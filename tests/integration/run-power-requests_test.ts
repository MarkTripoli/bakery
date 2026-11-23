import { assertEquals, assertNotEquals } from "@std/assert";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";
import {
  addMember,
  api,
  seedArtifactVersion,
  seedOtherTask,
  seedQuestion,
  seedRun,
  seedStep,
  seedStepApproval,
} from "../helpers/run-requests.ts";

/**
 * #456 slice 2a: a request to approve or answer names the one approval or
 * question it asks about, gives the person asked the right to act on exactly
 * that row, and ends when it is done. Real routes and real Postgres.
 */

type Issue = { path: string[]; code: string };

async function open() {
  const fixture = await openSocketFixture();
  const approver = await addMember(fixture, "Approver", "developer");
  const guest = await addMember(fixture, "Grantee", "guest");
  const run = await seedRun(fixture);
  const approval = await seedStepApproval(
    fixture,
    run,
    approver.principalId,
  );
  const question = await seedQuestion(fixture, run, [approver.principalId]);
  const otherRun = await seedRun(fixture, await seedOtherTask(fixture));
  const foreign = await seedStepApproval(
    fixture,
    otherRun,
    approver.principalId,
  );
  const ask = (payload: Record<string, unknown>) =>
    api(fixture, fixture.cookie, "POST", `/v1/runs/${run.runId}/requests`, {
      recipientId: guest.principalId,
      ...payload,
    });
  const powers = async () =>
    (await fixture.pgDatabase.query<
      { power: string; target_id: string; live: boolean }
    >(
      `select power, question_id as target_id, (revoked_at is null) as live
         from bakery.run_power_grants
        where organization_id = $1 and run_id = $2 order by created_at`,
      [fixture.organizationId, run.runId],
    )).rows;
  return {
    fixture,
    approver,
    guest,
    run,
    approval,
    question,
    foreign,
    ask,
    powers,
    finish: async () => {
      await cleanupAuthFixture(fixture.pgDatabase, [
        fixture.email,
        approver.email,
        guest.email,
      ]);
      await fixture.close();
    },
  };
}

async function refusal(response: Response): Promise<string> {
  assertEquals(response.status, 422, await response.clone().text());
  const problem = await response.json() as { issues?: Issue[] };
  return problem.issues?.[0]?.code ?? "";
}

Deno.test("an approve or answer request must name a row that exists, is open and is the right kind", async () => {
  const o = await open();
  try {
    assertEquals(
      await refusal(await o.ask({ intent: "approve" })),
      "request_question_required",
    );
    assertEquals(
      await refusal(await o.ask({ intent: "answer" })),
      "request_question_required",
    );
    // A row of another run is not this run's to hand out.
    assertEquals(
      await refusal(await o.ask({ intent: "approve", questionId: o.foreign })),
      "request_question_not_found",
    );
    assertEquals(
      await refusal(
        await o.ask({ intent: "approve", questionId: crypto.randomUUID() }),
      ),
      "request_question_not_found",
    );
    // The kind has to match the intent.
    assertEquals(
      await refusal(await o.ask({ intent: "approve", questionId: o.question })),
      "request_question_wrong_kind",
    );
    assertEquals(
      await refusal(await o.ask({ intent: "answer", questionId: o.approval })),
      "request_question_wrong_kind",
    );
    // Only an approve or answer request names a row.
    assertEquals(
      await refusal(await o.ask({ intent: "fyi", questionId: o.approval })),
      "request_question_unexpected",
    );
    // A row that is no longer open cannot be handed out.
    await o.fixture.pgDatabase.query(
      `update bakery.questions set status = 'answered'
        where organization_id = $1 and id = $2`,
      [o.fixture.organizationId, o.question],
    );
    assertEquals(
      await refusal(await o.ask({ intent: "answer", questionId: o.question })),
      "request_question_closed",
    );
    // Powers still to come are still not promised.
    assertEquals(
      (await o.ask({ intent: "take_over" })).status,
      422,
    );
    // Nothing was granted by any refusal.
    assertEquals(await o.powers(), []);
  } finally {
    await o.finish();
  }
});

Deno.test("asking gives one expiring power on that row, and asking again only reminds", async () => {
  const o = await open();
  try {
    const first = await o.ask({ intent: "approve", questionId: o.approval });
    assertEquals(first.status, 201, await first.clone().text());
    const made = await first.json() as {
      id: string;
      questionId: string | null;
      expiresAt: string;
    };
    assertEquals(made.questionId, o.approval);
    assertEquals(await o.powers(), [{
      power: "approve",
      target_id: o.approval,
      live: true,
    }]);
    // The power lasts exactly as long as the request.
    const grant = await o.fixture.pgDatabase.query<{ expires_at: Date }>(
      `select expires_at from bakery.run_power_grants
        where organization_id = $1 and question_id = $2`,
      [o.fixture.organizationId, o.approval],
    );
    assertEquals(
      grant.rows[0].expires_at.toISOString(),
      new Date(made.expiresAt).toISOString(),
    );
    // Asking again is a reminder: the same request, no second power.
    const again = await o.ask({ intent: "approve", questionId: o.approval });
    assertEquals(again.status, 201);
    assertEquals((await again.json() as { id: string }).id, made.id);
    assertEquals((await o.powers()).length, 1);
    // A different row is a different request and a different power.
    const second = await o.ask({ intent: "answer", questionId: o.question });
    assertEquals(second.status, 201);
    assertNotEquals((await second.json() as { id: string }).id, made.id);
    assertEquals((await o.powers()).map((p) => p.power).sort(), [
      "answer",
      "approve",
    ]);
  } finally {
    await o.finish();
  }
});

Deno.test("when someone else decides the row, the asked person's request and power end too", async () => {
  const o = await open();
  try {
    assertEquals(
      (await o.ask({ intent: "approve", questionId: o.approval })).status,
      201,
    );
    assertEquals(
      (await o.ask({ intent: "answer", questionId: o.question })).status,
      201,
    );
    // The named approver, not the person asked, decides and answers.
    const decided = await api(
      o.fixture,
      o.approver.cookie,
      "POST",
      `/v1/approvals/${o.approval}/decision`,
      { decision: "approve", expectedVersion: 1 },
    );
    assertEquals(decided.status, 200, await decided.clone().text());
    const answered = await api(
      o.fixture,
      o.approver.cookie,
      "PUT",
      `/v1/questions/${o.question}/answer`,
      { answer: { text: "main" } },
    );
    assertEquals(answered.status, 200, await answered.clone().text());
    assertEquals((await o.powers()).map((p) => p.live), [false, false]);
    const requests = await o.fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.person_requests
        where organization_id = $1 and run_id = $2 and recipient_id = $3
        order by intent`,
      [o.fixture.organizationId, o.run.runId, o.guest.principalId],
    );
    assertEquals(requests.rows.map((r) => r.status), ["answered", "handled"]);
  } finally {
    await o.finish();
  }
});

Deno.test("a review or take-over request must name something of this run that can still be acted on", async () => {
  const o = await open();
  try {
    const mine = await seedArtifactVersion(
      o.fixture,
      o.run.taskId,
      o.run.runId,
    );
    const otherRun = await seedRun(o.fixture, await seedOtherTask(o.fixture));
    const theirs = await seedArtifactVersion(
      o.fixture,
      otherRun.taskId,
      otherRun.runId,
    );
    const runless = await seedArtifactVersion(o.fixture, o.run.taskId, null);
    assertEquals(
      await refusal(await o.ask({ intent: "review" })),
      "request_artifact_version_required",
    );
    for (const id of [theirs, runless, crypto.randomUUID()]) {
      assertEquals(
        await refusal(await o.ask({ intent: "review", artifactVersionId: id })),
        "request_artifact_version_not_found",
        id,
      );
    }
    assertEquals(
      await refusal(await o.ask({ intent: "fyi", artifactVersionId: mine })),
      "request_artifact_version_unexpected",
    );
    assertEquals(
      await refusal(await o.ask({ intent: "take_over" })),
      "request_step_required",
    );
    assertEquals(
      await refusal(await o.ask({ intent: "take_over", stepKey: "nope" })),
      "request_step_not_found",
    );
    await seedStep(o.fixture, o.run, "done");
    await o.fixture.pgDatabase.query(
      `update bakery.run_steps set status = 'completed'
        where organization_id = $1 and run_id = $2 and step_key = 'done'`,
      [o.fixture.organizationId, o.run.runId],
    );
    assertEquals(
      await refusal(await o.ask({ intent: "take_over", stepKey: "done" })),
      "request_step_finished",
    );
    // Nothing was granted by any refusal.
    assertEquals(await o.powers(), []);

    // What is asked for is what is granted, on the right typed column.
    const review = await o.ask({ intent: "review", artifactVersionId: mine });
    assertEquals(review.status, 201, await review.clone().text());
    const take = await o.ask({ intent: "take_over", stepKey: "build" });
    assertEquals(take.status, 201, await take.clone().text());
    const rows = await o.fixture.pgDatabase.query<{
      power: string;
      target_kind: string;
      question_id: string | null;
      artifact_version_id: string | null;
      run_step_id: string | null;
    }>(
      `select power, target_kind, question_id, artifact_version_id, run_step_id
         from bakery.run_power_grants
        where organization_id = $1 and run_id = $2 order by power`,
      [o.fixture.organizationId, o.run.runId],
    );
    assertEquals(
      rows.rows.map((r) => [
        r.power,
        r.target_kind,
        r.question_id,
        r.artifact_version_id === mine,
        r.run_step_id !== null,
      ]),
      [
        ["review", "artifact_version", null, true, false],
        ["take_over", "run_step", null, false, true],
      ],
    );
    // Asking again only reminds: no second power.
    assertEquals(
      (await o.ask({ intent: "review", artifactVersionId: mine })).status,
      201,
    );
    assertEquals((await o.powers()).length, 2);
  } finally {
    await o.finish();
  }
});
