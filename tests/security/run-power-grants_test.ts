import { assertEquals, assertNotEquals } from "@std/assert";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";
import {
  addMember,
  api,
  seedOtherTask,
  seedQuestion,
  seedRun,
  seedStepApproval,
} from "../helpers/run-requests.ts";

/**
 * #456 slice 2a, security: a person asked to approve is given the right to
 * decide exactly one approval, and a person asked to answer exactly one
 * question; nothing else. The grantee here is a bare Guest, who holds no
 * permission of their own, so every refusal below is the gate or the audience
 * check closing and every success is the grant. Real rows are used throughout,
 * so a gate that wrongly opened would answer 200 or a handler error rather
 * than the same 404 a missing id gives.
 */

async function open() {
  const fixture = await openSocketFixture();
  const approver = await addMember(fixture, "Approver", "developer");
  const guest = await addMember(fixture, "Grantee", "guest");
  const stranger = await addMember(fixture, "Stranger", "guest");
  const run = await seedRun(fixture);
  // Two approvals and a question on the SAME run, and an approval on ANOTHER
  // run: each private to the approver, so the guest is in none of them.
  const approval = await seedStepApproval(
    fixture,
    run,
    approver.principalId,
    "human.approval",
  );
  const sibling = await seedStepApproval(
    fixture,
    run,
    approver.principalId,
    "human.second",
  );
  const question = await seedQuestion(fixture, run, [approver.principalId]);
  const otherRun = await seedRun(fixture, await seedOtherTask(fixture));
  const foreign = await seedStepApproval(
    fixture,
    otherRun,
    approver.principalId,
    "human.approval",
  );
  const ask = (intent: string, questionId: string) =>
    api(fixture, approver.cookie, "POST", `/v1/runs/${run.runId}/requests`, {
      recipientId: guest.principalId,
      intent,
      questionId,
    });
  return {
    fixture,
    approver,
    guest,
    stranger,
    run,
    approval,
    sibling,
    question,
    foreign,
    ask,
    get: (cookie: string, path: string) => api(fixture, cookie, "GET", path),
    decide: (cookie: string, id: string, decision = "approve") =>
      api(fixture, cookie, "POST", `/v1/approvals/${id}/decision`, {
        decision,
        expectedVersion: 1,
      }),
    finish: async () => {
      await cleanupAuthFixture(fixture.pgDatabase, [
        fixture.email,
        approver.email,
        guest.email,
        stranger.email,
      ]);
      await fixture.close();
    },
  };
}

Deno.test("before a request the guest cannot read or decide the approval", async () => {
  const o = await open();
  try {
    assertEquals(
      (await o.get(o.guest.cookie, `/v1/approvals/${o.approval}`)).status,
      404,
    );
    assertEquals((await o.decide(o.guest.cookie, o.approval)).status, 404);
  } finally {
    await o.finish();
  }
});

Deno.test("an approve power reaches exactly its one approval", async () => {
  const o = await open();
  try {
    const made = await o.ask("approve", o.approval);
    assertEquals(made.status, 201, await made.text());
    // It reads and decides that one approval...
    assertEquals(
      (await o.get(o.guest.cookie, `/v1/approvals/${o.approval}`)).status,
      200,
    );
    // ...and no other: not a sibling on the same run, not one on another run,
    // not a question on this run.
    for (const id of [o.sibling, o.foreign]) {
      assertEquals(
        (await o.get(o.guest.cookie, `/v1/approvals/${id}`)).status,
        404,
        id,
      );
      assertEquals((await o.decide(o.guest.cookie, id)).status, 404, id);
    }
    assertEquals(
      (await o.get(o.guest.cookie, `/v1/questions/${o.question}`)).status,
      404,
    );
    // Nobody else gains anything from it.
    assertEquals(
      (await o.get(o.stranger.cookie, `/v1/approvals/${o.approval}`)).status,
      404,
    );
    assertEquals((await o.decide(o.stranger.cookie, o.approval)).status, 404);
  } finally {
    await o.finish();
  }
});

Deno.test("an approve power is not an answer power, and cannot undo an approval", async () => {
  const o = await open();
  try {
    assertEquals((await o.ask("approve", o.approval)).status, 201);
    assertEquals(
      (await api(
        o.fixture,
        o.guest.cookie,
        "PUT",
        `/v1/questions/${o.question}/answer`,
        { answer: { text: "main" } },
      )).status,
      404,
    );
    // Decide it, then try to revoke it: revoke is not a power.
    assertEquals((await o.decide(o.guest.cookie, o.approval)).status, 200);
    const revoke = await api(
      o.fixture,
      o.guest.cookie,
      "POST",
      `/v1/approvals/${o.approval}/revoke`,
      {},
    );
    assertNotEquals(revoke.status, 200);
    assertEquals(
      [403, 404].includes(revoke.status),
      true,
      String(revoke.status),
    );
  } finally {
    await o.finish();
  }
});

Deno.test("a decision spends the power: the same approval cannot be decided again", async () => {
  const o = await open();
  try {
    assertEquals((await o.ask("approve", o.approval)).status, 201);
    assertEquals((await o.decide(o.guest.cookie, o.approval)).status, 200);
    const again = await o.decide(o.guest.cookie, o.approval, "reject");
    assertNotEquals(again.status, 200);
    // The request that asked for it is done, and says so.
    const mine = await (await api(
      o.fixture,
      o.guest.cookie,
      "GET",
      `/v1/runs/${o.run.runId}/requests/mine`,
    )).json() as { requests: { status: string; questionId: string | null }[] };
    assertEquals(mine.requests.map((r) => [r.status, r.questionId]), [[
      "handled",
      o.approval,
    ]]);
  } finally {
    await o.finish();
  }
});

Deno.test("an expired power is no power, and so is a withdrawn one", async () => {
  const o = await open();
  try {
    const made = await o.ask("approve", o.approval);
    assertEquals(made.status, 201);
    const request = await made.json() as { id: string; version: number };
    // Expiry: the lookup carries the clock, not only the revoked flag.
    await o.fixture.pgDatabase.query(
      `update bakery.run_power_grants set expires_at = now() - interval '1 minute'
        where organization_id = $1 and question_id = $2`,
      [o.fixture.organizationId, o.approval],
    );
    assertEquals(
      (await o.get(o.guest.cookie, `/v1/approvals/${o.approval}`)).status,
      404,
    );
    assertEquals((await o.decide(o.guest.cookie, o.approval)).status, 404);
    // Withdrawal: asking again after the power is gone makes a fresh one, and
    // withdrawing that takes it away at once.
    await o.fixture.pgDatabase.query(
      `update bakery.run_power_grants set expires_at = now() + interval '1 day'
        where organization_id = $1 and question_id = $2`,
      [o.fixture.organizationId, o.approval],
    );
    assertEquals(
      (await o.get(o.guest.cookie, `/v1/approvals/${o.approval}`)).status,
      200,
    );
    const withdrawn = await api(
      o.fixture,
      o.fixture.cookie,
      "POST",
      `/v1/run-requests/${request.id}/withdraw`,
      {},
      request.version,
    );
    assertEquals(withdrawn.status, 200, await withdrawn.text());
    assertEquals(
      (await o.get(o.guest.cookie, `/v1/approvals/${o.approval}`)).status,
      404,
    );
  } finally {
    await o.finish();
  }
});

Deno.test("an answer power reaches exactly its one question", async () => {
  const o = await open();
  try {
    const other = await seedQuestion(o.fixture, o.run, [
      o.approver.principalId,
    ]);
    assertEquals((await o.ask("answer", o.question)).status, 201);
    assertEquals(
      (await o.get(o.guest.cookie, `/v1/questions/${o.question}`)).status,
      200,
    );
    assertEquals(
      (await o.get(o.guest.cookie, `/v1/questions/${other}`)).status,
      404,
    );
    // It is not an approve power either.
    assertEquals(
      (await o.get(o.guest.cookie, `/v1/approvals/${o.approval}`)).status,
      404,
    );
    // It answers its own question and no other, and that ends the request.
    const answer = (id: string) =>
      api(o.fixture, o.guest.cookie, "PUT", `/v1/questions/${id}/answer`, {
        answer: { text: "main" },
      });
    assertEquals((await answer(other)).status, 404);
    const answered = await answer(o.question);
    assertEquals(answered.status, 200, await answered.clone().text());
    const mine = await (await api(
      o.fixture,
      o.guest.cookie,
      "GET",
      `/v1/runs/${o.run.runId}/requests/mine`,
    )).json() as { requests: { status: string }[] };
    assertEquals(mine.requests.map((r) => r.status), ["answered"]);
  } finally {
    await o.finish();
  }
});

Deno.test("a power granted for the other kind of row is no power", async () => {
  const o = await open();
  try {
    // Hand-built grants that the request route would never write: an answer
    // power on an approval, and an approve power on a question. The lookup
    // matches the power the action needs, so neither opens anything.
    const grant = (power: string, target: string) =>
      o.fixture.pgDatabase.query(
        `insert into bakery.run_power_grants (
           organization_id, run_id, principal_id, power, target_kind, question_id,
           expires_at)
         values ($1, $2, $3, $4, 'question', $5, now() + interval '1 day')`,
        [
          o.fixture.organizationId,
          o.run.runId,
          o.guest.principalId,
          power,
          target,
        ],
      );
    await grant("answer", o.approval);
    await grant("approve", o.question);
    for (
      const path of [
        `/v1/approvals/${o.approval}`,
        `/v1/questions/${o.question}`,
      ]
    ) {
      assertEquals((await o.get(o.guest.cookie, path)).status, 404, path);
    }
    assertEquals((await o.decide(o.guest.cookie, o.approval)).status, 404);
    assertEquals(
      (await api(
        o.fixture,
        o.guest.cookie,
        "PUT",
        `/v1/questions/${o.question}/answer`,
        { answer: { text: "main" } },
      )).status,
      404,
    );
  } finally {
    await o.finish();
  }
});

Deno.test("a developer outside the named audience still cannot read or decide a private approval", async () => {
  const o = await open();
  try {
    // The audience check is the second wall: a developer passes the gate, so
    // only this check keeps a private approval or question private.
    const outsider = await addMember(o.fixture, "Outsider", "developer");
    try {
      assertEquals(
        (await o.get(outsider.cookie, `/v1/approvals/${o.approval}`)).status,
        404,
      );
      assertEquals((await o.decide(outsider.cookie, o.approval)).status, 404);
      assertEquals(
        (await o.get(outsider.cookie, `/v1/questions/${o.question}`)).status,
        404,
      );
      // The named approver is not refused.
      assertEquals(
        (await o.get(o.approver.cookie, `/v1/approvals/${o.approval}`)).status,
        200,
      );
    } finally {
      await cleanupAuthFixture(o.fixture.pgDatabase, [outsider.email]);
    }
  } finally {
    await o.finish();
  }
});

Deno.test("a person hands on only a decision they could make themselves, never one they were handed", async () => {
  const o = await open();
  const bystander = await addMember(o.fixture, "Bystander", "developer");
  try {
    const askAs = (
      cookie: string,
      recipientId: string,
      intent: string,
      questionId: string,
    ) =>
      api(o.fixture, cookie, "POST", `/v1/runs/${o.run.runId}/requests`, {
        recipientId,
        intent,
        questionId,
      });
    const refused = async (response: Response) => {
      const text = await response.text();
      assertEquals(response.status, 403, text);
      assertEquals(
        (JSON.parse(text) as { code: string }).code,
        "AUTH_FORBIDDEN",
      );
    };
    const fyi = await api(
      o.fixture,
      bystander.cookie,
      "POST",
      `/v1/runs/${o.run.runId}/requests`,
      { recipientId: o.approver.principalId, intent: "fyi" },
    );
    assertEquals(fyi.status, 201, await fyi.text());
    await refused(
      await askAs(bystander.cookie, o.guest.principalId, "approve", o.approval),
    );
    await refused(
      await askAs(bystander.cookie, o.guest.principalId, "answer", o.question),
    );
    await refused(
      await askAs(o.fixture.cookie, o.guest.principalId, "approve", o.approval),
    );
    const handed = await askAs(
      o.approver.cookie,
      bystander.principalId,
      "approve",
      o.approval,
    );
    assertEquals(handed.status, 201, await handed.text());
    assertEquals(
      (await o.get(bystander.cookie, `/v1/approvals/${o.approval}`)).status,
      200,
    );
    await refused(
      await askAs(bystander.cookie, o.guest.principalId, "approve", o.approval),
    );
    assertEquals(
      (await o.get(o.guest.cookie, `/v1/approvals/${o.approval}`)).status,
      404,
    );
    const guestRows = await o.fixture.pgDatabase.query(
      `select 1 from bakery.run_power_grants
        where organization_id = $1 and principal_id = $2
       union all
       select 1 from bakery.person_requests
        where organization_id = $1 and recipient_id = $2`,
      [o.fixture.organizationId, o.guest.principalId],
    );
    assertEquals(guestRows.rows.length, 0);
  } finally {
    await cleanupAuthFixture(o.fixture.pgDatabase, [bystander.email]);
    await o.finish();
  }
});
