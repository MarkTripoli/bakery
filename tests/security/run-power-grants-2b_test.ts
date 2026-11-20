import { assertEquals, assertNotEquals } from "@std/assert";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";
import {
  addMember,
  api,
  seedAgentSession,
  seedArtifactVersion,
  seedOtherTask,
  seedRun,
  seedStep,
} from "../helpers/run-requests.ts";

/**
 * #456 slice 2b, security: a person asked to take over a step may steer, note
 * and take over that one step and nothing else; a person asked to review may
 * comment on that one artifact version and nothing else. The grantee is a bare
 * Guest, so every refusal is the gate closing and every success is the grant.
 * A refusal answers the same 404 a missing id gives; reaching the handler's own
 * state check (a 409 here) or a created answer means the gate let it through.
 */

async function open() {
  const fixture = await openSocketFixture();
  const guest = await addMember(fixture, "Grantee", "guest");
  const stranger = await addMember(fixture, "Stranger", "guest");
  const run = await seedRun(fixture);
  await seedStep(fixture, run, "other");
  const buildSession = await seedAgentSession(fixture, run, "build");
  const otherSession = await seedAgentSession(fixture, run, "other");
  const sibling = await seedRun(fixture, await seedOtherTask(fixture));
  const siblingSession = await seedAgentSession(fixture, sibling, "build");
  const mine = await seedArtifactVersion(fixture, run.taskId, run.runId);
  const siblingVersion = await seedArtifactVersion(
    fixture,
    sibling.taskId,
    sibling.runId,
  );
  const runless = await seedArtifactVersion(fixture, run.taskId, null);
  const ask = (payload: Record<string, unknown>) =>
    api(fixture, fixture.cookie, "POST", `/v1/runs/${run.runId}/requests`, {
      recipientId: guest.principalId,
      ...payload,
    });
  const as = (
    cookie: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) => api(fixture, cookie, method, path, body).then((r) => r.status);
  return {
    fixture,
    guest,
    stranger,
    run,
    sibling,
    buildSession,
    otherSession,
    siblingSession,
    mine,
    siblingVersion,
    runless,
    ask,
    as,
    finish: async () => {
      await cleanupAuthFixture(fixture.pgDatabase, [
        fixture.email,
        guest.email,
        stranger.email,
      ]);
      await fixture.close();
    },
  };
}

Deno.test("a take-over power reaches exactly its one step and its session", async () => {
  const o = await open();
  try {
    const note = (cookie: string, runId: string, step: string) =>
      o.as(cookie, "POST", `/v1/runs/${runId}/steps/${step}/notes`, {
        body: "Look at this.",
      });
    const takeover = (cookie: string, runId: string, step: string) =>
      o.as(cookie, "POST", `/v1/runs/${runId}/steps/${step}/takeover`, {
        mode: "restart",
      });
    const steer = (cookie: string, session: string) =>
      o.as(cookie, "POST", `/v1/sessions/${session}/messages`, {
        body: "Try the other way.",
      });
    // Before the request the guest has nothing.
    assertEquals(await note(o.guest.cookie, o.run.runId, "build"), 404);
    assertEquals(await steer(o.guest.cookie, o.buildSession), 404);
    // Asking to take over a step needs that step named.
    const made = await o.ask({ intent: "take_over", stepKey: "build" });
    assertEquals(made.status, 201, await made.clone().text());
    // The granted step and its session pass the gate: the answer is the
    // handler's own, never the gate's 404 or 403.
    for (
      const status of [
        await note(o.guest.cookie, o.run.runId, "build"),
        await takeover(o.guest.cookie, o.run.runId, "build"),
        await steer(o.guest.cookie, o.buildSession),
      ]
    ) {
      assertNotEquals(status, 404);
      assertNotEquals(status, 403);
    }
    // Not the other step of the same run, nor its session, nor another run's.
    assertEquals(await note(o.guest.cookie, o.run.runId, "other"), 404);
    assertEquals(await takeover(o.guest.cookie, o.run.runId, "other"), 404);
    assertEquals(await steer(o.guest.cookie, o.otherSession), 404);
    assertEquals(await note(o.guest.cookie, o.sibling.runId, "build"), 404);
    assertEquals(await steer(o.guest.cookie, o.siblingSession), 404);
    // Nobody else gains anything from it.
    assertEquals(await note(o.stranger.cookie, o.run.runId, "build"), 404);
    assertEquals(await steer(o.stranger.cookie, o.buildSession), 404);
  } finally {
    await o.finish();
  }
});

Deno.test("a take-over power is not a review or approve power", async () => {
  const o = await open();
  try {
    assertEquals(
      (await o.ask({ intent: "take_over", stepKey: "build" })).status,
      201,
    );
    assertEquals(
      await o.as(
        o.guest.cookie,
        "POST",
        `/v1/artifact-versions/${o.mine}/comments`,
        { body: "Nice." },
      ),
      404,
    );
  } finally {
    await o.finish();
  }
});

Deno.test("a review power comments on exactly its one artifact version", async () => {
  const o = await open();
  try {
    const comment = (cookie: string, version: string) =>
      o.as(cookie, "POST", `/v1/artifact-versions/${version}/comments`, {
        body: "Looks right to me.",
      });
    assertEquals(await comment(o.guest.cookie, o.mine), 404);
    const made = await o.ask({ intent: "review", artifactVersionId: o.mine });
    assertEquals(made.status, 201, await made.clone().text());
    const request = await made.json() as {
      id: string;
      artifactVersionId: string | null;
      questionId: string | null;
    };
    assertEquals(request.artifactVersionId, o.mine);
    assertEquals(request.questionId, null);
    // It comments on that version...
    assertEquals(await comment(o.guest.cookie, o.mine), 201);
    // ...and on no other: not another run's, not one no run produced.
    for (const version of [o.siblingVersion, o.runless]) {
      assertEquals(await comment(o.guest.cookie, version), 404, version);
    }
    assertEquals(await comment(o.stranger.cookie, o.mine), 404);
    // The comment handled the request; the right stays for more comments.
    const mineList = await (await api(
      o.fixture,
      o.guest.cookie,
      "GET",
      `/v1/runs/${o.run.runId}/requests/mine`,
    )).json() as { requests: { status: string }[] };
    assertEquals(mineList.requests.map((r) => r.status), ["handled"]);
    assertEquals(await comment(o.guest.cookie, o.mine), 201);
  } finally {
    await o.finish();
  }
});
