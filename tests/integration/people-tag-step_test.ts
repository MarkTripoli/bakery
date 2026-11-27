import { assert, assertEquals } from "@std/assert";
import { createPeopleTagStepRunner } from "../../apps/server/src/modules/work/people-tag-step.ts";
import type { EngineStepRequest } from "../../apps/server/src/modules/workflow-adapter/engine-steps.ts";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";
import {
  addMember,
  api,
  seedArtifactVersion,
  seedRun,
  seedStep,
} from "../helpers/run-requests.ts";

async function open() {
  const fixture = await openSocketFixture();
  const guest = await addMember(fixture, "Tagged", "guest");
  const viewer = await addMember(fixture, "Viewer", "viewer");
  const run = await seedRun(fixture);
  await seedStep(fixture, run, "notify");
  const runner = createPeopleTagStepRunner({
    database: fixture.runtimePgDatabase,
  });
  const step = (
    input: Record<string, unknown>,
    overrides: Partial<EngineStepRequest> = {},
  ): EngineStepRequest => ({
    organizationId: fixture.organizationId,
    runId: run.runId,
    taskId: run.taskId,
    repositoryId: null,
    requestedBy: fixture.principalId,
    traceId: "trace-456-b",
    stepKey: "notify",
    iteration: 0,
    action: "people.tag",
    input,
    ...overrides,
  });
  const tags = async () =>
    (await fixture.pgDatabase.query<{
      recipient_id: string;
      asked_by: string;
      asked_by_kind: string;
      intent: string;
      step_key: string;
      status: string;
    }>(
      `select recipient_id, asked_by, asked_by_kind, intent, step_key, status
         from bakery.person_requests
        where organization_id = $1 and run_id = $2
        order by created_at, id`,
      [fixture.organizationId, run.runId],
    )).rows;
  const ledgerKinds = async () =>
    (await fixture.pgDatabase.query<{ kind: string }>(
      `select kind from bakery.decisions_ledger
        where organization_id = $1 and run_id = $2 and kind like 'request%'
        order by created_at, kind`,
      [fixture.organizationId, run.runId],
    )).rows.map((row) => row.kind);
  return {
    fixture,
    guest,
    viewer,
    run,
    runner,
    step,
    tags,
    ledgerKinds,
    finish: async () => {
      await cleanupAuthFixture(fixture.pgDatabase, [
        fixture.email,
        guest.email,
        viewer.email,
      ]);
      await fixture.close();
    },
  };
}

Deno.test("a Notify step tags a person once, as the workflow, and carries on", async () => {
  const o = await open();
  try {
    const runPath = `/v1/runs/${o.run.runId}`;
    assertEquals(
      (await api(o.fixture, o.guest.cookie, "GET", runPath)).status,
      404,
    );
    const request = o.step({
      intent: "fyi",
      recipientId: o.guest.principalId,
      note: "The design is ready",
    });
    const done = await o.runner.run(request);
    assertEquals(done, {
      kind: "completed",
      output: { outcome: "sent", asked: 1 },
    });
    assertEquals(
      (await o.tags()).map((tag) => [
        tag.recipient_id,
        tag.asked_by,
        tag.asked_by_kind,
        tag.intent,
        tag.step_key,
        tag.status,
      ]),
      [[
        o.guest.principalId,
        o.fixture.principalId,
        "workflow",
        "fyi",
        "notify",
        "open",
      ]],
    );
    assertEquals(
      (await api(o.fixture, o.guest.cookie, "GET", runPath)).status,
      200,
    );
    assertEquals(await o.runner.run(request), done);
    assertEquals((await o.tags()).length, 1);
    assertEquals(await o.ledgerKinds(), ["request"]);
  } finally {
    await o.finish();
  }
});

Deno.test("a Notify step may tag the person who started the run", async () => {
  const o = await open();
  try {
    const done = await o.runner.run(
      o.step({ intent: "fyi", recipientRunRole: "starter" }),
    );
    assertEquals(done, {
      kind: "completed",
      output: { outcome: "sent", asked: 1 },
    });
    assertEquals(
      (await o.tags()).map((tag) => [
        tag.recipient_id,
        tag.asked_by,
        tag.asked_by_kind,
      ]),
      [[o.fixture.principalId, o.fixture.principalId, "workflow"]],
    );
  } finally {
    await o.finish();
  }
});

Deno.test("a waiting review step waits for the reviewer's comment, then completes responded", async () => {
  const o = await open();
  try {
    const version = await seedArtifactVersion(
      o.fixture,
      o.run.taskId,
      o.run.runId,
    );
    const request = o.step({
      intent: "review",
      recipientId: o.guest.principalId,
      artifactVersionId: version,
      wait: true,
    });
    assertEquals(await o.runner.run(request), { kind: "pending" });
    assertEquals(await o.runner.run(request), { kind: "pending" });
    assertEquals((await o.tags()).length, 1);
    const comment = await api(
      o.fixture,
      o.guest.cookie,
      "POST",
      `/v1/artifact-versions/${version}/comments`,
      { body: "Looks right to me." },
    );
    assertEquals(comment.status, 201, await comment.text());
    assertEquals(await o.runner.run(request), {
      kind: "completed",
      output: {
        outcome: "responded",
        asked: 1,
        respondedBy: o.guest.principalId,
      },
    });
    assertEquals(await o.ledgerKinds(), ["request", "request_handled"]);
  } finally {
    await o.fixture.pgDatabase.query(
      "delete from bakery.artifact_comments where organization_id = $1",
      [o.fixture.organizationId],
    );
    await o.finish();
  }
});

Deno.test("each iteration of a repeated review step asks anew and waits on its own request", async () => {
  const o = await open();
  try {
    const version = await seedArtifactVersion(
      o.fixture,
      o.run.taskId,
      o.run.runId,
    );
    const input = {
      intent: "review",
      recipientId: o.guest.principalId,
      artifactVersionId: version,
      wait: true,
    };
    assertEquals(await o.runner.run(o.step(input)), { kind: "pending" });
    await seedStep(o.fixture, o.run, "notify", 1);
    const comment = await api(
      o.fixture,
      o.guest.cookie,
      "POST",
      `/v1/artifact-versions/${version}/comments`,
      { body: "Looks right to me." },
    );
    assertEquals(comment.status, 201, await comment.text());
    const rows = async () =>
      (await o.fixture.pgDatabase.query<{
        id: string;
        version: number;
        status: string;
      }>(
        `select id, version, status from bakery.person_requests
          where organization_id = $1 and run_id = $2
          order by created_at, id`,
        [o.fixture.organizationId, o.run.runId],
      )).rows;
    const [first] = await rows();
    assert(first !== undefined);
    assertEquals(
      await o.runner.run(o.step(input, { iteration: 1 })),
      { kind: "pending" },
    );
    const after = await rows();
    assertEquals(after.length, 2);
    assertEquals(after[0], first);
    assert(after[1]?.id !== first.id);
    assertEquals(after[1]?.status, "open");
  } finally {
    await o.fixture.pgDatabase.query(
      "delete from bakery.artifact_comments where organization_id = $1",
      [o.fixture.organizationId],
    );
    await o.finish();
  }
});

Deno.test("a waiting step whose request expires needs a person, never approved", async () => {
  const o = await open();
  try {
    const version = await seedArtifactVersion(
      o.fixture,
      o.run.taskId,
      o.run.runId,
    );
    const request = o.step({
      intent: "review",
      recipientId: o.guest.principalId,
      artifactVersionId: version,
      wait: true,
    });
    assertEquals(await o.runner.run(request), { kind: "pending" });
    await o.fixture.pgDatabase.query(
      `update bakery.person_requests set expires_at = now() - interval '1 minute'
        where organization_id = $1 and run_id = $2`,
      [o.fixture.organizationId, o.run.runId],
    );
    assertEquals(await o.runner.run(request), {
      kind: "needs_human",
      output: { outcome: "expired", asked: 1 },
    });
    assertEquals((await o.tags()).map((tag) => tag.status), ["expired"]);
    assertEquals(
      await o.runner.run({
        ...request,
        input: { ...(request.input as object), onExpiry: "continue" },
      }),
      { kind: "completed", output: { outcome: "expired", asked: 1 } },
    );
  } finally {
    await o.finish();
  }
});

async function openWithNextPerson() {
  const o = await open();
  const next = await addMember(o.fixture, "Next", "guest");
  const version = await seedArtifactVersion(
    o.fixture,
    o.run.taskId,
    o.run.runId,
  );
  const request = o.step({
    intent: "review",
    recipientId: o.guest.principalId,
    artifactVersionId: version,
    wait: true,
    ifNobodyAnswers: { afterHours: 24, recipientId: next.principalId },
  });
  const askedAgo = (hours: number) =>
    o.fixture.pgDatabase.query(
      `update bakery.person_requests
          set created_at = created_at - make_interval(hours => $3)
        where organization_id = $1 and run_id = $2`,
      [o.fixture.organizationId, o.run.runId, hours],
    );
  return {
    ...o,
    next,
    version,
    request,
    askedAgo,
    finishAll: async () => {
      await o.fixture.pgDatabase.query(
        "delete from bakery.artifact_comments where organization_id = $1",
        [o.fixture.organizationId],
      );
      await cleanupAuthFixture(o.fixture.pgDatabase, [next.email]);
      await o.finish();
    },
  };
}

Deno.test("a waiting step asks the next person once, after the hours it names, and completes when they answer", async () => {
  const o = await openWithNextPerson();
  try {
    assertEquals(await o.runner.run(o.request), { kind: "pending" });
    await o.askedAgo(23);
    assertEquals(await o.runner.run(o.request), { kind: "pending" });
    assertEquals((await o.tags()).length, 1);
    await o.askedAgo(2);
    assertEquals(await o.runner.run(o.request), { kind: "pending" });
    assertEquals(await o.runner.run(o.request), { kind: "pending" });
    assertEquals(
      (await o.tags()).map((tag) => [tag.recipient_id, tag.status]),
      [[o.guest.principalId, "open"], [o.next.principalId, "open"]],
    );
    const comment = await api(
      o.fixture,
      o.next.cookie,
      "POST",
      `/v1/artifact-versions/${o.version}/comments`,
      { body: "Taking this one." },
    );
    assertEquals(comment.status, 201, await comment.text());
    assertEquals(await o.runner.run(o.request), {
      kind: "completed",
      output: {
        outcome: "responded",
        asked: 2,
        respondedBy: o.next.principalId,
      },
    });
  } finally {
    await o.finishAll();
  }
});

Deno.test("the run's requests say who is asked next and when, and mark the next ask once it is made", async () => {
  const o = await openWithNextPerson();
  try {
    await o.fixture.pgDatabase.query(
      `update bakery.run_steps set input = $3::jsonb
        where organization_id = $1 and run_id = $2 and step_key = 'notify'`,
      [o.fixture.organizationId, o.run.runId, JSON.stringify(o.request.input)],
    );
    const read = async () => {
      const response = await api(
        o.fixture,
        o.fixture.cookie,
        "GET",
        `/v1/runs/${o.run.runId}/requests`,
      );
      assertEquals(response.status, 200);
      const body = await response.json() as {
        requests: {
          recipient: { principalId: string };
          createdAt: string;
          nextAsk:
            | { dueAt: string; askedAt: string | null; who: string | null }
            | null;
          passedOn: boolean;
        }[];
      };
      return body.requests;
    };
    assertEquals(await o.runner.run(o.request), { kind: "pending" });
    const [first] = await read();
    assertEquals(first!.passedOn, false);
    assertEquals(first!.nextAsk?.askedAt, null);
    assertEquals(first!.nextAsk?.who, "Next");
    assertEquals(
      Date.parse(first!.nextAsk!.dueAt) - Date.parse(first!.createdAt),
      24 * 3_600_000,
    );
    await o.askedAgo(25);
    assertEquals(await o.runner.run(o.request), { kind: "pending" });
    const after = await read();
    const passed = after.find((request) =>
      request.recipient.principalId === o.next.principalId
    )!;
    const original = after.find((request) =>
      request.recipient.principalId === o.guest.principalId
    )!;
    assertEquals(passed.passedOn, true);
    assertEquals(passed.nextAsk, null);
    assertEquals(original.passedOn, false);
    assert(original.nextAsk?.askedAt !== null);
  } finally {
    await o.finishAll();
  }
});

Deno.test("who is asked next is named only from this organization, as the ask itself names it", async () => {
  const o = await openWithNextPerson();
  try {
    assertEquals(await o.runner.run(o.request), { kind: "pending" });
    const whoWith = async (next: Record<string, unknown>) => {
      await o.fixture.pgDatabase.query(
        `update bakery.run_steps set input = $3::jsonb
          where organization_id = $1 and run_id = $2 and step_key = 'notify'`,
        [
          o.fixture.organizationId,
          o.run.runId,
          JSON.stringify({
            ...o.request.input as object,
            ifNobodyAnswers: next,
          }),
        ],
      );
      const response = await api(
        o.fixture,
        o.fixture.cookie,
        "GET",
        `/v1/runs/${o.run.runId}/requests`,
      );
      const body = await response.json() as {
        requests: {
          nextAsk: { who: string | null; askedAt: string | null } | null;
        }[];
      };
      return body.requests[0]!.nextAsk;
    };
    assertEquals(
      (await whoWith({ recipientId: o.next.principalId }))?.who,
      "Next",
    );
    assertEquals(
      (await whoWith({ recipientRoleKey: "admin" }))?.who,
      "Administrators",
    );
    assertEquals(
      await whoWith({ recipientRoleKey: "release-managers" }),
      null,
    );
    await o.fixture.pgDatabase.query(
      `update bakery.organization_memberships set status = 'inactive'
        where organization_id = $1 and principal_id = $2`,
      [o.fixture.organizationId, o.next.principalId],
    );
    assertEquals(
      (await whoWith({ recipientId: o.next.principalId }))?.who,
      null,
    );
    await o.fixture.pgDatabase.query(
      `delete from bakery.organization_memberships
        where organization_id = $1 and principal_id = $2`,
      [o.fixture.organizationId, o.next.principalId],
    );
    assertEquals(
      (await whoWith({ recipientId: o.next.principalId }))?.who,
      null,
    );
  } finally {
    await o.finishAll();
  }
});

Deno.test("a next ask that reaches nobody new is not shown, before or after it is due", async () => {
  const o = await openWithNextPerson();
  try {
    const again = o.step({
      ...o.request.input as Record<string, unknown>,
      ifNobodyAnswers: { afterHours: 24, recipientId: o.guest.principalId },
    });
    await o.fixture.pgDatabase.query(
      `update bakery.run_steps set input = $3::jsonb
        where organization_id = $1 and run_id = $2 and step_key = 'notify'`,
      [o.fixture.organizationId, o.run.runId, JSON.stringify(again.input)],
    );
    assertEquals(await o.runner.run(again), { kind: "pending" });
    const before = await api(
      o.fixture,
      o.fixture.cookie,
      "GET",
      `/v1/runs/${o.run.runId}/requests`,
    );
    assertEquals(
      ((await before.json()) as { requests: { nextAsk: unknown }[] })
        .requests[0]!.nextAsk,
      null,
    );
    await o.askedAgo(25);
    assertEquals(await o.runner.run(again), { kind: "pending" });
    assertEquals((await o.tags()).length, 1);
    const response = await api(
      o.fixture,
      o.fixture.cookie,
      "GET",
      `/v1/runs/${o.run.runId}/requests`,
    );
    const body = await response.json() as {
      requests: { nextAsk: { askedAt: string | null } | null }[];
    };
    assertEquals(body.requests[0]!.nextAsk, null);
  } finally {
    await o.finishAll();
  }
});

Deno.test("a next group whose members were all asked already is not shown from the start", async () => {
  const o = await openWithNextPerson();
  try {
    const groupId = await seedGroup(o.fixture, [o.guest.principalId]);
    const again = o.step({
      ...o.request.input as Record<string, unknown>,
      ifNobodyAnswers: { afterHours: 24, recipientGroupId: groupId },
    });
    await o.fixture.pgDatabase.query(
      `update bakery.run_steps set input = $3::jsonb
        where organization_id = $1 and run_id = $2 and step_key = 'notify'`,
      [o.fixture.organizationId, o.run.runId, JSON.stringify(again.input)],
    );
    assertEquals(await o.runner.run(again), { kind: "pending" });
    const read = async () => {
      const response = await api(
        o.fixture,
        o.fixture.cookie,
        "GET",
        `/v1/runs/${o.run.runId}/requests`,
      );
      return ((await response.json()) as { requests: { nextAsk: unknown }[] })
        .requests[0]!.nextAsk;
    };
    assertEquals(await read(), null);
    await o.fixture.pgDatabase.query(
      `insert into bakery.organization_group_members
         (organization_id, group_id, principal_id)
       values ($1, $2, $3)`,
      [o.fixture.organizationId, groupId, o.next.principalId],
    );
    assert(await read() !== null);
  } finally {
    await o.finishAll();
  }
});

Deno.test("a step whose first and next asks both run out needs a person and records every request expired", async () => {
  const o = await openWithNextPerson();
  try {
    assertEquals(await o.runner.run(o.request), { kind: "pending" });
    await o.askedAgo(25);
    assertEquals(await o.runner.run(o.request), { kind: "pending" });
    await o.fixture.pgDatabase.query(
      `update bakery.person_requests set expires_at = now() - interval '1 minute'
        where organization_id = $1 and run_id = $2`,
      [o.fixture.organizationId, o.run.runId],
    );
    assertEquals(await o.runner.run(o.request), {
      kind: "needs_human",
      output: { outcome: "expired", asked: 2 },
    });
    assertEquals(
      (await o.tags()).map((tag) => tag.status),
      ["expired", "expired"],
    );
  } finally {
    await o.finishAll();
  }
});

async function seedGroup(
  fixture: Awaited<ReturnType<typeof open>>["fixture"],
  members: readonly string[],
): Promise<string> {
  const groupId = crypto.randomUUID();
  const name = `next-${groupId.slice(0, 8)}`;
  await fixture.pgDatabase.query(
    `insert into bakery.organization_groups
       (id, organization_id, name, mention_name)
     values ($1, $2, $3, $3)`,
    [groupId, fixture.organizationId, name],
  );
  for (const principalId of members) {
    await fixture.pgDatabase.query(
      `insert into bakery.organization_group_members
         (organization_id, group_id, principal_id)
       values ($1, $2, $3)`,
      [fixture.organizationId, groupId, principalId],
    );
  }
  return groupId;
}

async function pollsAfterTheNextAsk(
  o: Awaited<ReturnType<typeof openWithNextPerson>>,
  ifNobodyAnswers: Record<string, unknown>,
  firstAsk: Record<string, unknown> = { recipientId: o.guest.principalId },
) {
  const request = o.step({
    intent: "review",
    ...firstAsk,
    artifactVersionId: o.version,
    wait: true,
    ifNobodyAnswers: { afterHours: 1, ...ifNobodyAnswers },
  });
  assertEquals(await o.runner.run(request), { kind: "pending" });
  await o.askedAgo(2);
  assertEquals(await o.runner.run(request), { kind: "pending" });
  const afterNextAsk = [await o.tags(), await o.ledgerKinds()];
  for (let poll = 0; poll < 3; poll++) {
    assertEquals(await o.runner.run(request), { kind: "pending" });
  }
  assertEquals([await o.tags(), await o.ledgerKinds()], afterNextAsk);
  const marks = await o.fixture.pgDatabase.query(
    `select 1 from bakery.person_request_next_asks
      where organization_id = $1 and run_id = $2`,
    [o.fixture.organizationId, o.run.runId],
  );
  assertEquals(marks.rows.length, 1);
}

Deno.test("a next ask that only reaches someone already asked is made once, not every minute", async () => {
  const o = await openWithNextPerson();
  try {
    const groupId = await seedGroup(o.fixture, [o.guest.principalId]);
    await pollsAfterTheNextAsk(o, { recipientGroupId: groupId });
    assertEquals((await o.tags()).length, 1);
  } finally {
    await o.finishAll();
  }
});

Deno.test("a next ask that falls back to the run's owner is made once, not every minute", async () => {
  const o = await openWithNextPerson();
  try {
    await pollsAfterTheNextAsk(
      o,
      { recipientId: crypto.randomUUID() },
      { recipientRunRole: "starter" },
    );
  } finally {
    await o.finishAll();
  }
});

Deno.test("asking someone next needs a waiting step and exactly one person", async () => {
  const o = await openWithNextPerson();
  try {
    const base = {
      intent: "review",
      recipientId: o.guest.principalId,
      artifactVersionId: o.version,
    };
    for (
      const input of [
        { ...base, ifNobodyAnswers: { recipientId: o.next.principalId } },
        {
          ...base,
          wait: true,
          ifNobodyAnswers: {
            recipientId: o.next.principalId,
            recipientRunRole: "starter",
          },
        },
        { ...base, wait: true, ifNobodyAnswers: {} },
        {
          ...base,
          wait: true,
          ifNobodyAnswers: { afterHours: 73, recipientId: o.next.principalId },
        },
        {
          ...base,
          wait: true,
          ifNobodyAnswers: { afterHours: 0, recipientId: o.next.principalId },
        },
      ]
    ) {
      const result = await o.runner.run(o.step(input));
      assertEquals(result.kind, "failed");
      assertEquals(
        result.kind === "failed" ? result.code : null,
        "TAG_INPUT_INVALID",
      );
    }
    assertEquals(await o.tags(), []);
  } finally {
    await o.finishAll();
  }
});

Deno.test("a Notify step that cannot tag fails with a fixed code and tags nobody", async () => {
  const o = await open();
  try {
    const code = async (request: EngineStepRequest) => {
      const result = await o.runner.run(request);
      assertEquals(result.kind, "failed", JSON.stringify(result));
      return result.kind === "failed" ? [result.code, result.message] : [];
    };
    const [missing, why] = await code(
      o.step({ intent: "review", recipientId: o.guest.principalId }),
    );
    assertEquals(missing, "TAG_REFUSED");
    assert(why.includes("request_artifact_version_required"), why);
    assertEquals(
      (await code(o.step(
        { intent: "fyi", recipientId: o.guest.principalId },
        { requestedBy: o.viewer.principalId },
      )))[0],
      "TAG_ACTOR_UNAVAILABLE",
    );
    assertEquals(
      (await code(o.step(
        { intent: "fyi", recipientId: o.guest.principalId },
        { stepKey: "nowhere" },
      )))[0],
      "TAG_STEP_UNKNOWN",
    );
    assertEquals(await o.tags(), []);
  } finally {
    await o.finish();
  }
});

Deno.test("a plain second ask on a step that names someone next is not read as passed on", async () => {
  const o = await openWithNextPerson();
  try {
    await o.fixture.pgDatabase.query(
      `update bakery.run_steps set input = $3::jsonb
        where organization_id = $1 and run_id = $2 and step_key = 'notify'`,
      [o.fixture.organizationId, o.run.runId, JSON.stringify(o.request.input)],
    );
    assertEquals(await o.runner.run(o.request), { kind: "pending" });
    await o.fixture.pgDatabase.query(
      `insert into bakery.person_requests
         (organization_id, run_id, task_id, step_key, step_iteration, intent,
          recipient_id, asked_by, asked_by_kind, expires_at, created_at)
       values ($1, $2, $3, 'notify', 0, 'review', $4, $5, 'person',
         now() + interval '7 days', now() + interval '1 minute')`,
      [
        o.fixture.organizationId,
        o.run.runId,
        o.run.taskId,
        o.next.principalId,
        o.fixture.principalId,
      ],
    );
    const response = await api(
      o.fixture,
      o.fixture.cookie,
      "GET",
      `/v1/runs/${o.run.runId}/requests`,
    );
    assertEquals(response.status, 200);
    const body = await response.json() as {
      requests: {
        recipient: { principalId: string };
        nextAsk: unknown;
        passedOn: boolean;
      }[];
    };
    const second = body.requests.find((request) =>
      request.recipient.principalId === o.next.principalId
    )!;
    assertEquals(second.passedOn, false);
    assertEquals(second.nextAsk, null);
    const claims = await o.fixture.pgDatabase.query(
      "select 1 from bakery.person_request_next_asks where run_id = $1",
      [o.run.runId],
    );
    assertEquals(claims.rows.length, 0);
  } finally {
    await o.finishAll();
  }
});
