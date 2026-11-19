import { assertEquals } from "@std/assert";
import { cleanupAuthFixture } from "../helpers/auth.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";
import {
  addMember,
  api,
  seedOtherTask,
  seedRun,
} from "../helpers/run-requests.ts";

/**
 * #456 slice 1, security: a run access grant lets a person see exactly one run,
 * its steps and its task, and nothing else. A grant-holder here is a bare Guest,
 * who holds no permission of their own, so every refusal below is the gate
 * closing, and every success is the grant. Real resources are used wherever
 * possible, so a gate that wrongly opened would answer 200 or a handler error
 * rather than the same 404 a missing id gives.
 */

async function open() {
  const fixture = await openSocketFixture();
  const guest = await addMember(fixture, "Grantee", "guest");
  const stranger = await addMember(fixture, "Stranger", "guest");
  const granted = await seedRun(fixture);
  // Another run of the SAME task, and a run of ANOTHER task.
  const sameTask = await seedRun(fixture, granted.taskId);
  const otherTaskId = await seedOtherTask(fixture);
  const otherTask = await seedRun(fixture, otherTaskId);
  const ask = await api(
    fixture,
    fixture.cookie,
    "POST",
    `/v1/runs/${granted.runId}/requests`,
    { recipientId: guest.principalId, intent: "fyi" },
  );
  assertEquals(ask.status, 201, await ask.text());
  return {
    fixture,
    guest,
    stranger,
    granted,
    sameTask,
    otherTask,
    get: (cookie: string, path: string) => api(fixture, cookie, "GET", path),
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

Deno.test("a grant reads exactly the run, its steps and its task", async () => {
  const o = await open();
  try {
    const status = async (path: string) =>
      (await o.get(o.guest.cookie, path)).status;
    assertEquals(await status(`/v1/runs/${o.granted.runId}`), 200);
    assertEquals(await status(`/v1/runs/${o.granted.runId}/steps`), 200);
    assertEquals(await status(`/v1/tasks/${o.granted.taskId}`), 200);
  } finally {
    await o.finish();
  }
});

Deno.test("a grant reaches no other run, task or person", async () => {
  const o = await open();
  try {
    const denied = async (cookie: string, path: string) =>
      assertEquals((await o.get(cookie, path)).status, 404, path);
    // Another run of the same task is not the granted run.
    await denied(o.guest.cookie, `/v1/runs/${o.sameTask.runId}`);
    await denied(o.guest.cookie, `/v1/runs/${o.sameTask.runId}/steps`);
    // A run and a task elsewhere.
    await denied(o.guest.cookie, `/v1/runs/${o.otherTask.runId}`);
    await denied(o.guest.cookie, `/v1/tasks/${o.otherTask.taskId}`);
    // Someone who was not asked holds nothing, even for the granted run.
    await denied(o.stranger.cookie, `/v1/runs/${o.granted.runId}`);
    await denied(o.stranger.cookie, `/v1/runs/${o.granted.runId}/steps`);
    await denied(o.stranger.cookie, `/v1/tasks/${o.granted.taskId}`);
  } finally {
    await o.finish();
  }
});

Deno.test("a grant ends when access is removed, and the asked person loses the run at once", async () => {
  const o = await open();
  try {
    const path = `/v1/runs/${o.granted.runId}`;
    assertEquals((await o.get(o.guest.cookie, path)).status, 200);
    await o.fixture.pgDatabase.query(
      `update bakery.run_access_grants set revoked_at = now()
        where organization_id = $1 and principal_id = $2`,
      [o.fixture.organizationId, o.guest.principalId],
    );
    assertEquals((await o.get(o.guest.cookie, path)).status, 404);
    assertEquals(
      (await o.get(o.guest.cookie, `${path}/steps`)).status,
      404,
    );
    assertEquals(
      (await o.get(o.guest.cookie, `/v1/tasks/${o.granted.taskId}`)).status,
      404,
    );
  } finally {
    await o.finish();
  }
});

Deno.test("a grant-holder cannot do anything with the run they can see", async () => {
  const o = await open();
  try {
    const run = o.granted.runId;
    const task = o.granted.taskId;
    const cookie = o.guest.cookie;
    const refused = async (
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: string,
      body?: unknown,
    ) =>
      assertEquals(
        (await api(o.fixture, cookie, method, path, body, 1)).status,
        404,
        `${method} ${path}`,
      );
    // Lists, which a grant must never widen into a view of everything.
    await refused("GET", "/v1/tasks");
    await refused("GET", `/v1/tasks/${task}/runs`);
    const step = await o.fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.run_steps where organization_id = $1 and run_id = $2`,
      [o.fixture.organizationId, run],
    );
    await refused("GET", `/v1/sessions?runStepId=${step.rows[0].id}`);
    await refused("GET", "/v1/approvals");
    await refused("GET", "/v1/questions");
    await refused("GET", "/v1/artifacts");
    // The task's conversation and everything said in it.
    await refused("GET", `/v1/conversations/${o.fixture.conversationId}`);
    await refused(
      "GET",
      `/v1/conversations/${o.fixture.conversationId}/messages`,
    );
    // Controls, steers, notes and takeover.
    await refused("POST", `/v1/runs/${run}/controls`, { action: "cancel" });
    await refused("POST", `/v1/runs/${run}/retries`, {});
    await refused("POST", `/v1/runs/${run}/steps/build/notes`, {
      body: "hello",
    });
    await refused("POST", `/v1/runs/${run}/steps/build/takeover`, {
      mode: "restart",
    });
    // Changing the task or starting more work on it.
    await refused("PATCH", `/v1/tasks/${task}`, { title: "Renamed" });
    await refused("POST", `/v1/tasks/${task}/runs`, {
      executionMode: "cloud_only",
    });
    // Asking others in, which needs to be able to share the run.
    await refused("POST", `/v1/runs/${run}/requests`, {
      recipientId: o.stranger.principalId,
      intent: "fyi",
    });
    await refused("GET", `/v1/runs/${run}/requests`);
    // Nothing above changed the run or the task.
    const state = await o.fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.workflow_runs where id = $1`,
      [run],
    );
    assertEquals(state.rows[0].status, "running");
    const asked = await o.fixture.pgDatabase.query(
      `select 1 from bakery.run_access_grants
        where organization_id = $1 and principal_id = $2`,
      [o.fixture.organizationId, o.stranger.principalId],
    );
    assertEquals(asked.rows.length, 0);
  } finally {
    await o.finish();
  }
});
