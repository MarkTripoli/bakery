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

Deno.test("a waiting step whose request expires completes expired, never approved", async () => {
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
      kind: "completed",
      output: { outcome: "expired", asked: 1 },
    });
  } finally {
    await o.finish();
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
