import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import {
  type OrganizationId,
  type PrincipalId,
} from "../../packages/contracts/src/contracts.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { StandardError, toProblem } from "../../packages/contracts/src/http.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { encodeSequenceCursor } from "../../apps/server/src/platform/cursor.ts";
import type {
  PgDatabase,
  PgTransactionClient,
} from "../../apps/server/src/platform/database.ts";
import {
  type TaskRow,
  toTask,
} from "../../apps/server/src/modules/work/postgres.ts";
import { createSyncQueryHandler } from "../../apps/server/src/modules/work/sync-query.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";

const principalId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000003";

const syncBinding = {
  action: "sync.snapshot",
  principalId,
  organizationId,
  ordering: "sequence:asc",
  filters: JSON.stringify({ scopeId: taskId, scopeType: "task" }),
  schemaVersion: 1,
};

function syncContext(transaction: PgTransactionClient): ActionContext {
  return {
    request: new Request("http://test/v1/sync"),
    params: {},
    requestId: "request-id",
    traceId: "trace-id",
    signal: new AbortController().signal,
    authority: {
      subject: {
        principalId: principalId as PrincipalId,
        principalType: "human",
        displayName: "Sync tester",
      },
      organizationId: organizationId as OrganizationId,
      role: "admin",
      capabilities: [],
    },
    transaction,
  } as ActionContext;
}

function syncTransaction(options: {
  highwater: string;
  retainedFrom: string;
  events?: Array<Record<string, unknown>>;
  tasks?: Array<Record<string, unknown>>;
  taskStats?: {
    queryCount: number;
    rowCounts: number[];
  };
}): PgTransactionClient {
  return {
    query(sql: string, values: unknown[] = []) {
      if (sql.includes("select 1 from bakery.tasks")) {
        return Promise.resolve({ rows: [{ id: taskId }], rowCount: 1 });
      }
      if (sql.includes("bakery.event_clock")) {
        return Promise.resolve({
          rows: [{
            highwater: options.highwater,
            retainedFrom: options.retainedFrom,
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("from bakery.domain_events")) {
        const after = BigInt(String(values[2]));
        const rows = (options.events ?? []).filter((event) =>
          BigInt(String(event.sequence)) > after
        );
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      if (sql.includes("from bakery.tasks")) {
        const cursorId = values.length > 3 ? String(values[3]) : undefined;
        const cursorIndex = cursorId === undefined
          ? -1
          : (options.tasks ?? []).findIndex((task) => task.id === cursorId);
        const row = (options.tasks ?? [])[cursorIndex + 1];
        const rows = row === undefined
          ? cursorId === undefined ? (options.tasks ?? []).slice(0, 1) : []
          : [row];
        if (options.taskStats) {
          options.taskStats.queryCount++;
          options.taskStats.rowCounts.push(rows.length);
        }
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      return Promise.resolve({
        rows: options.tasks ?? [],
        rowCount: options.tasks?.length ?? 0,
      });
    },
  } as unknown as PgTransactionClient;
}

function event(sequence: string): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    sequence,
    event_type: "tasks.updated",
    schema_version: 1,
    occurred_at: new Date("2026-09-12T12:00:00.000Z"),
    application_id: null,
    repository_id: null,
    task_id: taskId,
    conversation_id: null,
    payload: { resourceId: taskId, resourceVersion: Number(sequence) },
  };
}

Deno.test("sync uses the contract limit and terminal continuation", async () => {
  const secret = "issue-33-sync-unit-secret";
  const handler = createSyncQueryHandler(secret);
  const transaction = syncTransaction({
    highwater: "3",
    retainedFrom: "1",
    events: [event("1"), event("2"), event("3")],
  });
  const after = await encodeSequenceCursor(secret, syncBinding, {
    sequence: "0",
  });

  const first = await handler(syncContext(transaction), {
    scopeType: "task",
    scopeId: taskId,
    after,
    limit: 1,
  });
  assertEquals(first.events.map(({ sequence }) => sequence), ["1"]);
  assertEquals(typeof first.nextCursor, "string");

  const second = await handler(syncContext(transaction), {
    scopeType: "task",
    scopeId: taskId,
    after: first.nextCursor,
    limit: 2,
  });
  assertEquals(second.events.map(({ sequence }) => sequence), ["2", "3"]);
  assertEquals(typeof second.nextCursor, "string");

  const caughtUp = await handler(syncContext(transaction), {
    scopeType: "task",
    scopeId: taskId,
    after: second.nextCursor,
    limit: 2,
  });
  assertEquals(caughtUp.events, []);
  assertEquals(caughtUp.nextCursor, null);
});

Deno.test("sync resets both expired and future cursors", async () => {
  const secret = "issue-33-sync-reset-secret";
  const handler = createSyncQueryHandler(secret);
  const expired = await encodeSequenceCursor(secret, syncBinding, {
    sequence: "1",
  });
  const future = await encodeSequenceCursor(secret, syncBinding, {
    sequence: "4",
  });
  for (const after of [expired, future]) {
    const error = await assertRejects(
      () =>
        handler(
          syncContext(syncTransaction({ highwater: "3", retainedFrom: "3" })),
          {
            scopeType: "task",
            scopeId: taskId,
            after,
          },
        ),
      StandardError,
    );
    assertEquals(error.code, "STATE_CONFLICT");
  }
});

Deno.test("empty sync deltas advance to the scoped highwater", async () => {
  const secret = "issue-33-sync-empty-secret";
  const handler = createSyncQueryHandler(secret);
  const after = await encodeSequenceCursor(secret, syncBinding, {
    sequence: "0",
  });

  const first = await handler(
    syncContext(syncTransaction({ highwater: "3", retainedFrom: "1" })),
    { scopeType: "task", scopeId: taskId, after },
  );
  assertEquals(first.events, []);
  assertEquals(typeof first.nextCursor, "string");

  const second = await handler(
    syncContext(syncTransaction({ highwater: "3", retainedFrom: "1" })),
    { scopeType: "task", scopeId: taskId, after: first.nextCursor },
  );
  assertEquals(second.events, []);
  assertEquals(second.nextCursor, null);
});

Deno.test("full sync snapshots reject oversized resource state", async () => {
  const task = {
    id: taskId,
    application_id: crypto.randomUUID(),
    repository_id: null,
    conversation_id: crypto.randomUUID(),
    parent_task_id: null,
    title: "Large task",
    description: "x".repeat(524_000),
    task_type: "feature",
    status: "draft",
    priority: 50,
    created_by: principalId,
    current_run_id: null,
    archived_at: null,
    created_at: new Date("2026-09-12T12:00:00.000Z"),
    updated_at: new Date("2026-09-12T12:00:00.000Z"),
    version: 1,
  };
  const error = await assertRejects(
    () =>
      createSyncQueryHandler("issue-33-sync-size-secret")(
        syncContext(syncTransaction({
          highwater: "0",
          retainedFrom: "1",
          tasks: [task],
        })),
        { scopeType: "task", scopeId: taskId },
      ),
    StandardError,
  );
  assertEquals(error.code, "SNAPSHOT_SCOPE_TOO_LARGE");
  assertEquals(error.params, { refineScope: { scopeType: "task" } });
});

function taskRow(description: string, id = taskId): TaskRow {
  return {
    id,
    application_id: crypto.randomUUID(),
    repository_id: null,
    conversation_id: crypto.randomUUID(),
    parent_task_id: null,
    title: "Sized task",
    description,
    task_type: "feature",
    status: "draft",
    priority: 50,
    created_by: principalId,
    current_run_id: null,
    archived_at: null,
    created_at: new Date("2026-09-12T12:00:00.000Z"),
    updated_at: new Date("2026-09-12T12:00:00.000Z"),
    version: 1,
    repository_profile_id: null,
    repository_profile_revision: null,
    repository_profile_digest: null,
    observation_id: null,
    observation_digest: null,
    base_sha: null,
    approval_policy: null,
    planning_only: false,
  };
}

Deno.test("snapshot stops row retrieval at the first oversized projection", async () => {
  const tasks = Array.from(
    { length: 4 },
    (_, index) =>
      taskRow(
        "x".repeat(200_000),
        `00000000-0000-4000-8000-00000000000${4 + index}`,
      ),
  );
  const taskStats = { queryCount: 0, rowCounts: [] as number[] };

  await assertRejects(
    () =>
      createSyncQueryHandler("issue-33-sync-bounded-secret")(
        syncContext(
          syncTransaction({
            highwater: "0",
            retainedFrom: "1",
            tasks,
            taskStats,
          }),
        ),
        { scopeType: "task", scopeId: taskId },
      ),
    StandardError,
    "SNAPSHOT_SCOPE_TOO_LARGE",
  );

  assertEquals(taskStats.rowCounts, [1, 1, 1]);
  assert(
    taskStats.rowCounts.reduce((total, count) => total + count, 0) <
      tasks.length,
  );
});

Deno.test("snapshot size accounting accepts an exact UTF-8 boundary", async () => {
  const empty = taskRow("");
  const emptyBytes = new TextEncoder().encode(
    JSON.stringify({ tasks: [toTask(empty)] }),
  ).byteLength;
  const exact = taskRow("x".repeat(524_288 - emptyBytes));
  const snapshot = await createSyncQueryHandler("issue-33-sync-exact-secret")(
    syncContext(
      syncTransaction({
        highwater: "0",
        retainedFrom: "1",
        tasks: [exact],
      }),
    ),
    { scopeType: "task", scopeId: taskId },
  );

  assertEquals(
    new TextEncoder().encode(JSON.stringify(snapshot.resourceState)).byteLength,
    524_288,
  );
});

Deno.test("reset conflict metadata is exact and allowlisted", () => {
  const problem = toProblem(
    new StandardError({
      code: "STATE_CONFLICT",
      params: {
        resetRequired: true,
        retainedFrom: "42",
        retryWithoutAfter: true,
        secret: "must not escape",
      },
    }),
    {
      requestId: "request-id",
      traceId: "trace-id",
      publicBaseUrl: "https://bakery.test",
    },
  );
  assertEquals(problem.resetRequired, true);
  assertEquals(problem.retainedFrom, "42");
  assertEquals(problem.retryWithoutAfter, true);
  assertEquals("secret" in problem, false);
});

Deno.test("production task action registry selects repeatable read for sync", async () => {
  const statements: string[] = [];
  const database = {
    connect: () =>
      Promise.resolve({
        query(sql: string) {
          statements.push(sql.replaceAll(/\s+/g, " ").trim().toLowerCase());
          if (sql.startsWith("begin isolation level")) {
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
          if (sql.includes("from bakery.principals")) {
            return Promise.resolve({
              rows: [{
                principalId,
                principalType: "human",
                displayName: "Sync tester",
              }],
              rowCount: 1,
            });
          }
          if (sql.includes("from bakery.organization_memberships")) {
            return Promise.resolve({
              rows: [{ role: "admin", status: "active" }],
              rowCount: 1,
            });
          }
          if (sql.includes("from bakery.permission_grants")) {
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
        release() {},
      }),
  } as unknown as PgDatabase;
  const registry = createTaskActionRegistry(
    {
      list: () => {
        throw new Error("not used");
      },
      get: () => {
        throw new Error("not used");
      },
      create: () => {
        throw new Error("not used");
      },
      update: () => {
        throw new Error("not used");
      },
      createDependency: () => null as never,
      deleteDependency: () => null as never,
      runsCreate: () => null as never,
      runsList: () => null as never,
      runsGet: () => null as never,
      runStepsList: () => null as never,
      workflowPresetsList: () => null as never,
      usageList: () => null as never,
      sync: () => ({
        resourceState: { tasks: [] },
        highwater: "0",
        events: [],
        nextCursor: null,
        resetRequired: false,
      }),
    },
    { authorityRunner: new PostgresAuthorityRunner(database) },
  );

  await registry.execute(
    "sync.snapshot",
    {
      request: new Request("http://test/v1/sync", {
        headers: { "Bakery-Organization-Id": organizationId },
      }),
      params: {},
      requestId: "request-id",
      traceId: "trace-id",
      signal: new AbortController().signal,
      principal: {
        principalId,
        principalType: "human",
        displayName: "Sync tester",
      },
    },
    { scopeType: "task", scopeId: taskId },
  );

  assertEquals(statements[0], "begin isolation level repeatable read");
});

Deno.test("oversized sync after values map to invalid cursors", () => {
  const parsed = contractSchemas.SyncQuery.safeParse({
    scopeType: "task",
    scopeId: taskId,
    after: "x".repeat(513),
  });
  if (parsed.success) throw new Error("OVERSIZED_AFTER_ACCEPTED");
  assertEquals(
    toProblem(parsed.error, {
      requestId: "request-id",
      traceId: "trace-id",
      publicBaseUrl: "https://bakery.test",
    }).code,
    "INVALID_CURSOR",
  );
});
