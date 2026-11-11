import { assert, assertEquals, assertThrows } from "@std/assert";
import { openAuthFixture } from "../helpers/auth.ts";
import {
  call,
  cleanupSeededOrganizations,
  type Fixture,
  seedOrganization,
  sendMessage,
} from "../helpers/coordinator-turns.ts";
import {
  readCoordinatorExecutor,
  SCRIPTED_COORDINATOR_DIR_ENV,
} from "../../apps/server/src/modules/conversation/coordinator.ts";

async function withFixture(work: (fixture: Fixture) => Promise<void>) {
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

Deno.test("a foreign tenant cannot read, list or cancel another tenant's conversations and turns", () =>
  withFixture(async (fixture) => {
    const owner = await seedOrganization(fixture, "owner");
    const foreign = await seedOrganization(fixture, "foreign");
    await sendMessage(fixture, owner, "agent_request", "private");
    const turn =
      (await fixture.pgDatabase.query<{ id: string; version: number }>(
        `select id, version from bakery.conversation_turns where conversation_id = $1`,
        [owner.conversationId],
      )).rows[0];

    // Foreign principal addressing the owner organization has no membership there.
    const crossOrg = { ...foreign, organizationId: owner.organizationId };
    for (
      const path of [
        `/v1/conversations/${owner.conversationId}`,
        `/v1/conversation-turns/${turn.id}`,
      ]
    ) {
      assertEquals((await call(fixture, crossOrg, path)).status, 404);
    }
    // Foreign principal in its own organization cannot see the owner's resources.
    for (
      const path of [
        `/v1/conversations/${owner.conversationId}`,
        `/v1/conversation-turns/${turn.id}`,
      ]
    ) {
      assertEquals((await call(fixture, foreign, path)).status, 404);
    }
    const cancel = await call(
      fixture,
      foreign,
      `/v1/conversation-turns/${turn.id}/cancel`,
      {
        method: "POST",
        ifMatch: turn.version,
      },
    );
    assertEquals(cancel.status, 404);
    const listed = await call(fixture, foreign, "/v1/conversations");
    const ids = ((await listed.json()) as { items: { id: string }[] }).items
      .map((c) => c.id);
    assert(!ids.includes(owner.conversationId));
    const state = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.conversation_turns where id = $1`,
      [turn.id],
    );
    assertEquals(state.rows[0].status, "queued");
  }));

Deno.test("viewers cannot create or edit conversations or cancel turns", () =>
  withFixture(async (fixture) => {
    const owner = await seedOrganization(fixture, "ro", { role: "viewer" });
    const created = await call(fixture, owner, "/v1/conversations", {
      method: "POST",
      body: { title: "nope" },
    });
    assertEquals(created.status, 403);
    const read0 = await call(
      fixture,
      owner,
      `/v1/conversations/${owner.conversationId}`,
    );
    const version = ((await read0.json()) as { version: number }).version;
    const edited = await call(
      fixture,
      owner,
      `/v1/conversations/${owner.conversationId}`,
      { method: "PATCH", ifMatch: version, body: { title: "nope" } },
    );
    assertEquals(edited.status, 403);
    const turnId = crypto.randomUUID();
    const canceled = await call(
      fixture,
      owner,
      `/v1/conversation-turns/${turnId}/cancel`,
      { method: "POST", body: {} },
    );
    assertEquals(canceled.status, 403);
    const read = await call(
      fixture,
      owner,
      `/v1/conversations/${owner.conversationId}`,
    );
    assertEquals(read.status, 200);
  }));

Deno.test("the application role can move turns through lifecycle columns only", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "grants");
    await sendMessage(fixture, seed, "agent_request", "grants");
    const turn = (await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.conversation_turns where conversation_id = $1`,
      [seed.conversationId],
    )).rows[0];
    await fixture.runtimePgDatabase.query(
      `update bakery.conversation_turns set lease_expires_at = now() where id = $1`,
      [turn.id],
    );
    for (
      const column of [
        "context_through_sequence = 99",
        "trigger_message_id = gen_random_uuid()",
        "agent_version_id = null",
        "organization_id = gen_random_uuid()",
      ]
    ) {
      let denied = false;
      try {
        await fixture.runtimePgDatabase.query(
          `update bakery.conversation_turns set ${column} where id = $1`,
          [turn.id],
        );
      } catch {
        denied = true;
      }
      assert(denied, `${column} must be denied to bakery_app`);
    }
  }));

Deno.test("the scripted coordinator is honored only in the test environment", () => {
  const script = { [SCRIPTED_COORDINATOR_DIR_ENV]: "/tmp/scripted" };
  for (const environment of ["development", "production", undefined]) {
    assertThrows(
      () => readCoordinatorExecutor({ ...script, BAKERY_ENV: environment }),
      Error,
      `${SCRIPTED_COORDINATOR_DIR_ENV}_TEST_ONLY`,
    );
  }
  assertEquals(
    readCoordinatorExecutor({ ...script, BAKERY_ENV: "test" }).kind,
    "scripted",
  );
  assertThrows(
    () =>
      readCoordinatorExecutor({
        BAKERY_ENV: "test",
        [SCRIPTED_COORDINATOR_DIR_ENV]: "relative/scripts",
      }),
    Error,
    `${SCRIPTED_COORDINATOR_DIR_ENV}_ABSOLUTE_PATH_REQUIRED`,
  );
  assertThrows(
    () =>
      readCoordinatorExecutor({
        ...script,
        BAKERY_ENV: "test",
        BAKERY_COORDINATOR_EXECUTOR: "worker",
      }),
    Error,
    "BAKERY_COORDINATOR_EXECUTOR_CONFLICTS_WITH_SCRIPT",
  );
});

Deno.test("executor selection: production with a database uses the worker, test and bare stacks stay unavailable, bogus values throw", async () => {
  const fixture = await openAuthFixture();
  try {
    const deps = { database: fixture.runtimePgDatabase };
    for (const environment of ["production", "development", undefined]) {
      assertEquals(
        readCoordinatorExecutor({ BAKERY_ENV: environment }, deps).kind,
        "worker",
        `${environment} with a database`,
      );
      assertEquals(
        readCoordinatorExecutor({ BAKERY_ENV: environment }).kind,
        "unavailable",
        `${environment} without a database`,
      );
    }
    assertEquals(
      readCoordinatorExecutor({ BAKERY_ENV: "test" }, deps).kind,
      "unavailable",
    );
    assertEquals(
      readCoordinatorExecutor({
        BAKERY_ENV: "test",
        BAKERY_COORDINATOR_EXECUTOR: "worker",
      }, deps).kind,
      "worker",
    );
    assertEquals(
      readCoordinatorExecutor({
        BAKERY_ENV: "production",
        BAKERY_COORDINATOR_EXECUTOR: "unavailable",
      }, deps).kind,
      "unavailable",
    );
    assertThrows(
      () =>
        readCoordinatorExecutor({
          BAKERY_ENV: "production",
          BAKERY_COORDINATOR_EXECUTOR: "bogus",
        }, deps),
      Error,
      "BAKERY_COORDINATOR_EXECUTOR_INVALID",
    );
    assertThrows(
      () =>
        readCoordinatorExecutor({
          BAKERY_ENV: "production",
          BAKERY_COORDINATOR_EXECUTOR: "worker",
        }),
      Error,
      "BAKERY_COORDINATOR_EXECUTOR_WORKER_REQUIRES_DATABASE",
    );
    for (
      const [name, value, code] of [
        ["BAKERY_COORDINATOR_CLAIM_TIMEOUT_MS", "abc", "_INVALID"],
        ["BAKERY_COORDINATOR_CLAIM_TIMEOUT_MS", "10", "_INVALID"],
        ["BAKERY_COORDINATOR_TURN_TIMEOUT_MS", "99999999999", "_INVALID"],
      ] as const
    ) {
      assertThrows(
        () =>
          readCoordinatorExecutor(
            { BAKERY_ENV: "production", [name]: value },
            deps,
          ),
        Error,
        `${name}${code}`,
      );
    }
    assertThrows(
      () =>
        readCoordinatorExecutor({
          BAKERY_ENV: "production",
          BAKERY_COORDINATOR_CLAIM_TIMEOUT_MS: "300000",
          BAKERY_COORDINATOR_TURN_TIMEOUT_MS: "300000",
        }, deps),
      Error,
      "BAKERY_COORDINATOR_TIMEOUTS_INVALID",
    );
  } finally {
    await fixture.close();
  }
});
