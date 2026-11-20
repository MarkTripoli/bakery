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
      // A comment on an artifact version keeps the version from being deleted.
      await fixture.pgDatabase.query(
        "delete from bakery.artifact_comments where organization_id = $1",
        [fixture.organizationId],
      );
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

Deno.test("an observer reads only the granted session's own messages, never the task's whole conversation", async () => {
  const o = await open();
  const developer = await addMember(o.fixture, "Dev", "developer");
  try {
    const say = (
      sessionId: string | null,
      authorId: string | null,
      body: string,
    ) =>
      o.fixture.pgDatabase.query(
        `insert into bakery.messages (
           id, organization_id, conversation_id, author_id, agent_session_id,
           message_type, body, client_message_id, sequence, intent)
         select $1, $2, $3, $4, $5, $6, $7, $8,
                coalesce((select max(sequence) from bakery.messages
                           where conversation_id = $3), 0) + 1, 'note'`,
        [
          crypto.randomUUID(),
          o.fixture.organizationId,
          o.fixture.conversationId,
          authorId,
          sessionId,
          sessionId === null ? "user" : "assistant",
          body,
          crypto.randomUUID(),
        ],
      );
    await say(null, o.fixture.principalId, "private team chat");
    await say(o.buildSession, null, "build output");
    await say(o.otherSession, null, "other output");
    await say(o.siblingSession, null, "sibling output");
    // The guest is asked to just look: that gives the run to see, not the chat.
    assertEquals(
      (await o.ask({ intent: "fyi" })).status,
      201,
    );
    const bodies = async (cookie: string, session: string) => {
      const response = await api(
        o.fixture,
        cookie,
        "GET",
        `/v1/sessions/${session}/feed`,
      );
      assertEquals(response.status, 200, await response.clone().text());
      const page = await response.json() as {
        items: { message: { body: string } | null }[];
      };
      return page.items.map((item) => item.message?.body).sort();
    };
    // Only the session's own messages: not the person's chat, not another
    // session's output, not another run's.
    assertEquals(await bodies(o.guest.cookie, o.buildSession), [
      "build output",
    ]);
    assertEquals(await bodies(o.guest.cookie, o.otherSession), [
      "other output",
    ]);
    // A session of another run is not theirs at all.
    assertEquals(
      await o.as(
        o.guest.cookie,
        "GET",
        `/v1/sessions/${o.siblingSession}/feed`,
      ),
      404,
    );
    assertEquals(
      await o.as(
        o.stranger.cookie,
        "GET",
        `/v1/sessions/${o.buildSession}/feed`,
      ),
      404,
    );
    // Removing the observer's access takes the feed away at once.
    await o.fixture.pgDatabase.query(
      `update bakery.run_access_grants set revoked_at = now()
        where organization_id = $1 and run_id = $2 and principal_id = $3`,
      [o.fixture.organizationId, o.run.runId, o.guest.principalId],
    );
    assertEquals(
      await o.as(o.guest.cookie, "GET", `/v1/sessions/${o.buildSession}/feed`),
      404,
    );
    // Someone with standing access sees what they always saw: the whole
    // conversation, unchanged.
    const all = await bodies(developer.cookie, o.buildSession);
    assertEquals(all.includes("private team chat"), true);
    assertEquals(all.includes("build output"), true);
    assertEquals(all.includes("sibling output"), true);
  } finally {
    await cleanupAuthFixture(o.fixture.pgDatabase, [developer.email]);
    await o.finish();
  }
});
