import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { createTaskQueryHandlers } from "../../apps/server/src/modules/work/task-query.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";

type CapturedQuery = { sql: string; values: readonly unknown[] };

const organizationId = "00000000-0000-4000-8000-000000000001";
const principalId = "00000000-0000-4000-8000-000000000002";
const repositoryId = "00000000-0000-4000-8000-000000000003";
const taskId = "00000000-0000-4000-8000-000000000004";

function row(id: string, title = "Inbox task") {
  return {
    id,
    application_id: "00000000-0000-4000-8000-000000000005",
    repository_id: repositoryId,
    conversation_id: "00000000-0000-4000-8000-000000000006",
    parent_task_id: null,
    title,
    description: "Task description",
    task_type: "feature",
    status: "queued",
    priority: 1,
    created_by: principalId,
    current_run_id: null,
    archived_at: null,
    created_at: new Date("2026-01-02T00:00:00.000Z"),
    updated_at: new Date("2026-01-02T00:00:00.000Z"),
    version: 1,
    repository_profile_id: null,
    repository_profile_revision: null,
    repository_profile_digest: null,
    observation_id: null,
    observation_digest: null,
    base_sha: null,
    cursor_created_at: "2026-01-02T00:00:00.000000Z",
  };
}

function fixtureContext(
  capture: CapturedQuery[],
  rows = [row(taskId), row("00000000-0000-4000-8000-000000000007")],
): ActionContext {
  const transaction = {
    query(sql: string, values: readonly unknown[] = []) {
      capture.push({ sql, values });
      return Promise.resolve({ rows });
    },
  } as unknown as PgTransactionClient;
  return {
    request: new Request("http://test/v1/tasks"),
    params: {},
    requestId: "request-id",
    traceId: "trace-id",
    signal: new AbortController().signal,
    authority: { organizationId, subject: { principalId } },
    transaction,
  } as ActionContext;
}

Deno.test("task list applies bounded filters and preserves tenant keyset pagination", async () => {
  const queries: CapturedQuery[] = [];
  const handlers = createTaskQueryHandlers("task-filter-secret");
  const result = await handlers.list(fixtureContext(queries), {
    status: "queued",
    repositoryId,
    search: "needle",
    limit: 1,
  });

  assertEquals(result.items.length, 1);
  assert(result.nextCursor !== null);
  const query = queries[0];
  assert(query.sql.includes("organization_id = $1"));
  assert(query.sql.includes("status = $2"));
  assert(query.sql.includes("repository_id = $3::uuid"));
  assert(query.sql.includes("title ilike '%' || $4 || '%' escape E'\\\\'"));
  assert(
    query.sql.includes("description ilike '%' || $5 || '%' escape E'\\\\'"),
  );
  assert(query.sql.includes("(created_at, id) < ($6, $7::uuid)"));
  assert(query.sql.includes("limit $8"));
  assertEquals(query.values, [
    organizationId,
    "queued",
    repositoryId,
    "needle",
    "needle",
    null,
    null,
    2,
  ]);
});

Deno.test("task list escapes ILIKE wildcards and the escape character", async () => {
  const queries: CapturedQuery[] = [];
  const handlers = createTaskQueryHandlers("task-literal-search-secret");
  await handlers.list(fixtureContext(queries), {
    search: ["%", "_", "\\"].join(""),
  });

  const query = queries[0];
  const escaped = ["\\", "%", "\\", "_", "\\", "\\"].join("");
  assertEquals(query.values[1], escaped);
  assertEquals(query.values[2], escaped);
  assert(query.sql.includes("escape E'\\\\'"));
});

Deno.test("task list cursor is bound to every filter and principal", async () => {
  const firstQueries: CapturedQuery[] = [];
  const handlers = createTaskQueryHandlers("task-cursor-secret");
  const first = await handlers.list(fixtureContext(firstQueries), { limit: 1 });
  assert(first.nextCursor !== null);

  const changedFilterQueries: CapturedQuery[] = [];
  const error = await assertRejects(
    () =>
      handlers.list(fixtureContext(changedFilterQueries), {
        limit: 1,
        status: "queued",
        cursor: first.nextCursor!,
      }),
    StandardError,
  );
  assertEquals(error.code, "INVALID_CURSOR");
  assertEquals(changedFilterQueries.length, 0);
});

Deno.test("task list keeps unfiltered callers compatible and fetches one lookahead row", async () => {
  const queries: CapturedQuery[] = [];
  const handlers = createTaskQueryHandlers("task-compat-secret");
  const result = await handlers.list(fixtureContext(queries), {});

  assertEquals(result.items.length, 2);
  assertEquals(result.nextCursor, null);
  assert(queries[0].sql.includes("limit $4"));
  assertEquals(queries[0].values, [organizationId, null, null, 26]);
});

Deno.test("task list requires authorization context", async () => {
  const handlers = createTaskQueryHandlers("task-auth-secret");
  const error = await assertRejects(
    () => handlers.list({} as ActionContext, {}),
    StandardError,
  );
  assertEquals(error.code, "AUTH_FORBIDDEN");
});

Deno.test("TaskCursorQuery validates bounded filters while retaining cursor-only callers", () => {
  assert(
    contractSchemas.TaskCursorQuery.safeParse({ cursor: "x", limit: 100 })
      .success,
  );
  assert(
    contractSchemas.TaskCursorQuery.safeParse({
      status: "queued",
      search: "needle",
    }).success,
  );
  assert(!contractSchemas.TaskCursorQuery.safeParse({ limit: 101 }).success);
  assert(
    !contractSchemas.TaskCursorQuery.safeParse({ search: "x".repeat(201) })
      .success,
  );
  assert(
    !contractSchemas.TaskCursorQuery.safeParse({ status: "not-a-task-status" })
      .success,
  );
});
