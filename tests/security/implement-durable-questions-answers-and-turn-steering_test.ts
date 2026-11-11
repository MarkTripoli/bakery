import { assert, assertEquals } from "@std/assert";
import { authTestOrigin, openAuthFixture } from "../helpers/auth.ts";
import { registeredWorker } from "../helpers/worker-execution.ts";
import {
  heartbeatRequest,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  cleanupSeededOrganizations,
  sendMessage,
} from "../helpers/coordinator-turns.ts";
import {
  ASK_ALLOW_OR_DENY,
  type Fixture,
  type QuestionView,
  request,
  runTurn,
  scriptedEffects,
  seedLiveAttempt,
  seedOrganization,
  seedTask,
} from "../helpers/durable-questions.ts";

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

async function openQuestion(fixture: Fixture, label: string) {
  const seed = await seedOrganization(fixture, label);
  const taskId = await seedTask(fixture, seed);
  await sendMessage(fixture, seed, "agent_request", "decide");
  await runTurn(fixture, seed, scriptedEffects([ASK_ALLOW_OR_DENY]));
  const id = (await fixture.pgDatabase.query<{ id: string }>(
    `select id from bakery.questions where conversation_id = $1`,
    [seed.conversationId],
  )).rows[0].id;
  return { seed, taskId, id };
}

Deno.test("a foreign tenant can neither read, list, answer nor steer another tenant's work", () =>
  withFixture(async (fixture) => {
    const { seed, taskId, id } = await openQuestion(fixture, "tenant-a");
    const foreign = await seedOrganization(fixture, "tenant-b");
    const intruder = {
      cookie: foreign.cookie,
      organizationId: foreign.organizationId,
    };
    assertEquals(
      (await request(fixture, intruder, `/v1/questions/${id}`)).status,
      404,
    );
    const listed = await request(fixture, intruder, "/v1/questions");
    assertEquals(listed.status, 200);
    assertEquals(
      ((await listed.json()) as { items: unknown[] }).items.length,
      0,
    );
    const answer = await request(
      fixture,
      intruder,
      `/v1/questions/${id}/answer`,
      {
        method: "PUT",
        body: { answer: { optionId: "yes" } },
      },
    );
    assertEquals(answer.status, 404);
    // Naming tenant A's organization with tenant B's session is forbidden outright.
    const crossHeader = await request(
      fixture,
      { cookie: foreign.cookie, organizationId: seed.organizationId },
      `/v1/questions/${id}/answer`,
      { method: "PUT", body: { answer: { optionId: "yes" } } },
    );
    assert(crossHeader.status === 403 || crossHeader.status === 404);
    const stored = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.questions where id = $1`,
      [id],
    );
    assertEquals(stored.rows[0].status, "open");

    const ids = await seedLiveAttempt(fixture, seed, taskId, ["steer"]);
    const steer = await request(
      fixture,
      intruder,
      `/v1/sessions/${ids.agentSessionId}/messages`,
      { method: "POST", body: { body: "hijack", mode: "steer" } },
    );
    assertEquals(steer.status, 404);
    assertEquals(
      (await request(fixture, intruder, `/v1/sessions/${ids.agentSessionId}`))
        .status,
      404,
    );
    const commands = await fixture.pgDatabase.query(
      `select 1 from bakery.worker_commands where attempt_id = $1`,
      [ids.attemptId],
    );
    assertEquals(commands.rows.length, 0);
  }));

Deno.test("viewers read questions but cannot answer them or steer sessions", () =>
  withFixture(async (fixture) => {
    const { seed, taskId, id } = await openQuestion(fixture, "viewer-base");
    const { addMember } = await import("../helpers/durable-questions.ts");
    const viewer = await addMember(fixture, seed, "viewer", "viewer");
    const identity = {
      cookie: viewer.cookie,
      organizationId: seed.organizationId,
    };
    assertEquals(
      (await request(fixture, identity, `/v1/questions/${id}`)).status,
      200,
    );
    const answered = await request(
      fixture,
      identity,
      `/v1/questions/${id}/answer`,
      {
        method: "PUT",
        body: { answer: { optionId: "yes" } },
      },
    );
    assertEquals(answered.status, 403);
    const ids = await seedLiveAttempt(fixture, seed, taskId, ["steer"]);
    const steer = await request(
      fixture,
      identity,
      `/v1/sessions/${ids.agentSessionId}/messages`,
      { method: "POST", body: { body: "viewer says go", mode: "steer" } },
    );
    assertEquals(steer.status, 403);
    const state = await (await request(fixture, seed, `/v1/questions/${id}`))
      .json() as QuestionView;
    assertEquals(state.status, "open");
  }));

Deno.test("unauthenticated and cross-site answers are refused", () =>
  withFixture(async (fixture) => {
    const { seed, id } = await openQuestion(fixture, "anonymous");
    const anonymous = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/questions/${id}/answer`, {
        method: "PUT",
        headers: {
          origin: authTestOrigin,
          "content-type": "application/json",
          "Bakery-Organization-Id": seed.organizationId,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ answer: { optionId: "yes" } }),
      }),
    );
    assertEquals(anonymous.status, 401);
    const crossSite = await fixture.app.fetch(
      new Request(`${authTestOrigin}/v1/questions/${id}/answer`, {
        method: "PUT",
        headers: {
          cookie: seed.cookie,
          origin: "https://evil.example",
          "content-type": "application/json",
          "Bakery-Organization-Id": seed.organizationId,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ answer: { optionId: "yes" } }),
      }),
    );
    assert(crossSite.status === 403 || crossSite.status === 401);
    const stored = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.questions where id = $1`,
      [id],
    );
    assertEquals(stored.rows[0].status, "open");
  }));

Deno.test("the application role cannot rewrite a question's identity, prompt, options or audience", () =>
  withFixture(async (fixture) => {
    const { id } = await openQuestion(fixture, "grants");
    for (
      const assignment of [
        "prompt = 'rewritten'",
        "options = '[]'::jsonb",
        'audience = \'{"type":"task_participants"}\'::jsonb',
        "organization_id = gen_random_uuid()",
        "generation = 99",
        "turn_id = null",
        "expires_at = null",
      ]
    ) {
      let denied = false;
      try {
        await fixture.runtimePgDatabase.query(
          `update bakery.questions set ${assignment} where id = $1`,
          [id],
        );
      } catch {
        denied = true;
      }
      assert(denied, `${assignment} must be denied`);
    }
    await fixture.runtimePgDatabase.query(
      `update bakery.questions set status = status where id = $1`,
      [id],
    );
  }));

Deno.test("only the closed adapter capability vocabulary is stored by the heartbeat path", async () => {
  const { ADAPTER_CAPABILITIES } = await import(
    "../../packages/persistence/src/heartbeat.ts"
  );
  assertEquals([...ADAPTER_CAPABILITIES].sort(), [
    "follow_up",
    "interrupt",
    "resume",
    "steer",
    "stream",
  ]);
});

Deno.test("a heartbeat advertising an unknown adapter capability is rejected and stores nothing", () =>
  withWorkerFixture(async (fixture) => {
    const worker = await registeredWorker(fixture, {
      name: "unknown-adapter-capability",
    });
    const stored = async () =>
      (await fixture.pgDatabase.query<{ caps: unknown }>(
        `select adapter_capabilities as caps from bakery.worker_hosts where id = $1`,
        [worker.registration.workerHostId],
      )).rows[0].caps;
    const before = await stored();
    const rejected = await heartbeatRequest(fixture, worker, {
      adapterCapabilities: ["steer", "root_shell"],
    });
    assertEquals(rejected.status, 422);
    await rejected.body?.cancel();
    assertEquals(await stored(), before);
    const accepted = await heartbeatRequest(fixture, worker, {
      adapterCapabilities: ["steer"],
    });
    assertEquals(accepted.status, 200);
    await accepted.body?.cancel();
    assertEquals(await stored(), ["steer"]);
  }));
