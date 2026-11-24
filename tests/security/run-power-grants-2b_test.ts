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
    assertEquals(await note(o.guest.cookie, o.run.runId, "build"), 404);
    assertEquals(await steer(o.guest.cookie, o.buildSession), 404);
    const made = await o.ask({ intent: "take_over", stepKey: "build" });
    assertEquals(made.status, 201, await made.clone().text());
    for (
      const status of [
        await note(o.guest.cookie, o.run.runId, "build"),
        await steer(o.guest.cookie, o.buildSession),
        await takeover(o.guest.cookie, o.run.runId, "build"),
      ]
    ) {
      assertNotEquals(status, 404);
      assertNotEquals(status, 403);
    }
    assertEquals(await steer(o.guest.cookie, o.buildSession), 404);
    assertEquals(await note(o.guest.cookie, o.run.runId, "other"), 404);
    assertEquals(await takeover(o.guest.cookie, o.run.runId, "other"), 404);
    assertEquals(await steer(o.guest.cookie, o.otherSession), 404);
    assertEquals(await note(o.guest.cookie, o.sibling.runId, "build"), 404);
    assertEquals(await steer(o.guest.cookie, o.siblingSession), 404);
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
    assertEquals(await comment(o.guest.cookie, o.mine), 201);
    for (const version of [o.siblingVersion, o.runless]) {
      assertEquals(await comment(o.guest.cookie, version), 404, version);
    }
    assertEquals(await comment(o.stranger.cookie, o.mine), 404);
    const mineList = await (await api(
      o.fixture,
      o.guest.cookie,
      "GET",
      `/v1/runs/${o.run.runId}/requests/mine`,
    )).json() as { requests: { status: string }[] };
    assertEquals(mineList.requests.map((r) => r.status), ["handled"]);
    assertEquals(await comment(o.guest.cookie, o.mine), 404);
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
    assertEquals(await bodies(o.guest.cookie, o.buildSession), [
      "build output",
    ]);
    assertEquals(await bodies(o.guest.cookie, o.otherSession), [
      "other output",
    ]);
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
    await o.fixture.pgDatabase.query(
      `update bakery.run_access_grants set revoked_at = now()
        where organization_id = $1 and run_id = $2 and principal_id = $3`,
      [o.fixture.organizationId, o.run.runId, o.guest.principalId],
    );
    assertEquals(
      await o.as(o.guest.cookie, "GET", `/v1/sessions/${o.buildSession}/feed`),
      404,
    );
    const all = await bodies(developer.cookie, o.buildSession);
    assertEquals(all.includes("private team chat"), true);
    assertEquals(all.includes("build output"), true);
    assertEquals(all.includes("sibling output"), true);
  } finally {
    await cleanupAuthFixture(o.fixture.pgDatabase, [developer.email]);
    await o.finish();
  }
});

Deno.test("one member's review or take-over ends the whole group's ask and its powers", async () => {
  const o = await open();
  try {
    const askGuests = (payload: Record<string, unknown>) =>
      api(
        o.fixture,
        o.fixture.cookie,
        "POST",
        `/v1/runs/${o.run.runId}/requests`,
        { recipientRoleKey: "guest", ...payload },
      );
    const statusOf = async (principalId: string, intent: string) =>
      (await o.fixture.pgDatabase.query<{ status: string }>(
        `select status from bakery.person_requests
          where organization_id = $1 and recipient_id = $2 and intent = $3`,
        [o.fixture.organizationId, principalId, intent],
      )).rows.map((row) => row.status);
    const reviewAsk = await askGuests({
      intent: "review",
      artifactVersionId: o.mine,
    });
    assertEquals(reviewAsk.status, 201, await reviewAsk.text());
    const comment = (cookie: string) =>
      o.as(cookie, "POST", `/v1/artifact-versions/${o.mine}/comments`, {
        body: "Reviewed.",
      });
    assertEquals(await comment(o.guest.cookie), 201);
    assertEquals(await statusOf(o.stranger.principalId, "review"), [
      "handled",
    ]);
    assertEquals(await comment(o.stranger.cookie), 404);

    const takeAsk = await askGuests({ intent: "take_over", stepKey: "build" });
    assertEquals(takeAsk.status, 201, await takeAsk.text());
    const takeover = await o.as(
      o.guest.cookie,
      "POST",
      `/v1/runs/${o.run.runId}/steps/build/takeover`,
      { mode: "restart" },
    );
    assertNotEquals(takeover, 404);
    assertNotEquals(takeover, 403);
    assertEquals(await statusOf(o.stranger.principalId, "take_over"), [
      "handled",
    ]);
    assertEquals(
      await o.as(
        o.stranger.cookie,
        "POST",
        `/v1/sessions/${o.buildSession}/messages`,
        { body: "Mine now." },
      ),
      404,
    );
  } finally {
    await o.finish();
  }
});

Deno.test("a Viewer asked to take over can read the session it may steer", async () => {
  const o = await open();
  const viewer = await addMember(o.fixture, "Viewer", "viewer");
  try {
    const feed = () =>
      o.as(viewer.cookie, "GET", `/v1/sessions/${o.buildSession}/feed`);
    assertEquals(await feed(), 404);
    const made = await o.ask({
      recipientId: viewer.principalId,
      intent: "take_over",
      stepKey: "build",
    });
    assertEquals(made.status, 201, await made.text());
    assertEquals(await feed(), 200);
  } finally {
    await cleanupAuthFixture(o.fixture.pgDatabase, [viewer.email]);
    await o.finish();
  }
});

Deno.test("an observer's feed shows the steers sent to that session", async () => {
  const o = await open();
  try {
    assertEquals(
      (await o.ask({ intent: "take_over", stepKey: "build" })).status,
      201,
    );
    const steer = async (sessionId: string, authorId: string, body: string) => {
      const messageId = crypto.randomUUID();
      await o.fixture.pgDatabase.query(
        `insert into bakery.messages (
           id, organization_id, conversation_id, author_id, message_type, body,
           client_message_id, sequence, intent)
         select $1, $2, $3, $4, 'user', $5, $6,
                coalesce((select max(sequence) from bakery.messages
                           where conversation_id = $3), 0) + 1, 'discussion'`,
        [
          messageId,
          o.fixture.organizationId,
          o.fixture.conversationId,
          authorId,
          body,
          crypto.randomUUID(),
        ],
      );
      await o.fixture.pgDatabase.query(
        `insert into bakery.decisions_ledger
           (organization_id, task_id, run_id, kind, subject_kind, subject_id,
            decided_by, text, detail)
         values ($1, $2, $3, 'steer', 'session', $4, $5, $6, $7::jsonb)`,
        [
          o.fixture.organizationId,
          o.run.taskId,
          o.run.runId,
          sessionId,
          authorId,
          body,
          JSON.stringify({ mode: "steer", messageId, truncated: false }),
        ],
      );
    };
    await steer(o.buildSession, o.guest.principalId, "my steer");
    await steer(o.buildSession, o.fixture.principalId, "owner steer");
    await steer(o.otherSession, o.fixture.principalId, "elsewhere");
    const response = await api(
      o.fixture,
      o.guest.cookie,
      "GET",
      `/v1/sessions/${o.buildSession}/feed`,
    );
    assertEquals(response.status, 200, await response.clone().text());
    const page = await response.json() as {
      items: { message: { body: string } | null }[];
    };
    assertEquals(page.items.map((item) => item.message?.body).sort(), [
      "my steer",
      "owner steer",
    ]);
  } finally {
    await o.finish();
  }
});
