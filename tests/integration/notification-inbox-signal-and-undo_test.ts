import { assert, assertEquals } from "@std/assert";
import { authTestOrigin, cleanupAuthFixture } from "../helpers/auth.ts";
import {
  openSocketFixture,
  type SocketFixture,
} from "../helpers/events-socket.ts";
import { withPgTransaction } from "../../apps/server/src/platform/database.ts";
import { signalInboxChanged } from "../../apps/server/src/modules/work/notification-signal.ts";

/**
 * #455: the content-free inbox signal on every inbox change, and an undo of
 * mark-all-read that is bounded in time, applies once and leaves rows changed
 * since then alone. Real routes and real Postgres.
 */

async function seed(
  fixture: SocketFixture,
): Promise<{ id: string; revision: number }> {
  const event = await fixture.insertDomainEvent({
    eventType: "conversation.message_created",
    aggregateId: crypto.randomUUID(),
  });
  const row = await fixture.pgDatabase.query<{ id: string; revision: number }>(
    `insert into bakery.notifications (
       organization_id, recipient_id, kind, target_kind, target_id, task_id,
       source_event_id, source_version
     ) values ($1, $2, 'mention', 'conversation_message', $3, $4, $5, 1)
     returning id, revision`,
    [
      fixture.organizationId,
      fixture.principalId,
      crypto.randomUUID(),
      fixture.taskId,
      event.id,
    ],
  );
  return row.rows[0]!;
}

function api(
  fixture: SocketFixture,
  method: "PATCH" | "POST",
  path: string,
  body: unknown,
  ifMatch?: number,
): Promise<Response> {
  const headers = new Headers({
    cookie: fixture.cookie,
    origin: authTestOrigin,
    "content-type": "application/json",
    "Bakery-Organization-Id": fixture.organizationId,
    "Idempotency-Key": crypto.randomUUID(),
  });
  if (ifMatch !== undefined) headers.set("If-Match", `"${ifMatch}"`);
  return Promise.resolve(fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
    }),
  ));
}

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as T;
}

Deno.test("every inbox change signals its recipient and mark-all undo is bounded", async (t) => {
  const fixture = await openSocketFixture();
  const signals = async () =>
    (await fixture.pgDatabase.query<{ count: number }>(
      `select count(*)::int as count from bakery.domain_events
       where organization_id = $1 and recipient_id = $2
         and event_type = 'notifications.inbox_changed'`,
      [fixture.organizationId, fixture.principalId],
    )).rows[0]!.count;
  const unread = async () =>
    (await json<{ unread: number }>(
      await fixture.app.fetch(
        new Request(`${authTestOrigin}/v1/notifications/count`, {
          headers: {
            cookie: fixture.cookie,
            "Bakery-Organization-Id": fixture.organizationId,
          },
        }),
      ),
      200,
    )).unread;
  try {
    const first = await seed(fixture);
    const second = await seed(fixture);

    await t.step("create signals, carrying no content", async () => {
      const before = await signals();
      await withPgTransaction(
        fixture.pgDatabase,
        (transaction) =>
          signalInboxChanged(transaction, {
            organizationId: fixture.organizationId,
            recipientId: fixture.principalId,
            traceId: crypto.randomUUID().replaceAll("-", ""),
          }),
      );
      assertEquals(await signals(), before + 1);
      const event = await fixture.pgDatabase.query<{
        payload: Record<string, unknown>;
        application_id: string | null;
        task_id: string | null;
        conversation_id: string | null;
      }>(
        `select payload, application_id, task_id, conversation_id
         from bakery.domain_events where recipient_id = $1
         order by organization_sequence desc limit 1`,
        [fixture.principalId],
      );
      const row = event.rows[0]!;
      assertEquals(Object.keys(row.payload).sort(), [
        "resourceId",
        "resourceVersion",
      ]);
      assertEquals(row.payload.resourceId, fixture.principalId);
      assertEquals([row.application_id, row.task_id, row.conversation_id], [
        null,
        null,
        null,
      ]);
    });

    await t.step(
      "read and unread signal; a same-state write does not",
      async () => {
        const before = await signals();
        const read = await json<{ revision: number }>(
          await api(fixture, "PATCH", `/v1/notifications/${first.id}`, {
            read: true,
            expectedCasVersion: first.revision,
          }, first.revision),
          200,
        );
        assertEquals(await signals(), before + 1);
        await json(
          await api(fixture, "PATCH", `/v1/notifications/${first.id}`, {
            read: true,
            expectedCasVersion: read.revision,
          }, read.revision),
          200,
        );
        assertEquals(await signals(), before + 1, "no change, no signal");
        await json(
          await api(fixture, "PATCH", `/v1/notifications/${first.id}`, {
            read: false,
            expectedCasVersion: read.revision,
          }, read.revision),
          200,
        );
        assertEquals(await signals(), before + 2);
      },
    );

    await t.step(
      "the web client's request marks read with the version in the body and no If-Match",
      async () => {
        const current = (await fixture.pgDatabase.query<{ revision: number }>(
          "select revision from bakery.notifications where id = $1",
          [second.id],
        )).rows[0]!.revision;
        const read = await json<{ revision: number; readAt: string | null }>(
          await api(fixture, "PATCH", `/v1/notifications/${second.id}`, {
            read: true,
            expectedCasVersion: current,
          }),
          200,
        );
        assert(read.readAt !== null);
        const stale = await api(
          fixture,
          "PATCH",
          `/v1/notifications/${second.id}`,
          { read: false, expectedCasVersion: current },
        );
        assertEquals(stale.status, 409, await stale.text());
        await json(
          await api(fixture, "PATCH", `/v1/notifications/${second.id}`, {
            read: false,
            expectedCasVersion: read.revision,
          }),
          200,
        );
      },
    );

    await t.step(
      "mark all and undo signal; undo restores only untouched rows, once",
      async () => {
        assertEquals(await unread(), 2);
        const before = await signals();
        const marked = await json<{ marked: number; batchId: string }>(
          await api(fixture, "POST", "/v1/notifications/read-all", {
            readBefore: new Date(Date.now() + 1_000).toISOString(),
          }),
          201,
        );
        assertEquals(marked.marked, 2);
        assertEquals(await signals(), before + 1);
        assertEquals(await unread(), 0);
        // The person reads one again by hand: undo must not override that.
        const current = await fixture.pgDatabase.query<{ revision: number }>(
          "select revision from bakery.notifications where id = $1",
          [second.id],
        );
        const rev = current.rows[0]!.revision;
        const unreadAgain = await json<{ revision: number }>(
          await api(fixture, "PATCH", `/v1/notifications/${second.id}`, {
            read: false,
            expectedCasVersion: rev,
          }, rev),
          200,
        );
        await json(
          await api(fixture, "PATCH", `/v1/notifications/${second.id}`, {
            read: true,
            expectedCasVersion: unreadAgain.revision,
          }, unreadAgain.revision),
          200,
        );
        const undone = await json<{ restored: number; unread: number }>(
          await api(fixture, "POST", "/v1/notifications/read-all/undo", {
            batchId: marked.batchId,
          }),
          200,
        );
        assertEquals(undone.restored, 1, "only the row nothing changed since");
        assertEquals(undone.unread, 1);
        const secondRow = await fixture.pgDatabase.query<
          { read_at: Date | null }
        >(
          "select read_at from bakery.notifications where id = $1",
          [second.id],
        );
        assert(secondRow.rows[0]!.read_at !== null, "the manual read sticks");
        const again = await json<{ code: string }>(
          await api(fixture, "POST", "/v1/notifications/read-all/undo", {
            batchId: marked.batchId,
          }),
          409,
        );
        assertEquals(again.code, "STATE_CONFLICT");
      },
    );

    await t.step("undo is refused after the 10-minute window", async () => {
      const marked = await json<{ batchId: string }>(
        await api(fixture, "POST", "/v1/notifications/read-all", {
          readBefore: new Date(Date.now() + 1_000).toISOString(),
        }),
        201,
      );
      await fixture.pgDatabase.query(
        `update bakery.notification_read_batches
         set created_at = now() - interval '11 minutes' where id = $1`,
        [marked.batchId],
      );
      const late = await json<{ code: string }>(
        await api(fixture, "POST", "/v1/notifications/read-all/undo", {
          batchId: marked.batchId,
        }),
        409,
      );
      assertEquals(late.code, "STATE_CONFLICT");
      assertEquals(await unread(), 0);
    });

    await t.step(
      "a press with nothing unread marks nothing and signals nothing",
      async () => {
        assertEquals(await unread(), 0);
        const before = await signals();
        const empty = await json<
          { marked: number; remainingUnread: number; batchId: string | null }
        >(
          await api(fixture, "POST", "/v1/notifications/read-all", {
            readBefore: new Date(Date.now() + 1_000).toISOString(),
          }),
          201,
        );
        assertEquals([empty.marked, empty.remainingUnread, empty.batchId], [
          0,
          0,
          null,
        ]);
        assertEquals(await signals(), before, "no change, no signal");
        // No batch id is handed out, so there is nothing to undo: any id the
        // client could send answers not found and changes nothing.
        const undo = await json<{ code: string }>(
          await api(fixture, "POST", "/v1/notifications/read-all/undo", {
            batchId: crypto.randomUUID(),
          }),
          404,
        );
        assertEquals(undo.code, "RESOURCE_NOT_FOUND");
        assertEquals(await signals(), before);
        assertEquals(await unread(), 0);
      },
    );
  } finally {
    await fixture.pgDatabase.query(
      "delete from bakery.notifications where organization_id = $1",
      [fixture.organizationId],
    );
    await fixture.pgDatabase.query(
      "delete from bakery.notification_read_batches where organization_id = $1",
      [fixture.organizationId],
    );
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.close();
  }
});
