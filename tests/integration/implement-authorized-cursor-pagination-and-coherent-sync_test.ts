import { assert, assertEquals, assertRejects } from "@std/assert";
import type { JsonValue } from "../../packages/contracts/src/contracts.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import {
  organizationId as toOrganizationId,
  principalId as toPrincipalId,
} from "../../packages/contracts/src/contracts.ts";
import { createSuperuser } from "../../apps/server/src/modules/auth/index.ts";
import { createSyncQueryHandler } from "../../apps/server/src/modules/work/sync-query.ts";
import { encodeSequenceCursor } from "../../apps/server/src/platform/cursor.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  type PgTransactionClient,
  withPgTransaction,
} from "../../apps/server/src/platform/database.ts";
import {
  authRequest,
  authTestOrigin,
  cleanupAuthFixture,
  openAuthFixture,
  sessionCookie,
} from "../helpers/auth.ts";
import { englishCatalog } from "../../packages/i18n/src/index.ts";

type QueryConfig = Parameters<PgTransactionClient["query"]>[0];
type QueryResultRow = Awaited<
  ReturnType<PgTransactionClient["query"]>
>["rows"][number];

type TaskPage = {
  items: Array<{ id: string }>;
  nextCursor: string | null;
};

type SyncSnapshot = {
  // The workflow's snapshot projects by scope: task scopes carry `{tasks}`,
  // worker scopes carry the machine projection — both are JsonValue.
  resourceState: JsonValue;
  highwater: string;
  events: Array<{ sequence: string }>;
  nextCursor: string | null;
};

function syncContext(
  transaction: PgTransactionClient,
  principalId: string,
  organizationId: string,
): ActionContext {
  const subject = {
    principalId: toPrincipalId(principalId),
    principalType: "human" as const,
    displayName: "Issue 33 Sync",
  };
  return {
    request: new Request("http://test/v1/sync"),
    params: {},
    requestId: "issue-33-request",
    traceId: "issue-33-trace",
    signal: new AbortController().signal,
    principal: subject,
    authority: {
      subject,
      organizationId: toOrganizationId(organizationId),
      role: "admin",
      capabilities: [],
    },
    transaction,
  } as ActionContext;
}

Deno.test("task pages traverse equal timestamps without duplicates", async () => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `issue-33-pages-${suffix}@example.test`;
  const password = `Issue33-${suffix}`;
  try {
    // Given: an authorized organization with three tasks sharing one timestamp.
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Issue 33 Pager", password });
    const principal = await fixture.pgDatabase.query<{
      principalId: string;
      organizationId: string;
    }>(
      `select principal.id as "principalId",
        membership.organization_id as "organizationId"
       from bakery.principals as principal
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       join bakery.organization_memberships as membership
         on membership.principal_id = principal.id
       where provider_user.email = $1`,
      [email],
    );
    const { principalId, organizationId } = principal.rows[0];
    const applicationId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.applications (id, organization_id, slug, name)
       values ($1, $2, $3, 'Cursor acceptance')`,
      [applicationId, organizationId, `cursor-${suffix}`],
    );
    const timestamp = new Date("2026-09-12T12:00:00.123456Z");
    const taskIds = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ]
      .sort();
    const insertTask = async (
      taskId: string,
      label: string,
      createdAt: Date,
    ) => {
      const conversationId = crypto.randomUUID();
      await fixture.pgDatabase.query(
        `insert into bakery.conversations (
           id, organization_id, application_id, title, created_by,
           created_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $6)`,
        [
          conversationId,
          organizationId,
          applicationId,
          `Conversation ${label}`,
          principalId,
          createdAt,
        ],
      );
      await fixture.pgDatabase.query(
        `insert into bakery.tasks (
           id, organization_id, application_id, conversation_id, title,
           task_type, status, priority, created_by, created_at, updated_at
         ) values ($1, $2, $3, $4, $5, 'feature', 'draft', 50, $6, $7, $7)`,
        [
          taskId,
          organizationId,
          applicationId,
          conversationId,
          `Task ${label}`,
          principalId,
          createdAt,
        ],
      );
    };
    for (const [index, taskId] of taskIds.entries()) {
      await insertTask(taskId, String(index), timestamp);
    }
    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    const cookie = sessionCookie(signIn);
    const get = (path: string) =>
      fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          headers: {
            cookie,
            "Bakery-Organization-Id": organizationId,
          },
        }),
      );

    // When: rows change after page one and the cursor row is deleted.
    const firstResponse = await get("/v1/tasks?limit=1");
    assertEquals(firstResponse.status, 200);
    const firstPage = await firstResponse.json() as TaskPage;
    assertEquals(firstPage.items.length, 1);
    assert(firstPage.nextCursor);
    const seen = firstPage.items.map(({ id }) => id);
    let cursor: string | null = firstPage.nextCursor;
    const newerTaskId = crypto.randomUUID();
    const olderTaskId = crypto.randomUUID();
    await insertTask(
      newerTaskId,
      "inserted before cursor",
      new Date("2026-09-12T12:00:01.000000Z"),
    );
    await insertTask(
      olderTaskId,
      "inserted after cursor",
      new Date("2026-09-12T12:00:00.000000Z"),
    );
    await fixture.pgDatabase.query(
      "delete from bakery.tasks where organization_id = $1 and id = $2",
      [organizationId, firstPage.items[0].id],
    );

    while (cursor) {
      const response = await get(
        `/v1/tasks?limit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      assertEquals(response.status, 200);
      const page = await response.json() as TaskPage;
      seen.push(...page.items.map(({ id }) => id));
      cursor = page.nextCursor;
    }

    // Then: keyset continuation neither shifts nor duplicates around churn.
    assertEquals(seen, [
      ...[...taskIds].sort().reverse(),
      olderTaskId,
    ]);
    assertEquals(seen.includes(newerTaskId), false);
    assertEquals(new Set(seen).size, 4);
  } finally {
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});

Deno.test("sync preserves snapshot, cursor, and size invariants", async (test) => {
  const fixture = await openAuthFixture();
  const suffix = crypto.randomUUID();
  const email = `issue-33-sync-${suffix}@example.test`;
  const password = `Issue33-${suffix}`;
  const isolatedOrganizationId = crypto.randomUUID();
  try {
    // Given: one authorized task whose creation event has committed.
    await createSuperuser({
      pgDatabase: fixture.pgDatabase,
      config: fixture.config.auth!,
    }, { email, displayName: "Issue 33 Sync", password });
    const scope = await fixture.pgDatabase.query<{
      principalId: string;
      organizationId: string;
    }>(
      `select principal.id as "principalId",
        membership.organization_id as "organizationId"
       from bakery.principals as principal
       join public."user" as provider_user
         on provider_user.id = principal.provider_user_id
       join bakery.organization_memberships as membership
         on membership.principal_id = principal.id
       where provider_user.email = $1`,
      [email],
    );
    const { principalId, organizationId } = scope.rows[0];
    const applicationId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.applications (id, organization_id, slug, name)
       values ($1, $2, $3, 'Sync acceptance')`,
      [applicationId, organizationId, `sync-${suffix}`],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.conversations (
         id, organization_id, application_id, title, created_by
       ) values ($1, $2, $3, 'Sync conversation', $4)`,
      [conversationId, organizationId, applicationId, principalId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.tasks (
         id, organization_id, application_id, conversation_id, title,
         task_type, status, priority, created_by
       ) values ($1, $2, $3, $4, 'Sync task', 'feature', 'draft', 50, $5)`,
      [taskId, organizationId, applicationId, conversationId, principalId],
    );
    const clock = await fixture.pgDatabase.query<{ sequence: string }>(
      `insert into bakery.event_clock (organization_id, stream, next_seq)
       select $1, 'domain_events', coalesce(max(organization_sequence), 0) + 2
       from bakery.domain_events
       where organization_id = $1
       on conflict (organization_id, stream) do update
         set next_seq = bakery.event_clock.next_seq + 1
       returning (next_seq - 1)::text as sequence`,
      [organizationId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.domain_events (
         organization_id, organization_sequence, event_type, schema_version,
         application_id, task_id, conversation_id, aggregate_id,
         aggregate_version, payload
       ) values ($1, $2, 'tasks.created', 1, $3, $4, $5, $4, 1, $6::jsonb)`,
      [
        organizationId,
        clock.rows[0].sequence,
        applicationId,
        taskId,
        conversationId,
        JSON.stringify({ resourceId: taskId, resourceVersion: 1 }),
      ],
    );
    const signIn = await fixture.auth.handler(authRequest(
      "/api/auth/sign-in/email",
      { email, password },
    ));
    const cookie = sessionCookie(signIn);
    const get = (
      path: string,
      requestId = "00000000-0000-4000-8000-000000000010",
    ) =>
      fixture.app.fetch(
        new Request(`${authTestOrigin}${path}`, {
          headers: {
            cookie,
            "Bakery-Organization-Id": organizationId,
            "x-request-id": requestId,
            traceparent:
              "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
          },
        }),
      );
    await test.step(
      "coherent snapshot closes concurrent commit and rollback gaps",
      async () => {
        const missingRepository = await get(
          `/v1/sync?scopeType=repository&scopeId=${crypto.randomUUID()}`,
        );
        assertEquals(missingRepository.status, 404);
        assertEquals(
          (await missingRepository.json()).code,
          "RESOURCE_NOT_FOUND",
        );

        // When: a coherent no-cursor snapshot is followed from its returned cursor.
        const snapshotResponse = await get(
          `/v1/sync?scopeType=task&scopeId=${taskId}`,
        );
        assertEquals(
          snapshotResponse.status,
          200,
          await snapshotResponse.clone().text(),
        );
        const snapshot = await snapshotResponse.json() as {
          resourceState: { tasks: Array<{ id: string }> };
          highwater: string;
          events: Array<{ sequence: string }>;
          nextCursor: string | null;
          resetRequired: boolean;
        };
        assertEquals(snapshot.resourceState.tasks.map(({ id }) => id), [
          taskId,
        ]);
        assertEquals(snapshot.resetRequired, false);
        assert(snapshot.nextCursor);

        await fixture.pgDatabase.query(
          `insert into bakery.organizations (
         id, name, slug, created_at, updated_at
       )
       values ($1, 'Isolated sync organization', $2, current_timestamp, current_timestamp)`,
          [isolatedOrganizationId, `isolated-sync-${isolatedOrganizationId}`],
        );
        const isolatedClock = await fixture.pgDatabase.query<
          { sequence: string }
        >(
          `insert into bakery.event_clock (organization_id, stream, next_seq)
       values ($1, 'domain_events', 2)
       returning (next_seq - 1)::text as sequence`,
          [isolatedOrganizationId],
        );
        await fixture.pgDatabase.query(
          `insert into bakery.domain_events (
         organization_id, organization_sequence, event_type, aggregate_id,
         aggregate_version, payload
       ) values ($1, $2, 'run.requested', $3, 1, $4::jsonb)`,
          [
            isolatedOrganizationId,
            isolatedClock.rows[0].sequence,
            crypto.randomUUID(),
            JSON.stringify({ runId: crypto.randomUUID() }),
          ],
        );
        const afterIsolatedWrite = await get(
          `/v1/sync?scopeType=task&scopeId=${taskId}`,
        );
        assertEquals(afterIsolatedWrite.status, 200);
        assertEquals(
          (await afterIsolatedWrite.json() as { highwater: string }).highwater,
          snapshot.highwater,
        );

        let concurrentWrite: Promise<string> | undefined;
        const concurrentSnapshot = await withPgTransaction<SyncSnapshot>(
          fixture.runtimePgDatabase,
          async (transaction) => {
            const originalQuery = transaction.query.bind(transaction);
            transaction.query = async <
              R extends QueryResultRow = QueryResultRow,
            >(
              queryTextOrConfig: QueryConfig,
              values?: unknown[],
            ) => {
              const result = await originalQuery<R>(queryTextOrConfig, values);
              if (
                typeof queryTextOrConfig === "string" &&
                queryTextOrConfig.includes("bakery.event_clock") &&
                !concurrentWrite
              ) {
                concurrentWrite = (async () => {
                  const writer = await fixture.runtimePgDatabase.connect();
                  try {
                    await writer.query("begin");
                    await writer.query(
                      `update bakery.tasks
                   set title = 'Committed concurrent'
                   where organization_id = $1 and id = $2`,
                      [organizationId, taskId],
                    );
                    const clock = await writer.query<{ sequence: string }>(
                      `insert into bakery.event_clock (
                     organization_id, stream, next_seq
                   )
                   select $1, 'domain_events',
                     coalesce(max(organization_sequence), 0) + 2
                   from bakery.domain_events
                   where organization_id = $1
                   on conflict (organization_id, stream) do update
                     set next_seq = bakery.event_clock.next_seq + 1
                   returning (next_seq - 1)::text as sequence`,
                      [organizationId],
                    );
                    const sequence = clock.rows[0]?.sequence;
                    if (!sequence) throw new Error("EVENT_CLOCK_UNAVAILABLE");
                    await writer.query(
                      `insert into bakery.domain_events (
                     organization_id, organization_sequence, event_type,
                     schema_version, application_id, task_id, conversation_id,
                     aggregate_id, aggregate_version, payload
                   ) values ($1, $2, 'tasks.updated', 1, $3, $4, $5, $4, 2, $6::jsonb)`,
                      [
                        organizationId,
                        sequence,
                        applicationId,
                        taskId,
                        conversationId,
                        JSON.stringify({
                          resourceId: taskId,
                          resourceVersion: 2,
                        }),
                      ],
                    );
                    await writer.query("commit");
                    return sequence;
                  } catch (error) {
                    await writer.query("rollback").catch(() => {});
                    throw error;
                  } finally {
                    writer.release();
                  }
                })();
                await concurrentWrite;
              }
              return result;
            };
            return await createSyncQueryHandler(fixture.config.auth!.secret)(
              syncContext(transaction, principalId, organizationId),
              { scopeType: "task", scopeId: taskId },
            );
          },
          undefined,
          "repeatable read",
        );
        const committedSequence = await concurrentWrite;
        assert(committedSequence);
        const state = concurrentSnapshot.resourceState;
        if (
          typeof state !== "object" || state === null || !("tasks" in state)
        ) {
          throw new Error("SNAPSHOT_STATE_MISSING");
        }
        const tasks = state.tasks;
        if (!Array.isArray(tasks)) {
          throw new Error("SNAPSHOT_STATE_MISSING");
        }
        const first = typeof tasks[0] === "object" && tasks[0] !== null &&
            !Array.isArray(tasks[0])
          ? tasks[0]
          : null;
        if (!first || !("title" in first)) {
          throw new Error("SNAPSHOT_STATE_MISSING");
        }
        assertEquals(
          first.title,
          "Sync task",
        );
        assertEquals(concurrentSnapshot.highwater, snapshot.highwater);
        assertEquals(concurrentSnapshot.events, []);
        assert(concurrentSnapshot.nextCursor);

        const deltaResponse = await get(
          `/v1/sync?scopeType=task&scopeId=${taskId}&after=${
            encodeURIComponent(concurrentSnapshot.nextCursor)
          }`,
        );
        assertEquals(
          deltaResponse.status,
          200,
          await deltaResponse.clone().text(),
        );
        const delta = await deltaResponse.json() as {
          resourceState: unknown;
          highwater: string;
          events: Array<{ sequence: string }>;
          nextCursor: string | null;
        };

        // Then: the later commit is replayed exactly after snapshot highwater.
        assertEquals(delta.resourceState, {});
        assertEquals(delta.events.map(({ sequence }) => sequence), [
          committedSequence,
        ]);
        assertEquals(delta.highwater, committedSequence);
        assert(delta.nextCursor);

        const caughtUpResponse = await get(
          `/v1/sync?scopeType=task&scopeId=${taskId}&after=${
            encodeURIComponent(delta.nextCursor)
          }`,
        );
        assertEquals(caughtUpResponse.status, 200);
        const caughtUp = await caughtUpResponse.json() as {
          events: Array<{ sequence: string }>;
          nextCursor: string | null;
        };
        assertEquals(caughtUp.events, []);
        assertEquals(caughtUp.nextCursor, null);

        const rollbackWriter = await fixture.runtimePgDatabase.connect();
        try {
          await rollbackWriter.query("begin");
          await rollbackWriter.query(
            `update bakery.tasks
         set title = 'Rolled back'
         where organization_id = $1 and id = $2`,
            [organizationId, taskId],
          );
          await rollbackWriter.query(
            `update bakery.event_clock
         set next_seq = next_seq + 1
         where organization_id = $1 and stream = 'domain_events'`,
            [organizationId],
          );
          await rollbackWriter.query("rollback");
        } finally {
          rollbackWriter.release();
        }
        const afterRollback = await get(
          `/v1/sync?scopeType=task&scopeId=${taskId}`,
        );
        assertEquals(afterRollback.status, 200);
        const rollbackSnapshot = await afterRollback.json() as {
          resourceState: { tasks: Array<{ title: string }> };
          highwater: string;
        };
        assertEquals(
          rollbackSnapshot.resourceState.tasks[0].title,
          "Committed concurrent",
        );
        assertEquals(rollbackSnapshot.highwater, committedSequence);
      },
    );

    await test.step("snapshot traversal preserves microsecond order", async () => {
      const microsecondTasks: Array<{ id: string; createdAt: string }> = [
        { id: crypto.randomUUID(), createdAt: "2026-09-12T12:00:00.123100Z" },
        { id: crypto.randomUUID(), createdAt: "2026-09-12T12:00:00.123900Z" },
        { id: crypto.randomUUID(), createdAt: "2026-09-12T12:00:00.456789Z" },
        { id: crypto.randomUUID(), createdAt: "2026-09-12T12:00:00.456789Z" },
      ];
      const microsecondTaskIds = microsecondTasks.map(({ id }) => id);
      for (const [index, microsecondTask] of microsecondTasks.entries()) {
        const microsecondTaskId = microsecondTask.id;
        const microsecondConversationId = crypto.randomUUID();
        await fixture.pgDatabase.query(
          `insert into bakery.conversations (
           id, organization_id, application_id, title, created_by
         ) values ($1, $2, $3, $4, $5)`,
          [
            microsecondConversationId,
            organizationId,
            applicationId,
            `Microsecond conversation ${index}`,
            principalId,
          ],
        );
        await fixture.pgDatabase.query(
          `insert into bakery.tasks (
           id, organization_id, application_id, conversation_id, title,
           task_type, status, priority, created_by, created_at, updated_at
         ) values ($1, $2, $3, $4, $5, 'feature', 'draft', 50, $6,
           $7::timestamptz, $7::timestamptz)`,
          [
            microsecondTaskId,
            organizationId,
            applicationId,
            microsecondConversationId,
            `Microsecond task ${index}`,
            principalId,
            microsecondTask.createdAt,
          ],
        );
      }
      const microsecondSnapshot = await withPgTransaction<SyncSnapshot>(
        fixture.runtimePgDatabase,
        (transaction) =>
          createSyncQueryHandler(fixture.config.auth!.secret)(
            syncContext(transaction, principalId, organizationId),
            { scopeType: "application", scopeId: applicationId },
          ),
        undefined,
        "repeatable read",
      );
      const microState = microsecondSnapshot.resourceState;
      if (
        typeof microState !== "object" || microState === null ||
        !("tasks" in microState) || !Array.isArray(microState.tasks)
      ) {
        throw new Error("SNAPSHOT_STATE_MISSING");
      }
      const microTasks = microState.tasks.filter((entry) =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
        typeof (entry as { id?: unknown }).id === "string"
      ) as Array<{ id: string }>;
      assertEquals(
        microTasks.filter(({ id }) => microsecondTaskIds.includes(id)).map((
          { id },
        ) => id),
        [...microsecondTasks]
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.id.localeCompare(left.id)
          )
          .map(({ id }) => id),
      );
      const returnedMicrosecondTaskIds = microTasks
        .filter(({ id }) => microsecondTaskIds.includes(id)).map(({ id }) =>
          id
        );
      assertEquals(
        returnedMicrosecondTaskIds.length,
        microsecondTaskIds.length,
      );
      assertEquals(
        new Set(returnedMicrosecondTaskIds).size,
        microsecondTaskIds.length,
      );
    });

    await test.step("decimal cursors and reset metadata remain exact", async () => {
      const cursorBinding = {
        action: "sync.snapshot",
        principalId,
        organizationId,
        ordering: "sequence:asc",
        filters: JSON.stringify({ scopeId: taskId, scopeType: "task" }),
        schemaVersion: 1,
      };
      const boundary = await fixture.pgDatabase.query<{
        lower: string;
        upper: string;
      }>(
        `update bakery.event_clock
       set next_seq =
         power(10::numeric, length(next_seq::text))::bigint + 1
       where organization_id = $1 and stream = 'domain_events'
       returning (next_seq - 2)::text as lower,
         (next_seq - 1)::text as upper`,
        [organizationId],
      );
      const lowerBoundary = boundary.rows[0].lower;
      const upperBoundary = boundary.rows[0].upper;
      await fixture.pgDatabase.query(
        `insert into bakery.domain_events (
         organization_id, organization_sequence, event_type, schema_version,
         application_id, task_id, conversation_id, aggregate_id,
         aggregate_version, payload
       ) values
         ($1, $5, 'tasks.updated', 1, $2, $3, $4, $3, $9, $7::jsonb),
         ($1, $6, 'tasks.updated', 1, $2, $3, $4, $3, $10, $8::jsonb)`,
        [
          organizationId,
          applicationId,
          taskId,
          conversationId,
          lowerBoundary,
          upperBoundary,
          JSON.stringify({
            resourceId: taskId,
            resourceVersion: Number(lowerBoundary),
          }),
          JSON.stringify({
            resourceId: taskId,
            resourceVersion: Number(upperBoundary),
          }),
          Number(lowerBoundary),
          Number(upperBoundary),
        ],
      );
      const boundaryCursor = await encodeSequenceCursor(
        fixture.config.auth!.secret,
        cursorBinding,
        { sequence: (BigInt(lowerBoundary) - 1n).toString() },
      );

      // When: sequence pagination crosses a decimal-width boundary.
      const boundaryFirst = await withPgTransaction<SyncSnapshot>(
        fixture.runtimePgDatabase,
        async (transaction) =>
          await createSyncQueryHandler(fixture.config.auth!.secret)(
            syncContext(transaction, principalId, organizationId),
            {
              scopeType: "task",
              scopeId: taskId,
              after: boundaryCursor,
              limit: 1,
            },
          ),
        undefined,
        "repeatable read",
      );

      // Then: bigint order crosses a decimal-width boundary numerically.
      assertEquals(boundaryFirst.events.map(({ sequence }) => sequence), [
        lowerBoundary,
      ]);
      assert(boundaryFirst.nextCursor);
      const boundarySecond = await withPgTransaction<SyncSnapshot>(
        fixture.runtimePgDatabase,
        async (transaction) =>
          await createSyncQueryHandler(fixture.config.auth!.secret)(
            syncContext(transaction, principalId, organizationId),
            {
              scopeType: "task",
              scopeId: taskId,
              after: boundaryFirst.nextCursor,
              limit: 1,
            },
          ),
        undefined,
        "repeatable read",
      );
      assertEquals(boundarySecond.events.map(({ sequence }) => sequence), [
        upperBoundary,
      ]);

      const expiredCursor = await encodeSequenceCursor(
        fixture.config.auth!.secret,
        cursorBinding,
        { sequence: "0" },
      );
      await fixture.pgDatabase.query(
        `update bakery.event_clock
       set retained_from_seq = 2
       where organization_id = $1 and stream = 'domain_events'`,
        [organizationId],
      );
      try {
        const expiredResponse = await get(
          `/v1/sync?scopeType=task&scopeId=${taskId}&after=${
            encodeURIComponent(expiredCursor)
          }`,
        );
        assertEquals(expiredResponse.status, 409);
        assertEquals(await expiredResponse.json(), {
          type: `${authTestOrigin}/problems/state-conflict`,
          title: englishCatalog["problems.STATE_CONFLICT.title"],
          status: 409,
          detail: englishCatalog["problems.STATE_CONFLICT.description"],
          instance: "urn:bakery:request:00000000-0000-4000-8000-000000000010",
          code: "STATE_CONFLICT",
          requestId: "00000000-0000-4000-8000-000000000010",
          traceId: "0123456789abcdef0123456789abcdef",
          retryable: false,
          resetRequired: true,
          retainedFrom: "2",
          retryWithoutAfter: true,
        });
      } finally {
        await fixture.pgDatabase.query(
          `update bakery.event_clock
         set retained_from_seq = 1
         where organization_id = $1 and stream = 'domain_events'`,
          [organizationId],
        );
      }

      const futureCursor = await encodeSequenceCursor(
        fixture.config.auth!.secret,
        cursorBinding,
        { sequence: "999999" },
      );
      const futureResponse = await get(
        `/v1/sync?scopeType=task&scopeId=${taskId}&after=${
          encodeURIComponent(futureCursor)
        }`,
      );
      assertEquals(futureResponse.status, 409);
      assertEquals(await futureResponse.json(), {
        type: `${authTestOrigin}/problems/state-conflict`,
        title: englishCatalog["problems.STATE_CONFLICT.title"],
        status: 409,
        detail: englishCatalog["problems.STATE_CONFLICT.description"],
        instance: "urn:bakery:request:00000000-0000-4000-8000-000000000010",
        code: "STATE_CONFLICT",
        requestId: "00000000-0000-4000-8000-000000000010",
        traceId: "0123456789abcdef0123456789abcdef",
        retryable: false,
        resetRequired: true,
        retainedFrom: "1",
        retryWithoutAfter: true,
      });
    });

    await test.step("snapshot limits bound projection reads", async () => {
      const largeDescription = "x".repeat(20_000);
      for (let index = 0; index < 27; index++) {
        const largeConversationId = crypto.randomUUID();
        const largeTaskId = crypto.randomUUID();
        await fixture.pgDatabase.query(
          `insert into bakery.conversations (
           id, organization_id, application_id, title, created_by
         ) values ($1, $2, $3, $4, $5)`,
          [
            largeConversationId,
            organizationId,
            applicationId,
            `Large conversation ${index}`,
            principalId,
          ],
        );
        await fixture.pgDatabase.query(
          `insert into bakery.tasks (
           id, organization_id, application_id, conversation_id, title,
           description, task_type, status, priority, created_by
         ) values ($1, $2, $3, $4, $5, $6, 'feature', 'draft', 50, $7)`,
          [
            largeTaskId,
            organizationId,
            applicationId,
            largeConversationId,
            `Large task ${index}`,
            largeDescription,
            principalId,
          ],
        );
      }
      const boundedRows: number[] = [];
      const boundedError = await assertRejects(
        () =>
          withPgTransaction(
            fixture.runtimePgDatabase,
            async (transaction) => {
              const originalQuery = transaction.query.bind(transaction);
              transaction.query = async <
                R extends QueryResultRow = QueryResultRow,
              >(
                queryTextOrConfig: QueryConfig,
                values?: unknown[],
              ) => {
                const result = await originalQuery<R>(
                  queryTextOrConfig,
                  values,
                );
                if (
                  typeof queryTextOrConfig === "string" &&
                  queryTextOrConfig.includes("from bakery.tasks") &&
                  queryTextOrConfig.includes("limit 100")
                ) boundedRows.push(result.rows.length);
                return result;
              };
              return await createSyncQueryHandler(fixture.config.auth!.secret)(
                syncContext(transaction, principalId, organizationId),
                { scopeType: "application", scopeId: applicationId },
              );
            },
            undefined,
            "repeatable read",
          ),
        StandardError,
      );
      assertEquals(boundedError.code, "SNAPSHOT_SCOPE_TOO_LARGE");
      assert(boundedRows.some((count) => count > 1));
      assert(boundedRows.every((count) => count <= 100));

      const oversized = await get(
        `/v1/sync?scopeType=application&scopeId=${applicationId}`,
      );
      assertEquals(oversized.status, 413);
      assertEquals(await oversized.json(), {
        type: `${authTestOrigin}/problems/snapshot-scope-too-large`,
        title: englishCatalog["problems.SNAPSHOT_SCOPE_TOO_LARGE.title"],
        status: 413,
        detail: englishCatalog["problems.SNAPSHOT_SCOPE_TOO_LARGE.description"],
        instance: "urn:bakery:request:00000000-0000-4000-8000-000000000010",
        code: "SNAPSHOT_SCOPE_TOO_LARGE",
        requestId: "00000000-0000-4000-8000-000000000010",
        traceId: "0123456789abcdef0123456789abcdef",
        retryable: false,
        refineScope: { scopeType: "task" },
      });
    });
  } finally {
    await fixture.pgDatabase.query(
      "delete from bakery.organizations where id = $1",
      [isolatedOrganizationId],
    );
    await cleanupAuthFixture(fixture.pgDatabase, [email]);
    await fixture.close();
  }
});
