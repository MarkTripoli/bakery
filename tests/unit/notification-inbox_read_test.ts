import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { createNotificationHandlers } from "../../apps/server/src/modules/work/notification-handlers.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";

type CapturedQuery = { sql: string; values: readonly unknown[] };

const organizationId = "00000000-0000-4000-8000-000000000001";
const recipientId = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000003";
const notificationId = "00000000-0000-4000-8000-000000000004";
const otherPrincipalId = "00000000-0000-4000-8000-000000000005";
const targetId = "00000000-0000-4000-8000-000000000006";

function notificationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: notificationId,
    organizationId,
    recipientId,
    kind: "run_completed",
    targetKind: "run",
    targetId,
    targetAnchor: null,
    conversationId: null,
    runId: targetId,
    taskId,
    actorId: null,
    sourceEventId: null,
    sourceVersion: 1,
    arguments: {},
    readAt: null,
    revision: 1,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    actorName: null,
    cursorCreatedAt: "2026-01-02T00:00:00.000000Z",
    ...overrides,
  };
}

/**
 * A transaction that answers each statement by the table it names, so one test
 * can exercise the list, the destination reauthorization and the count in the
 * order the handler actually issues them.
 */
function fixtureTransaction(
  capture: CapturedQuery[],
  options: {
    rows?: ReturnType<typeof notificationRow>[];
    taskExists?: boolean;
    taskTitle?: string | null;
  } = {},
): PgTransactionClient {
  return {
    query(sql: string, values: readonly unknown[] = []) {
      capture.push({ sql, values });
      if (/from bakery\.notifications as n/.test(sql)) {
        // The list asks for one lookahead row; the single-item read does not.
        // Both are answered from the same fixture rows.
        return Promise.resolve({ rows: options.rows ?? [notificationRow()] });
      }
      if (/from bakery\.tasks/.test(sql)) {
        return Promise.resolve({
          rows: options.taskExists === false
            ? []
            : [{ id: taskId, title: options.taskTitle ?? "Deploy pipeline" }],
        });
      }
      if (/from bakery\.workflow_runs/.test(sql)) {
        return Promise.resolve({ rows: [{ id: targetId }] });
      }
      if (/insert into bakery\.notification_read_batches/.test(sql)) {
        return Promise.resolve({ rows: [{ id: crypto.randomUUID() }] });
      }
      if (/count\(\*\)/.test(sql)) {
        return Promise.resolve({ rows: [{ unread: "3", revision: 7 }] });
      }
      return Promise.resolve({ rows: [] });
    },
  } as unknown as PgTransactionClient;
}

function fixtureContext(
  transaction: PgTransactionClient,
  params: Record<string, string> = {},
): ActionContext {
  return {
    request: new Request("http://test/v1/notifications"),
    params,
    requestId: "request-id",
    traceId: "trace-id",
    signal: new AbortController().signal,
    authority: {
      organizationId,
      subject: { principalId: recipientId },
    },
    transaction,
  } as ActionContext;
}

Deno.test("notification list reads only the caller's inbox and resolves the destination", async () => {
  const queries: CapturedQuery[] = [];
  const handlers = createNotificationHandlers("notification-secret");
  const result = await handlers.list(
    fixtureContext(fixtureTransaction(queries)),
    {},
  );

  assertEquals(result.items.length, 1);
  const item = result.items[0]!;
  assertEquals(item.recipientId, recipientId);
  assertEquals(item.kind, "run_completed");
  assertEquals(item.destination, { title: "Deploy pipeline", available: true });
  assertEquals(item.read, false);

  const list = queries[0]!;
  // The recipient predicate is the whole authorization story for this read.
  assert(list.sql.includes("n.organization_id = $1::uuid"));
  assert(list.sql.includes("n.recipient_id = $2::uuid"));
  assertEquals(list.values[0], organizationId);
  assertEquals(list.values[1], recipientId);
});

Deno.test("notification list applies the unread and mentions filters", async () => {
  const unread: CapturedQuery[] = [];
  const handlers = createNotificationHandlers("notification-filter-secret");
  await handlers.list(fixtureContext(fixtureTransaction(unread)), {
    filter: "unread",
  });
  assert(unread[0]!.sql.includes("n.read_at is null"));
  assertEquals(unread[0]!.values[2], "unread");

  const mentions: CapturedQuery[] = [];
  await handlers.list(fixtureContext(fixtureTransaction(mentions)), {
    filter: "mentions",
  });
  assert(mentions[0]!.sql.includes("n.kind = any($4::text[])"));
  assertEquals(mentions[0]!.values[2], "mentions");
  assertEquals(mentions[0]!.values[3], ["mention", "comment_mention"]);
});

Deno.test("a cursor from a different filter is rejected as invalid", async () => {
  const handlers = createNotificationHandlers("notification-cursor-secret");
  const firstQueries: CapturedQuery[] = [];
  const first = await handlers.list(
    fixtureContext(fixtureTransaction(firstQueries, {
      rows: [
        notificationRow(),
        notificationRow({
          id: "00000000-0000-4000-8000-000000000099",
        }),
      ],
    })),
    { limit: 1, filter: "all" },
  );
  assert(first.nextCursor !== null);

  const error = await assertRejects(
    () =>
      handlers.list(fixtureContext(fixtureTransaction([])), {
        limit: 1,
        filter: "unread",
        cursor: first.nextCursor!,
      }),
    StandardError,
  );
  assertEquals(error.code, "INVALID_CURSOR");
});

Deno.test("a destination the reader can no longer reach withholds its title", async () => {
  const queries: CapturedQuery[] = [];
  const handlers = createNotificationHandlers("notification-gone-secret");
  const result = await handlers.list(
    fixtureContext(fixtureTransaction(queries, { taskExists: false })),
    {},
  );

  assertEquals(result.items[0]!.destination, {
    title: null,
    available: false,
  });
});

Deno.test("resolveTarget returns the task route when the destination still resolves", async () => {
  const queries: CapturedQuery[] = [];
  const handlers = createNotificationHandlers("notification-target-secret");
  const target = await handlers.resolveTarget(
    fixtureContext(
      fixtureTransaction(queries, {
        rows: [notificationRow()],
      }),
      { id: notificationId },
    ),
  );

  assertEquals(target.status, "available");
  if (target.status === "available") {
    assertEquals(target.targetKind, "run");
    assertEquals(target.path, `/tasks/${taskId}`);
  }
});

Deno.test("resolveTarget reports unavailable rather than a protected title", async () => {
  const queries: CapturedQuery[] = [];
  const handlers = createNotificationHandlers(
    "notification-unavailable-secret",
  );
  const target = await handlers.resolveTarget(
    fixtureContext(fixtureTransaction(queries, { taskExists: false }), {
      id: notificationId,
    }),
  );

  assertEquals(target.status, "unavailable");
  assertEquals(target.path, null);
  // The title-bearing statement must not run when the task is out of reach.
  assert(
    !queries.some((query) => /select title from bakery\.tasks/.test(query.sql)),
  );
});

Deno.test("a notification in another inbox is not found", async () => {
  const handlers = createNotificationHandlers("notification-own-secret");
  const transaction = {
    query() {
      return Promise.resolve({ rows: [] });
    },
  } as unknown as PgTransactionClient;

  const error = await assertRejects(
    () =>
      handlers.get(
        fixtureContext(transaction, { id: notificationId }),
      ),
    StandardError,
  );
  assertEquals(error.code, "RESOURCE_NOT_FOUND");
});

Deno.test("setRead refuses a stale revision as a version conflict", async () => {
  const handlers = createNotificationHandlers("notification-cas-secret");
  const transaction = {
    query(sql: string) {
      if (/for update/.test(sql)) {
        return Promise.resolve({
          rows: [{ revision: 4, readAt: null }],
        });
      }
      return Promise.resolve({ rows: [notificationRow()] });
    },
  } as unknown as PgTransactionClient;

  const error = await assertRejects(
    () =>
      handlers.setRead(fixtureContext(transaction), {
        id: notificationId,
        read: true,
        expectedCasVersion: 3,
      }),
    StandardError,
  );
  assertEquals(error.code, "VERSION_CONFLICT");
});

Deno.test("markAllRead is bounded to the snapshot cutoff", async () => {
  const queries: CapturedQuery[] = [];
  const handlers = createNotificationHandlers("notification-bulk-secret");
  const result = await handlers.markAllRead(
    fixtureContext(
      fixtureTransaction(queries),
    ),
    {
      readBefore: "2026-01-02T00:00:00.000Z",
    },
  );

  const update = queries.find((query) =>
    /update bakery\.notifications/.test(query.sql)
  )!;
  // Arrivals after the cutoff must survive the sweep, so the predicate is a
  // bound on created_at, not "every unread row".
  assert(update.sql.includes("created_at <= $3::timestamptz"));
  assertEquals(result.marked, 0);
  assertEquals(result.remainingUnread, 3);
});

Deno.test("the count prefers null over a false zero", async () => {
  const handlers = createNotificationHandlers("notification-count-secret");
  const empty = {
    query() {
      return Promise.resolve({ rows: [{ unread: "0", revision: null }] });
    },
  } as unknown as PgTransactionClient;

  const result = await handlers.count(fixtureContext(empty));
  assertEquals(result.unread, 0);
  assertEquals(result.revision, null);
});

Deno.test("NotificationCursorQuery bounds the contract input", () => {
  assert(
    contractSchemas.NotificationCursorQuery.safeParse({ filter: "mentions" })
      .success,
  );
  assert(
    !contractSchemas.NotificationCursorQuery.safeParse({ limit: 101 }).success,
  );
  assert(
    !contractSchemas.NotificationCursorQuery.safeParse({ filter: "archive" })
      .success,
  );
  void otherPrincipalId;
});

Deno.test("every notification action carries its own authorization guard", async () => {
  // `CurrentMember` is not one of the base organization policies, so an action
  // that names it without a guard is refused for every caller — the inbox
  // answered 403 to its own owner. Each action must state the guard.
  const { createNotificationActionRegistry } = await import(
    "../../apps/server/src/modules/work/notification-actions.ts"
  );
  const registry = createNotificationActionRegistry(
    {} as never,
    "test-cursor-secret-0123456789abcdef",
  );
  const actions = registry
      .list === undefined
    ? []
    : registry.list();
  assert(actions.length > 0, "expected the notification actions to register");
  for (const action of actions) {
    assertEquals(
      typeof action.policy.authorize,
      "function",
      `${action.name} names CurrentMember without an authorize guard`,
    );
  }
});

Deno.test("a run-step target is scoped through its run, never by a task column", async () => {
  // `bakery.run_steps` has no `task_id`: the step reaches its task through
  // `workflow_runs`. A lookup that names a `task_id` on the step table throws
  // for every step notification, which is a 500 rather than a row.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL(
      "../../apps/server/src/modules/work/notifications-target.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert(
    !/byId\("bakery\.run_steps"\)/.test(source),
    "run steps must not take the task_id-scoped byId path",
  );
  assert(
    /join bakery\.workflow_runs/.test(source),
    "the run-step branch must join the run that carries the task",
  );
});

Deno.test("a page of notifications reads its destinations in a fixed number of queries", async () => {
  const countFor = async (size: number) => {
    const queries: CapturedQuery[] = [];
    const rows = Array.from({ length: size }, (_, index) =>
      notificationRow({
        id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      }));
    const result = await createNotificationHandlers("notification-batch-secret")
      .list(fixtureContext(fixtureTransaction(queries, { rows })), {
        limit: 100,
      });
    assertEquals(result.items.length, size);
    return queries.length;
  };
  assertEquals(await countFor(20), await countFor(1));
});
