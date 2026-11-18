import { assert, assertEquals } from "@std/assert";
import { authTestOrigin, cleanupAuthFixture } from "../helpers/auth.ts";
import {
  openSocketFixture,
  type SocketFixture,
} from "../helpers/events-socket.ts";
import type { WsClient } from "../helpers/ws-client.ts";

/**
 * #455 own-inbox boundary. A Viewer has neither notification:write nor
 * event:read, yet may change the read state of their OWN notifications and
 * subscribe to their OWN inbox signal. Nothing about that reaches another
 * principal's notifications, another principal's inbox scope, or any other
 * events scope.
 */

type Frame = Record<string, unknown> & { type: string };

async function next(client: WsClient, timeoutMs = 2_500): Promise<Frame> {
  const value = await client.next(timeoutMs);
  assert(typeof value === "string", `expected text, got ${String(value)}`);
  return JSON.parse(value) as Frame;
}

function problemCode(frame: Frame): string {
  assertEquals(frame.type, "problem", JSON.stringify(frame));
  return (frame.problem as { code: string }).code;
}

async function seedNotification(
  fixture: SocketFixture,
  recipientId: string,
): Promise<{ id: string; revision: number }> {
  const event = await fixture.insertDomainEvent({
    eventType: "conversation.message_created",
    aggregateId: crypto.randomUUID(),
  });
  const inserted = await fixture.pgDatabase.query<
    { id: string; revision: number }
  >(
    `insert into bakery.notifications (
       organization_id, recipient_id, kind, target_kind, target_id,
       task_id, source_event_id, source_version
     ) values ($1, $2, 'mention', 'conversation_message', $3, $4, $5, 1)
     returning id, revision`,
    [
      fixture.organizationId,
      recipientId,
      crypto.randomUUID(),
      fixture.taskId,
      event.id,
    ],
  );
  return inserted.rows[0]!;
}

function api(
  fixture: SocketFixture,
  path: string,
  init: { method: "PATCH" | "POST"; body: unknown; ifMatch?: number },
): Promise<Response> {
  const headers = new Headers({
    cookie: fixture.cookie,
    origin: authTestOrigin,
    "content-type": "application/json",
    "Bakery-Organization-Id": fixture.organizationId,
    "Idempotency-Key": crypto.randomUUID(),
  });
  if (init.ifMatch !== undefined) headers.set("If-Match", `"${init.ifMatch}"`);
  return Promise.resolve(fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method: init.method,
      headers,
      body: JSON.stringify(init.body),
    }),
  ));
}

Deno.test("a viewer manages only their own inbox and only their own inbox scope", async () => {
  const fixture = await openSocketFixture();
  const otherId = crypto.randomUUID();
  let client: WsClient | undefined;
  try {
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set role = 'viewer'
       where organization_id = $1 and principal_id = $2`,
      [fixture.organizationId, fixture.principalId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.principals (id, display_name, principal_type)
       values ($1, 'Other Inbox', 'service')`,
      [otherId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id, organization_id, principal_id, role, status, joined_at,
         created_at, updated_at, version
       ) values ($1, $2, $3, 'developer', 'active', now(), now(), now(), 1)`,
      [crypto.randomUUID(), fixture.organizationId, otherId],
    );
    const mine = await seedNotification(fixture, fixture.principalId);
    const theirs = await seedNotification(fixture, otherId);

    // Events: the viewer connects, owns their inbox scope, and nothing else.
    const connected = await fixture.connect({ cookie: fixture.cookie });
    assert("send" in connected, "a viewer may open the socket for their inbox");
    client = connected;
    assertEquals((await next(client)).type, "hello");
    const subscribe = async (scopes: unknown[]) => {
      await client!.send(JSON.stringify({
        type: "subscribe",
        requestId: crypto.randomUUID(),
        scopes,
        after: null,
      }));
      return await next(client!);
    };
    assertEquals(
      problemCode(await subscribe([{ type: "inbox", id: otherId }])),
      "RESOURCE_NOT_FOUND",
      "another principal's inbox is indistinguishable from none",
    );
    assertEquals(
      problemCode(await subscribe([{ type: "task", id: fixture.taskId }])),
      "RESOURCE_NOT_FOUND",
      "the inbox exception never opens a task scope",
    );
    assertEquals(
      problemCode(
        await subscribe([
          { type: "inbox", id: fixture.principalId },
          { type: "conversation", id: fixture.conversationId },
        ]),
      ),
      "RESOURCE_NOT_FOUND",
      "nor rides along with the viewer's own inbox",
    );
    assertEquals(
      (await subscribe([{ type: "inbox", id: fixture.principalId }])).type,
      "cursor",
    );

    // HTTP: marking their own item read succeeds and signals their inbox.
    const own = await api(fixture, `/v1/notifications/${mine.id}`, {
      method: "PATCH",
      ifMatch: mine.revision,
      body: { read: true, expectedCasVersion: mine.revision },
    });
    assertEquals(own.status, 200, await own.clone().text());
    let signalled = false;
    for (let i = 0; i < 5 && !signalled; i++) {
      const frame = await next(client, 3_000);
      signalled = JSON.stringify(frame).includes("notifications.inbox_changed");
    }
    assert(signalled, "the viewer's own inbox signal arrives");

    // Another principal's notification is not found and is left untouched.
    const foreign = await api(fixture, `/v1/notifications/${theirs.id}`, {
      method: "PATCH",
      ifMatch: theirs.revision,
      body: { read: true, expectedCasVersion: theirs.revision },
    });
    assertEquals(foreign.status, 404);
    const foreignBody = await foreign.text();
    assert(!foreignBody.includes(otherId) && !foreignBody.includes(theirs.id));
    const after = await fixture.pgDatabase.query<{ read_at: Date | null }>(
      "select read_at from bakery.notifications where id = $1",
      [theirs.id],
    );
    assertEquals(after.rows[0]?.read_at, null);

    // Mark all touches only the viewer's rows; undo of it is theirs alone.
    await seedNotification(fixture, fixture.principalId);
    const marked = await api(fixture, "/v1/notifications/read-all", {
      method: "POST",
      body: { readBefore: new Date(Date.now() + 1_000).toISOString() },
    });
    assertEquals(marked.status, 201, await marked.clone().text());
    const { batchId } = await marked.json() as { batchId: string };
    assertEquals(
      (await fixture.pgDatabase.query<{ read_at: Date | null }>(
        "select read_at from bakery.notifications where id = $1",
        [theirs.id],
      )).rows[0]?.read_at,
      null,
      "mark all never reaches another recipient",
    );
    const undone = await api(fixture, "/v1/notifications/read-all/undo", {
      method: "POST",
      body: { batchId },
    });
    assertEquals(undone.status, 200, await undone.clone().text());
    const otherBatch = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.notification_read_batches (organization_id, recipient_id)
       values ($1, $2) returning id`,
      [fixture.organizationId, otherId],
    );
    const stolen = await api(fixture, "/v1/notifications/read-all/undo", {
      method: "POST",
      body: { batchId: otherBatch.rows[0]!.id },
    });
    assertEquals(stolen.status, 404, "another recipient's press is not found");
    await stolen.body?.cancel();
  } finally {
    await client?.close();
    await fixture.pgDatabase.query(
      "delete from bakery.notifications where organization_id = $1",
      [fixture.organizationId],
    );
    await fixture.pgDatabase.query(
      "delete from bakery.notification_read_batches where organization_id = $1",
      [fixture.organizationId],
    );
    await cleanupAuthFixture(fixture.pgDatabase, [fixture.email]);
    await fixture.pgDatabase.query(
      "delete from bakery.principals where id = $1",
      [otherId],
    );
    await fixture.close();
  }
});
