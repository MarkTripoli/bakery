import { assert, assertEquals } from "@std/assert";
import { openAuthFixture } from "../helpers/auth.ts";
import {
  cleanupSeededOrganizations,
  sendMessage,
} from "../helpers/coordinator-turns.ts";
import {
  addMember,
  ASK_ALLOW_OR_DENY,
  type Fixture,
  type QuestionView,
  request,
  runTurn,
  scriptedEffects,
  type Seed,
  seedLiveAttempt,
  seedOrganization,
  seedTask,
} from "../helpers/durable-questions.ts";
import { expireDueQuestions } from "../../apps/server/src/modules/conversation/questions.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";

async function withFixture(
  work: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const fixture = await openAuthFixture();
  try {
    await work(fixture);
  } finally {
    try {
      await cleanupSeededOrganizations(fixture);
    } finally {
      await fixture.close();
    }
  }
}

/** Seeds an organization whose coordinator turn has asked one question. */
async function askedQuestion(
  fixture: Fixture,
  label: string,
  effect: Parameters<typeof scriptedEffects>[0][number] = ASK_ALLOW_OR_DENY,
) {
  const seed = await seedOrganization(fixture, label);
  const taskId = await seedTask(fixture, seed);
  await sendMessage(fixture, seed, "agent_request", "need a decision");
  const result = await runTurn(fixture, seed, scriptedEffects([effect]));
  assertEquals((result as { status: string }).status, "completed");
  const rows = await fixture.pgDatabase.query<{ id: string }>(
    `select id from bakery.questions where conversation_id = $1`,
    [seed.conversationId],
  );
  assertEquals(rows.rows.length, 1);
  return { seed, taskId, questionId: rows.rows[0].id };
}

const answerPath = (id: string) => `/v1/questions/${id}/answer`;

async function turnCount(fixture: Fixture, seed: Seed): Promise<number> {
  const rows = await fixture.pgDatabase.query<{ count: number }>(
    `select count(*)::int as count from bakery.conversation_turns where conversation_id = $1`,
    [seed.conversationId],
  );
  return rows.rows[0].count;
}

Deno.test("question effect creates a durable question bound to the asking turn and generation", () =>
  withFixture(async (fixture) => {
    const { seed, taskId, questionId } = await askedQuestion(fixture, "create");
    const response = await request(
      fixture,
      seed,
      `/v1/questions/${questionId}`,
    );
    assertEquals(response.status, 200);
    const question = await response.json() as QuestionView;
    assertEquals(question.status, "open");
    assertEquals(question.kind, "question");
    assertEquals(question.generation, 1);
    assertEquals(question.taskId, taskId);
    assertEquals(question.options?.map((o) => o.id), ["yes", "no"]);
    const turn = await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.conversation_turns where conversation_id = $1`,
      [seed.conversationId],
    );
    assertEquals(question.turnId, turn.rows[0].id);

    const list = await request(
      fixture,
      seed,
      `/v1/questions?conversationId=${seed.conversationId}&status=open`,
    );
    assertEquals(list.status, 200);
    assertEquals(
      ((await list.json()) as { items: { id: string }[] }).items.map((i) =>
        i.id
      ),
      [questionId],
    );
  }));

Deno.test("question without a task fails the turn instead of creating a question", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "notask");
    await sendMessage(fixture, seed, "agent_request", "ask");
    await runTurn(fixture, seed, scriptedEffects([ASK_ALLOW_OR_DENY]));
    const turn = await fixture.pgDatabase.query<
      { status: string; failure: { code: string } }
    >(
      `select status, failure from bakery.conversation_turns where conversation_id = $1`,
      [seed.conversationId],
    );
    assertEquals(turn.rows[0].status, "failed");
    assertEquals(turn.rows[0].failure.code, "question_requires_task");
    const questions = await fixture.pgDatabase.query(
      `select 1 from bakery.questions where organization_id = $1`,
      [seed.organizationId],
    );
    assertEquals(questions.rows.length, 0);
  }));

Deno.test("AC1: racing clients commit one answer, identical replay acknowledges, conflicting fails", () =>
  withFixture(async (fixture) => {
    const { seed, questionId } = await askedQuestion(fixture, "race");
    const other = await addMember(fixture, seed, "second-client");
    const [first, second] = await Promise.all([
      request(fixture, seed, answerPath(questionId), {
        method: "PUT",
        body: { answer: { optionId: "yes" } },
      }),
      request(
        fixture,
        {
          cookie: other.cookie,
          organizationId: seed.organizationId,
        },
        answerPath(questionId),
        {
          method: "PUT",
          body: { answer: { optionId: "no" } },
        },
      ),
    ]);
    const statuses = [first.status, second.status].sort();
    assertEquals(statuses, [200, 409]);
    const loserBody = await (first.status === 409 ? first : second).json() as {
      code: string;
      reason?: string;
    };
    assertEquals(loserBody.code, "STATE_CONFLICT");

    const winner = first.status === 200 ? seed.principalId : other.principalId;
    const winnerOption = first.status === 200 ? "yes" : "no";
    const stored =
      await (await request(fixture, seed, `/v1/questions/${questionId}`))
        .json() as QuestionView;
    assertEquals(stored.status, "answered");
    assertEquals(stored.answer, { optionId: winnerOption });
    assertEquals(stored.answeredBy, winner);

    // Identical replay under a fresh Idempotency-Key acknowledges, no new effect.
    const replay = await request(fixture, seed, answerPath(questionId), {
      method: "PUT",
      body: { answer: { optionId: winnerOption } },
    });
    assertEquals(replay.status, 200);
    assertEquals(
      ((await replay.json()) as QuestionView).version,
      stored.version,
    );
    // A conflicting answer fails and changes nothing.
    const conflicting = await request(fixture, seed, answerPath(questionId), {
      method: "PUT",
      body: { answer: { optionId: winnerOption === "yes" ? "no" : "yes" } },
    });
    assertEquals(conflicting.status, 409);
    const after =
      await (await request(fixture, seed, `/v1/questions/${questionId}`))
        .json() as QuestionView;
    assertEquals(after.version, stored.version);
    assertEquals(after.answer, stored.answer);

    // Exactly one follow-up turn (the asking turn plus one) was queued.
    assertEquals(await turnCount(fixture, seed), 2);
    const queued = await fixture.pgDatabase.query<{ intent: string }>(
      `select message.intent from bakery.conversation_turns turn
         join bakery.messages message on message.id = turn.trigger_message_id
        where turn.conversation_id = $1 and turn.status = 'queued'`,
      [seed.conversationId],
    );
    assertEquals(queued.rows.map((r) => r.intent), ["agent_request"]);
  }));

Deno.test("AC2: stale generation records the answer but queues no follow-up turn", () =>
  withFixture(async (fixture) => {
    const { seed, questionId } = await askedQuestion(fixture, "stale");
    // A newer request starts a newer generation before the answer arrives.
    await sendMessage(fixture, seed, "agent_request", "never mind, new topic");
    assertEquals(await turnCount(fixture, seed), 2);
    const answered = await request(fixture, seed, answerPath(questionId), {
      method: "PUT",
      body: { answer: { optionId: "yes" } },
    });
    assertEquals(answered.status, 200);
    assertEquals(await turnCount(fixture, seed), 2);
    const system = await fixture.pgDatabase.query(
      `select 1 from bakery.messages where conversation_id = $1 and message_type = 'system'`,
      [seed.conversationId],
    );
    assertEquals(system.rows.length, 0);
  }));

Deno.test("AC2: expired questions refuse answers and the sweep marks them expired", () =>
  withFixture(async (fixture) => {
    const { seed, questionId } = await askedQuestion(fixture, "expiry");
    await fixture.pgDatabase.query(
      `update bakery.questions set expires_at = now() - interval '1 second' where id = $1`,
      [questionId],
    );
    const effective =
      await (await request(fixture, seed, `/v1/questions/${questionId}`))
        .json() as QuestionView;
    assertEquals(effective.status, "expired");
    const late = await request(fixture, seed, answerPath(questionId), {
      method: "PUT",
      body: { answer: { optionId: "yes" } },
    });
    assertEquals(late.status, 409);
    assertEquals(await turnCount(fixture, seed), 1);
    assert(await expireDueQuestions(fixture.runtimePgDatabase) >= 1);
    const row = await fixture.pgDatabase.query<
      { status: string; answer: unknown }
    >(
      `select status, answer from bakery.questions where id = $1`,
      [questionId],
    );
    assertEquals(row.rows[0].status, "expired");
    assertEquals(row.rows[0].answer, null);
    const events = await fixture.pgDatabase.query(
      `select 1 from bakery.domain_events where event_type = 'question.expired' and aggregate_id = $1`,
      [questionId],
    );
    assertEquals(events.rows.length, 1);
  }));

Deno.test("AC2: an unbound free-text yes in chat never answers a question or resumes a run", () =>
  withFixture(async (fixture) => {
    const { seed, questionId } = await askedQuestion(fixture, "chatyes");
    assertEquals(
      (await sendMessage(fixture, seed, "discussion", "yes")).status,
      201,
    );
    const open =
      await (await request(fixture, seed, `/v1/questions/${questionId}`))
        .json() as QuestionView;
    assertEquals(open.status, "open");
    assertEquals(open.answer, null);
    assertEquals(await turnCount(fixture, seed), 1);
  }));

Deno.test("answers are validated against options and free-text policy", () =>
  withFixture(async (fixture) => {
    const { seed, questionId } = await askedQuestion(fixture, "validate");
    for (
      const answer of [
        { optionId: "maybe" },
        { text: "free text not allowed" },
        {},
        { optionId: "yes", extra: true },
      ]
    ) {
      const response = await request(fixture, seed, answerPath(questionId), {
        method: "PUT",
        body: { answer },
      });
      assertEquals(response.status, 422, JSON.stringify(answer));
    }
    const still =
      await (await request(fixture, seed, `/v1/questions/${questionId}`))
        .json() as QuestionView;
    assertEquals(still.status, "open");
  }));

Deno.test("explicit-principal audience excludes other participants", () =>
  withFixture(async (fixture) => {
    const base = await seedOrganization(fixture, "audience");
    await seedTask(fixture, base);
    const allowed = await addMember(fixture, base, "allowed-member");
    const outsider = await addMember(fixture, base, "outsider");
    await sendMessage(fixture, base, "agent_request", "ask someone");
    await runTurn(
      fixture,
      base,
      scriptedEffects([{
        type: "question",
        prompt: "Who approves?",
        audience: { type: "principals", principalIds: [allowed.principalId] },
      }]),
    );
    const id = (await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.questions where conversation_id = $1`,
      [base.conversationId],
    )).rows[0].id;
    const denied = await request(
      fixture,
      {
        cookie: outsider.cookie,
        organizationId: base.organizationId,
      },
      answerPath(id),
      { method: "PUT", body: { answer: { text: "me" } } },
    );
    assertEquals(
      denied.status,
      404,
      "an outsider cannot confirm the question exists",
    );
    const accepted = await request(
      fixture,
      {
        cookie: allowed.cookie,
        organizationId: base.organizationId,
      },
      answerPath(id),
      { method: "PUT", body: { answer: { text: "me" } } },
    );
    assertEquals(accepted.status, 200);
    // Audience is checked before replay and status: an outsider never sees 200/409.
    const outsiderReplay = await request(
      fixture,
      { cookie: outsider.cookie, organizationId: base.organizationId },
      answerPath(id),
      { method: "PUT", body: { answer: { text: "me" } } },
    );
    assertEquals(outsiderReplay.status, 404);
    const outsiderOther = await request(
      fixture,
      { cookie: outsider.cookie, organizationId: base.organizationId },
      answerPath(id),
      { method: "PUT", body: { answer: { text: "different" } } },
    );
    assertEquals(outsiderOther.status, 404);
  }));

Deno.test("AC3: unsupported steer modes are explicit and create no message or command", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "unsupported-steer");
    const taskId = await seedTask(fixture, seed);
    const ids = await seedLiveAttempt(fixture, seed, taskId, []);
    for (const mode of ["steer", "follow_up"]) {
      const response = await request(
        fixture,
        seed,
        `/v1/sessions/${ids.agentSessionId}/messages`,
        { method: "POST", body: { body: "go left", mode } },
      );
      assertEquals(response.status, 409);
      const problem = await response.json() as { code: string };
      assertEquals(problem.code, "STATE_CONFLICT");
    }
    const commands = await fixture.pgDatabase.query(
      `select 1 from bakery.worker_commands where attempt_id = $1`,
      [ids.attemptId],
    );
    assertEquals(commands.rows.length, 0);
    const messages = await fixture.pgDatabase.query(
      `select 1 from bakery.messages where conversation_id = $1 and body = 'go left'`,
      [seed.conversationId],
    );
    assertEquals(messages.rows.length, 0);

    // Capability discovery and run control agree: only cancel is allowed.
    const capabilities = await (await request(
      fixture,
      seed,
      `/v1/runs/${ids.runId}/controls`,
    )).json() as {
      actions: { action: string; canRequest: boolean; reason: string }[];
    };
    const byAction = Object.fromEntries(
      capabilities.actions.map((a) => [a.action, a]),
    );
    assertEquals(byAction.pause.reason, "unsupported");
    assertEquals(byAction.interrupt.reason, "unsupported");
    assertEquals(byAction.resume.canRequest, false);
    assertEquals(byAction.cancel.reason, "allowed");
    const paused = await request(
      fixture,
      seed,
      `/v1/runs/${ids.runId}/controls`,
      {
        method: "POST",
        body: { action: "pause" },
      },
    );
    assertEquals(paused.status, 409);
    assertEquals(
      (await fixture.pgDatabase.query(
        `select 1 from bakery.worker_commands where attempt_id = $1`,
        [ids.attemptId],
      )).rows.length,
      0,
    );
  }));

Deno.test("AC3: a duplicate steering request yields one acknowledged delivery and one command", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "dup-steer");
    const taskId = await seedTask(fixture, seed);
    const ids = await seedLiveAttempt(fixture, seed, taskId, [
      "steer",
      "follow_up",
    ]);
    const session = await request(
      fixture,
      seed,
      `/v1/sessions/${ids.agentSessionId}`,
    );
    assertEquals(session.status, 200);
    assertEquals(
      ((await session.json()) as { adapterCapabilities: string[] })
        .adapterCapabilities,
      ["steer", "follow_up"],
    );
    const clientMessageId = crypto.randomUUID();
    const send = (key: string) =>
      request(fixture, seed, `/v1/sessions/${ids.agentSessionId}/messages`, {
        method: "POST",
        key,
        body: { body: "prefer the small fix", mode: "steer", clientMessageId },
      });
    const [a, b, c] = await Promise.all([
      send(crypto.randomUUID()),
      send(crypto.randomUUID()),
      send(crypto.randomUUID()),
    ]);
    const bodies = await Promise.all(
      [a, b, c].map(async (r) => {
        assert(r.status === 201 || r.status === 200, `status ${r.status}`);
        return await r.json() as { id: string };
      }),
    );
    assertEquals(new Set(bodies.map((m) => m.id)).size, 1);
    const commands = await fixture.pgDatabase.query<
      {
        command_type: string;
        message_id: string;
        payload: { controlAction: string };
      }
    >(
      `select command_type, message_id, payload from bakery.worker_commands where attempt_id = $1`,
      [ids.attemptId],
    );
    assertEquals(commands.rows.length, 1);
    assertEquals(commands.rows[0].command_type, "steer");
    assertEquals(commands.rows[0].message_id, bodies[0].id);
    assertEquals(commands.rows[0].payload.controlAction, "steer_message");
    const events = await fixture.pgDatabase.query(
      `select 1 from bakery.domain_events where event_type = 'session.steering_requested'
        and organization_id = $1`,
      [seed.organizationId],
    );
    assertEquals(events.rows.length, 1);

    // A follow-up with another message becomes a separate follow_up command.
    const followUp = await request(
      fixture,
      seed,
      `/v1/sessions/${ids.agentSessionId}/messages`,
      { method: "POST", body: { body: "then add tests", mode: "follow_up" } },
    );
    assertEquals(followUp.status, 201);
    const types = await fixture.pgDatabase.query<{ command_type: string }>(
      `select command_type from bakery.worker_commands where attempt_id = $1 order by created_at`,
      [ids.attemptId],
    );
    assertEquals(types.rows.map((r) => r.command_type), ["steer", "follow_up"]);
  }));

Deno.test("advertised capabilities allow pause while cancel stays always allowed", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "advertised");
    const taskId = await seedTask(fixture, seed);
    const ids = await seedLiveAttempt(fixture, seed, taskId, ["steer"]);
    const capabilities = await (await request(
      fixture,
      seed,
      `/v1/runs/${ids.runId}/controls`,
    )).json() as {
      actions: { action: string; canRequest: boolean; reason: string }[];
    };
    const byAction = Object.fromEntries(
      capabilities.actions.map((a) => [a.action, a]),
    );
    assertEquals(byAction.pause.canRequest, true);
    assertEquals(byAction.interrupt.canRequest, true);
    assertEquals(byAction.resume.reason, "unsupported");
    const paused = await request(
      fixture,
      seed,
      `/v1/runs/${ids.runId}/controls`,
      {
        method: "POST",
        body: { action: "pause" },
      },
    );
    assertEquals(paused.status, 201);
  }));

Deno.test("cancelling a conversation turn never cancels a run, and cancelling a run never cancels a turn", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "distinct-cancel");
    const taskId = await seedTask(fixture, seed);
    const ids = await seedLiveAttempt(fixture, seed, taskId, []);
    await sendMessage(fixture, seed, "agent_request", "first");
    await sendMessage(fixture, seed, "agent_request", "second");
    const turns = await fixture.pgDatabase.query<
      { id: string; version: number }
    >(
      `select turn.id, turn.version from bakery.conversation_turns turn
         join bakery.messages message on message.id = turn.trigger_message_id
        where turn.conversation_id = $1 order by message.sequence`,
      [seed.conversationId],
    );
    const [firstTurn, secondTurn] = turns.rows;
    const cancelTurn = await fixture.app.fetch(
      new Request(
        `http://127.0.0.1:8788/v1/conversation-turns/${firstTurn.id}/cancel`,
        {
          method: "POST",
          headers: {
            cookie: seed.cookie,
            origin: "http://127.0.0.1:8788",
            "content-type": "application/json",
            "Bakery-Organization-Id": seed.organizationId,
            "Idempotency-Key": crypto.randomUUID(),
            "If-Match": `"${firstTurn.version}"`,
          },
          body: "{}",
        },
      ),
    );
    assertEquals(cancelTurn.status, 200);
    const afterTurnCancel = await fixture.pgDatabase.query<
      { status: string; attempt: string }
    >(
      `select job.status, attempt.status as attempt
         from bakery.jobs job
         join bakery.job_attempts attempt on attempt.job_id = job.id
        where job.id = $1`,
      [ids.jobId],
    );
    assertEquals(afterTurnCancel.rows[0].status, "running");
    assertEquals(afterTurnCancel.rows[0].attempt, "running");
    const run = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.workflow_runs where id = $1`,
      [ids.runId],
    );
    assertEquals(run.rows[0].status, "running");

    const cancelRun = await request(
      fixture,
      seed,
      `/v1/runs/${ids.runId}/controls`,
      {
        method: "POST",
        body: { action: "cancel" },
      },
    );
    assertEquals(cancelRun.status, 201);
    const secondStatus = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.conversation_turns where id = $1`,
      [secondTurn.id],
    );
    assertEquals(secondStatus.rows[0].status, "queued");
  }));

Deno.test("answering a question in an archived conversation is refused", () =>
  withFixture(async (fixture) => {
    const { seed, questionId } = await askedQuestion(fixture, "archived");
    await fixture.pgDatabase.query(
      `update bakery.conversations set archived_at = now() where id = $1`,
      [seed.conversationId],
    );
    const turnsBefore = await turnCount(fixture, seed);
    const answered = await request(fixture, seed, answerPath(questionId), {
      method: "PUT",
      body: { answer: { optionId: "yes" } },
    });
    assertEquals(answered.status, 409);
    assertEquals(await turnCount(fixture, seed), turnsBefore);
    const stored = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.questions where id = $1`,
      [questionId],
    );
    assertEquals(stored.rows[0].status, "open");
  }));

Deno.test("sibling questions from one turn queue one follow-up after the last answer", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "siblings");
    await seedTask(fixture, seed);
    await sendMessage(fixture, seed, "agent_request", "need two decisions");
    const result = await runTurn(
      fixture,
      seed,
      scriptedEffects([
        {
          type: "question",
          prompt: "First?",
          options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
        },
        {
          type: "question",
          prompt: "Second?",
          options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
        },
      ]),
    );
    assertEquals((result as { status: string }).status, "completed");
    const ids = (await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.questions where conversation_id = $1
        order by created_at, id`,
      [seed.conversationId],
    )).rows.map((row) => row.id);
    assertEquals(ids.length, 2);
    const before = await turnCount(fixture, seed);
    const first = await request(fixture, seed, answerPath(ids[0]), {
      method: "PUT",
      body: { answer: { optionId: "yes" } },
    });
    assertEquals(first.status, 200);
    assertEquals(await turnCount(fixture, seed), before);
    const second = await request(fixture, seed, answerPath(ids[1]), {
      method: "PUT",
      body: { answer: { optionId: "no" } },
    });
    assertEquals(second.status, 200);
    assertEquals(await turnCount(fixture, seed), before + 1);
    const body = (await fixture.pgDatabase.query<{ body: string }>(
      `select body from bakery.messages
        where conversation_id = $1 and message_type = 'system'`,
      [seed.conversationId],
    )).rows;
    assertEquals(body.length, 1);
    assert(body[0].body.includes("First?") && body[0].body.includes("Second?"));
  }));

Deno.test("F8: one answered and one expired sibling queue one follow-up from the sweep", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "sibling-expiry");
    await seedTask(fixture, seed);
    await sendMessage(fixture, seed, "agent_request", "need two decisions");
    const option = [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }];
    const result = await runTurn(
      fixture,
      seed,
      scriptedEffects([
        { type: "question", prompt: "First?", options: option },
        { type: "question", prompt: "Second?", options: option },
      ]),
    );
    assertEquals((result as { status: string }).status, "completed");
    const ids = (await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.questions where conversation_id = $1
        order by created_at, id`,
      [seed.conversationId],
    )).rows.map((row) => row.id);
    assertEquals(ids.length, 2);
    const before = await turnCount(fixture, seed);
    const first = await request(fixture, seed, answerPath(ids[0]), {
      method: "PUT",
      body: { answer: { optionId: "yes" } },
    });
    assertEquals(first.status, 200);
    assertEquals(await turnCount(fixture, seed), before);
    await fixture.pgDatabase.query(
      `update bakery.questions set expires_at = now() - interval '1 second' where id = $1`,
      [ids[1]],
    );
    await Promise.all([
      expireDueQuestions(fixture.runtimePgDatabase),
      expireDueQuestions(fixture.runtimePgDatabase),
    ]);
    await expireDueQuestions(fixture.runtimePgDatabase);
    assertEquals(await turnCount(fixture, seed), before + 1);
    const body = (await fixture.pgDatabase.query<{ body: string }>(
      `select body from bakery.messages
        where conversation_id = $1 and message_type = 'system'`,
      [seed.conversationId],
    )).rows;
    assertEquals(body.length, 1);
    assert(body[0].body.includes("First?") && body[0].body.includes("Yes"));
    assert(
      body[0].body.includes("Second?") && body[0].body.includes("expired"),
    );
  }));

Deno.test("ADV-003: the expiry sweep takes the conversation lock before it expires and queues", () =>
  withFixture(async (fixture) => {
    const { seed, questionId } = await askedQuestion(fixture, "sweep-lock");
    await fixture.pgDatabase.query(
      `update bakery.questions set expires_at = now() - interval '1 second' where id = $1`,
      [questionId],
    );
    // A message send holds the conversation row; the sweep must queue behind
    // it, not compute the same message sequence beside it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    let held!: () => void;
    const locked = new Promise<void>((resolve) => held = resolve);
    const holder = withPgTransaction(
      fixture.pgDatabase,
      async (transaction) => {
        await transaction.query(
          `select id from bakery.conversations where id = $1 for update`,
          [seed.conversationId],
        );
        held();
        await gate;
      },
    );
    await locked;
    const sweep = expireDueQuestions(fixture.runtimePgDatabase);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const waiting = await fixture.pgDatabase.query<{ count: number }>(
        `select count(distinct pid)::int as count from pg_locks where not granted`,
      );
      if (waiting.rows[0].count >= 1) break;
      if (Date.now() > deadline) throw new Error("sweep never waited");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const during = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.questions where id = $1`,
      [questionId],
    );
    assertEquals(during.rows[0].status, "open");
    release();
    await holder;
    assertEquals(await sweep, 1);
    const after = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.questions where id = $1`,
      [questionId],
    );
    assertEquals(after.rows[0].status, "expired");
  }));

Deno.test("ADV-003: the expiry sweep leaves due questions while the turn queue is full", () =>
  withFixture(async (fixture) => {
    const { seed, questionId } = await askedQuestion(fixture, "sweep-cap");
    await fixture.pgDatabase.query(
      `update bakery.questions set expires_at = now() - interval '1 second' where id = $1`,
      [questionId],
    );
    // Fill the conversation's queue to the 50-turn cap.
    await fixture.pgDatabase.query(
      `with base as (
         select coalesce(max(sequence), 0) as top from bakery.messages
          where organization_id = $1 and conversation_id = $2
       ), inserted as (
         insert into bakery.messages (
           organization_id, conversation_id, author_id, message_type, body,
           client_message_id, sequence, intent
         )
         select $1, $2, $3, 'user', 'queued ' || n, 'cap-' || n, base.top + n,
                'agent_request'
           from base, generate_series(1, 50) as n
         returning id, sequence
       )
       insert into bakery.conversation_turns (
         organization_id, conversation_id, trigger_message_id, status,
         context_through_sequence, agent_version_id
       )
       select $1, $2, id, 'queued', sequence, $4 from inserted`,
      [
        seed.organizationId,
        seed.conversationId,
        seed.principalId,
        seed.agentVersionId,
      ],
    );
    assertEquals(await expireDueQuestions(fixture.runtimePgDatabase), 0);
    const held = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.questions where id = $1`,
      [questionId],
    );
    assertEquals(
      held.rows[0].status,
      "open",
      "deferred, not queued past the cap",
    );
    await fixture.pgDatabase.query(
      `update bakery.conversation_turns set status = 'canceled'
        where conversation_id = $1 and status = 'queued'`,
      [seed.conversationId],
    );
    assertEquals(await expireDueQuestions(fixture.runtimePgDatabase), 1);
  }));
