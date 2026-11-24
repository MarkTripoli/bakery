import { assert, assertEquals } from "@std/assert";
import {
  authTestOrigin,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";
import { openSocketFixture } from "../helpers/events-socket.ts";

/**
 * #54 slice 1: one mention send under duplicates and races, through the real
 * routes, authority runner and Postgres. The sequential cases (grant, refusal,
 * agent writer, revoke) live in mentions-and-task-access_test.ts; this file
 * proves the parts that need two requests at once: one message, grant,
 * notification, receipt and domain event for concurrent duplicates, and
 * all-or-nothing when the recipient or the sender changes mid-send.
 */

type Fixture = Awaited<ReturnType<typeof openAuthFixture>>;
type Person = { principalId: string; cookie: string };

async function count(
  fixture: Fixture,
  sql: string,
  values: unknown[],
): Promise<number> {
  const result = await fixture.pgDatabase.query<{ count: number }>(
    `select count(*)::int as count ${sql}`,
    values,
  );
  return result.rows[0]?.count ?? 0;
}

async function world() {
  const fixture = await openAuthFixture();
  const org = crypto.randomUUID();
  const now = new Date();
  const users: string[] = [];
  const principals: string[] = [];
  const tag = crypto.randomUUID().slice(0, 8);
  await fixture.pgDatabase.query(
    `insert into bakery.organizations (
       id, name, slug, metadata, created_at, updated_at, version
     ) values ($1, 'Mention Race Org', $2, '{}'::jsonb, $3, $3, 1)`,
    [org, `mention-race-${org}`, now],
  );

  const human = async (name: string, role: string): Promise<Person> => {
    const userId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    users.push(userId);
    principals.push(principalId);
    await fixture.pgDatabase.query(
      `insert into public."user" (
         id, name, email, "emailVerified", "createdAt", "updatedAt"
       ) values ($1, $2, $3, true, $4, $4)`,
      [
        userId,
        name,
        `${
          name.toLowerCase().replaceAll(" ", ".")
        }-${tag}-${users.length}@example.test`,
        now,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.principals (
         id, provider_user_id, display_name, principal_type
       ) values ($1, $2, $3, 'human')`,
      [principalId, userId, `${name} ${tag}`],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.organization_memberships (
         id, organization_id, principal_id, role, status, joined_at,
         created_at, updated_at, version
       ) values ($1, $2, $3, $4, 'active', $5, $5, $5, 1)`,
      [crypto.randomUUID(), org, principalId, role, now],
    );
    const token = `mention-race-${crypto.randomUUID()}`;
    await fixture.pgDatabase.query(
      `insert into public.session (
         id, token, "userId", "expiresAt", "createdAt", "updatedAt"
       ) values ($1, $2, $3, $4, $5, $5)`,
      [
        crypto.randomUUID(),
        token,
        userId,
        new Date(now.getTime() + 3_600_000),
        now,
      ],
    );
    return {
      principalId,
      cookie: await signSessionCookie(token, fixture.config.auth!.secret),
    };
  };

  const conversation = async (createdBy: Person): Promise<string> => {
    const id = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.conversations (id, organization_id, title, created_by)
       values ($1, $2, 'Mention race chat', $3)`,
      [id, org, createdBy.principalId],
    );
    return id;
  };

  const send = (
    who: Person,
    conversationId: string,
    body: Record<string, unknown>,
    key: string = crypto.randomUUID(),
  ) =>
    fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: {
            cookie: who.cookie,
            "Bakery-Organization-Id": org,
            origin: authTestOrigin,
            "content-type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify({
            body: "please look",
            clientMessageId: crypto.randomUUID(),
            intent: "discussion",
            ...body,
          }),
        },
      ),
    );

  const read = (who: Person, conversationId: string) =>
    fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/conversations/${conversationId}/messages`,
        {
          headers: { cookie: who.cookie, "Bakery-Organization-Id": org },
        },
      ),
    );

  /** Every row one conversation's mention sends committed, by table. */
  const footprint = async (conversationId: string) => ({
    messages: await count(
      fixture,
      "from bakery.messages where conversation_id = $1",
      [conversationId],
    ),
    mentions: await count(
      fixture,
      `from bakery.message_mentions as mention
       join bakery.messages as message
         on message.organization_id = mention.organization_id
        and message.id = mention.message_id
       where message.conversation_id = $1`,
      [conversationId],
    ),
    grants: await count(
      fixture,
      "from bakery.conversation_access_grants where conversation_id = $1",
      [conversationId],
    ),
    notifications: await count(
      fixture,
      `from bakery.notifications as item
       join bakery.messages as message
         on message.organization_id = item.organization_id
        and message.id = item.target_id
       where message.conversation_id = $1`,
      [conversationId],
    ),
    events: await count(
      fixture,
      `from bakery.domain_events as event
       join bakery.messages as message
         on message.organization_id = event.organization_id
        and message.id = event.aggregate_id
       where message.conversation_id = $1`,
      [conversationId],
    ),
  });

  const close = async () => {
    try {
      await fixture.pgDatabase.query(
        `delete from public.session where "userId" = any($1::uuid[])`,
        [users],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.organizations where id = $1",
        [org],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.principals where id = any($1::uuid[])",
        [principals],
      );
      await fixture.pgDatabase.query(
        'delete from public."user" where id = any($1::uuid[])',
        [users],
      );
    } finally {
      await fixture.close();
    }
  };

  return {
    fixture,
    org,
    human,
    conversation,
    send,
    read,
    footprint,
    close,
  };
}

Deno.test("duplicate sends racing one mention commit the same rows as one send", async () => {
  const w = await world();
  try {
    const writer = await w.human("Wren Writer", "developer");
    const reader = await w.human("Rey Reader", "developer");
    const newcomer = await w.human("Nia Newcomer", "viewer");
    const mentions = [newcomer.principalId, reader.principalId];

    // The baseline: the same send, once, in its own chat.
    const control = await w.conversation(writer);
    const once = await w.send(writer, control, { mentions });
    assertEquals(once.status, 201, await once.clone().text());
    const baseline = await w.footprint(control);
    assertEquals(baseline.messages, 1);
    assertEquals(baseline.mentions, 2);
    assertEquals(baseline.grants, 1, "only the newcomer is granted");
    assertEquals(baseline.notifications, 2);
    assert(baseline.events > 0, "the send is announced");

    // Six requests at once: one idempotency key sent three times, and three
    // other keys carrying the same message id.
    const raced = await w.conversation(writer);
    const sameKey = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();
    const startedAt = performance.now();
    const timings: string[] = [];
    const timed = async (pending: Response | Promise<Response>) => {
      const response = await pending;
      timings.push(
        `${response.status}@${Math.round(performance.now() - startedAt)}ms`,
      );
      return response;
    };
    const responses = await Promise.all([
      ...[0, 1, 2].map(() =>
        timed(w.send(writer, raced, { mentions, clientMessageId }, sameKey))
      ),
      ...[0, 1, 2].map(() =>
        timed(w.send(writer, raced, { mentions, clientMessageId }))
      ),
    ]);
    const statuses = responses.map((response) => response.status);
    console.log("mention race timings:", timings.join(" "));
    assert(
      statuses.includes(201),
      "one request is committed: " + JSON.stringify(timings),
    );
    for (const response of responses) {
      assert(
        [201, 409].includes(response.status),
        "a duplicate replays or is told to retry, never errors: " +
          response.status,
      );
    }
    const ids = new Set<string>();
    for (const response of responses) {
      if (response.status === 201) {
        ids.add((await response.json() as { id: string }).id);
      }
    }
    assertEquals(ids.size, 1, "every committed answer names the same message");
    assertEquals(await w.footprint(raced), baseline, "same rows as one send");
    assertEquals(
      await count(
        w.fixture,
        `from bakery.idempotency_records
         where organization_id = $1 and key = $2 and status = 'completed'`,
        [w.org, sameKey],
      ),
      1,
      "one completed receipt for the shared key",
    );

    // A replay after the race adds nothing either.
    const again = await w.send(
      writer,
      raced,
      { mentions, clientMessageId },
      sameKey,
    );
    assertEquals(again.status, 201);
    assertEquals(await w.footprint(raced), baseline);
  } finally {
    await w.close();
  }
});

Deno.test("two senders mentioning the same person at once give one grant and one notification each", async () => {
  const w = await world();
  try {
    const first = await w.human("Fay First", "developer");
    const second = await w.human("Sal Second", "developer");
    const newcomer = await w.human("Nia Newcomer", "viewer");
    const chat = await w.conversation(first);
    const [a, b] = await Promise.all([
      w.send(first, chat, { mentions: [newcomer.principalId] }),
      w.send(second, chat, { mentions: [newcomer.principalId] }),
    ]);
    assertEquals(a.status, 201, await a.clone().text());
    assertEquals(b.status, 201, await b.clone().text());
    const rows = await w.footprint(chat);
    assertEquals(rows.messages, 2);
    assertEquals(rows.grants, 1, "one effective grant per person per chat");
    assertEquals(rows.notifications, 2, "one item per source message");
    assertEquals((await w.read(newcomer, chat)).status, 200);
  } finally {
    await w.close();
  }
});

Deno.test("a send racing the recipient's removal or the sender's demotion is all or nothing", async () => {
  const w = await world();
  try {
    for (const change of ["recipient", "sender"] as const) {
      for (let round = 0; round < 4; round++) {
        const writer = await w.human("Wren Writer", "developer");
        const newcomer = await w.human("Nia Newcomer", "viewer");
        const chat = await w.conversation(writer);
        const target = change === "recipient" ? newcomer : writer;
        const [response] = await Promise.all([
          w.send(writer, chat, { mentions: [newcomer.principalId] }),
          w.fixture.pgDatabase.query(
            change === "recipient"
              ? `update bakery.organization_memberships set status = 'inactive'
                 where organization_id = $1 and principal_id = $2`
              : `update bakery.organization_memberships set role = 'viewer'
                 where organization_id = $1 and principal_id = $2`,
            [w.org, target.principalId],
          ),
        ]);
        const rows = await w.footprint(chat);
        if (response.status === 201) {
          assertEquals(rows.messages, 1, change + ": committed whole");
          assertEquals(rows.grants, 1);
          assertEquals(rows.notifications, 1);
        } else {
          assert(
            [403, 422].includes(response.status),
            change + ": refused, not an error: " + response.status,
          );
          assertEquals(
            [rows.messages, rows.mentions, rows.grants, rows.notifications],
            [0, 0, 0, 0],
            change + ": a refused send writes nothing",
          );
        }
        if (change === "recipient") {
          // Whatever the order, a removed member reads nothing through a grant.
          assertEquals(
            (await w.read(newcomer, chat)).status,
            404,
            "a removed recipient cannot read",
          );
        }
      }
    }
  } finally {
    await w.close();
  }
});

type Inbox = Awaited<ReturnType<typeof openSocketFixture>>;

/** One inbox row for the fixture's person. */
async function arrive(
  fixture: Inbox,
  targetId: string = crypto.randomUUID(),
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
      targetId,
      fixture.taskId,
      event.id,
    ],
  );
  return row.rows[0]!;
}

function inbox(
  fixture: Inbox,
  method: "GET" | "PATCH" | "POST",
  path: string,
  options: { body?: unknown; ifMatch?: number; organizationId?: string } = {},
): Promise<Response> {
  const headers = new Headers({
    cookie: fixture.cookie,
    "Bakery-Organization-Id": options.organizationId ?? fixture.organizationId,
  });
  if (method !== "GET") {
    headers.set("origin", authTestOrigin);
    headers.set("content-type", "application/json");
    headers.set("Idempotency-Key", crypto.randomUUID());
  }
  if (options.ifMatch !== undefined) {
    headers.set("If-Match", `"${options.ifMatch}"`);
  }
  return Promise.resolve(fixture.app.fetch(
    new Request(`${authTestOrigin}${path}`, {
      method,
      headers,
      ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }),
    }),
  ));
}

async function body<T>(
  pending: Response | Promise<Response>,
  status: number,
): Promise<T> {
  const response = await pending;
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as T;
}

type Row = { id: string; revision: number; readAt: string | null };

Deno.test("mark all read at a cutoff leaves a racing arrival unread, and the other session's stale revision is discarded", async () => {
  const fixture = await openSocketFixture();
  try {
    const older = await arrive(fixture);
    await arrive(fixture);
    const cutoff = (await fixture.pgDatabase.query<{ now: Date }>(
      "select clock_timestamp() as now",
    )).rows[0]!.now.toISOString();
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Session B holds the first row's revision from before the bulk read.
    const seenByB = older.revision;

    // The arrival lands while session A's mark-all-read is in flight.
    const [marked, arrival] = await Promise.all([
      inbox(fixture, "POST", "/v1/notifications/read-all", {
        body: { readBefore: cutoff },
      }),
      arrive(fixture),
    ]);
    assertEquals(
      (await body<{ marked: number }>(marked, 201)).marked,
      2,
      "only what existed at the cutoff",
    );
    const unread = await body<{ items: Row[] }>(
      await inbox(fixture, "GET", "/v1/notifications?filter=unread&limit=50"),
      200,
    );
    assertEquals(
      unread.items.map((item) => item.id),
      [arrival.id],
      "the arrival stays unread",
    );
    assertEquals(
      (await body<{ unread: number }>(
        await inbox(fixture, "GET", "/v1/notifications/count"),
        200,
      )).unread,
      1,
    );

    // Session B now writes with the revision it saw before: discarded.
    const stale = await inbox(
      fixture,
      "PATCH",
      `/v1/notifications/${older.id}`,
      {
        body: { read: false, expectedCasVersion: seenByB },
        ifMatch: seenByB,
      },
    );
    assertEquals(stale.status, 409, await stale.text());
    const current = await body<Row>(
      await inbox(fixture, "GET", `/v1/notifications/${older.id}`),
      200,
    );
    assert(current.revision > seenByB, "revisions only move forward");
    assert(current.readAt !== null, "the bulk read stands");

    // Refetching and writing in order succeeds, and each write moves it on.
    const unreadAgain = await body<Row>(
      await inbox(fixture, "PATCH", `/v1/notifications/${older.id}`, {
        body: { read: false, expectedCasVersion: current.revision },
        ifMatch: current.revision,
      }),
      200,
    );
    assert(unreadAgain.revision > current.revision);
  } finally {
    await fixture.close();
  }
});

Deno.test("a live mention names its message so the page can open there", async () => {
  const fixture = await openSocketFixture();
  try {
    const messageId = crypto.randomUUID();
    const item = await arrive(fixture, messageId);
    const target = await body<
      { status: string; path: string | null; anchor: string | null }
    >(inbox(fixture, "GET", `/v1/notifications/${item.id}/target`), 200);
    assertEquals(target.status, "available");
    assertEquals(target.path, `/tasks/${fixture.taskId}`);
    assertEquals(target.anchor, `message:${messageId}`);
  } finally {
    await fixture.close();
  }
});

Deno.test("a deleted part opens its task with no anchor, and an unreachable task shows no title", async () => {
  const fixture = await openSocketFixture();
  try {
    const secret = "SECRET-TASK-TITLE-" + crypto.randomUUID().slice(0, 8);
    await fixture.pgDatabase.query(
      "update bakery.tasks set title = $2 where id = $1",
      [fixture.taskId, secret],
    );
    const item = await arrive(fixture, crypto.randomUUID());
    const target = () =>
      body<{ status: string; path: string | null; anchor: string | null }>(
        inbox(fixture, "GET", `/v1/notifications/${item.id}/target`),
        200,
      );

    // The message is gone but its task still opens: no dead anchor.
    const part = await target();
    assertEquals(part.status, "part_unavailable");
    assertEquals(part.path, `/tasks/${fixture.taskId}`);
    assertEquals(part.anchor, null);

    // No reachable task: unavailable, and the task's title is nowhere.
    await fixture.pgDatabase.query(
      "update bakery.notifications set task_id = null where id = $1",
      [item.id],
    );
    const gone = await target();
    assertEquals(gone.status, "unavailable");
    assertEquals(gone.path, null);
    assertEquals(gone.anchor, null);
    const listed = await body<{
      items: {
        id: string;
        destination: { title: string | null; available: boolean };
      }[];
    }>(inbox(fixture, "GET", "/v1/notifications?limit=50"), 200);
    const row = listed.items.find((entry) => entry.id === item.id)!;
    assertEquals(row.destination, { title: null, available: false });
    const detail = await (await inbox(
      fixture,
      "GET",
      `/v1/notifications/${item.id}`,
    )).text();
    for (const text of [detail, JSON.stringify(gone), JSON.stringify(row)]) {
      assert(!text.includes(secret), "the protected title never appears");
    }

    // Deleting the task takes its notifications with it: nothing is left to
    // show, so no stale row can keep a title alive.
    await fixture.pgDatabase.query(
      "update bakery.notifications set task_id = $2 where id = $1",
      [item.id, fixture.taskId],
    );
    await fixture.pgDatabase.query("delete from bakery.tasks where id = $1", [
      fixture.taskId,
    ]);
    const after = await inbox(fixture, "GET", `/v1/notifications/${item.id}`);
    assertEquals(after.status, 404, await after.text());
  } finally {
    await fixture.close();
  }
});

Deno.test("a cursor pages without repeats, and another organization's scope reaches nothing", async () => {
  const fixture = await openSocketFixture();
  try {
    const made = [];
    for (let index = 0; index < 5; index++) made.push(await arrive(fixture));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { items: Row[]; nextCursor: string | null } = await body(
        await inbox(
          fixture,
          "GET",
          `/v1/notifications?limit=2${
            cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
          }`,
        ),
        200,
      );
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    assertEquals(new Set(seen).size, seen.length, "no row repeats");
    assertEquals(new Set(seen), new Set(made.map((item) => item.id)));

    // A cursor issued in this organization, and an id from it, mean nothing
    // under a second organization the same person is a member of.
    const other = crypto.randomUUID();
    const now = new Date();
    await fixture.pgDatabase.query(
      `insert into bakery.organizations (
         id, name, slug, metadata, created_at, updated_at, version
       ) values ($1, 'Second Inbox Org', $2, '{}'::jsonb, $3, $3, 1)`,
      [other, `second-inbox-${other}`, now],
    );
    try {
      await fixture.pgDatabase.query(
        `insert into bakery.organization_memberships (
           id, organization_id, principal_id, role, status, joined_at,
           created_at, updated_at, version
         ) values ($1, $2, $3, 'admin', 'active', $4, $4, $4, 1)`,
        [crypto.randomUUID(), other, fixture.principalId, now],
      );
      const first: { nextCursor: string } = await body(
        await inbox(fixture, "GET", "/v1/notifications?limit=2"),
        200,
      );
      const crossList = await inbox(
        fixture,
        "GET",
        `/v1/notifications?limit=2&cursor=${
          encodeURIComponent(first.nextCursor)
        }`,
        { organizationId: other },
      );
      const crossText = await crossList.text();
      assertEquals(
        crossList.status,
        400,
        "the first organization's cursor is refused under the second: " +
          crossText,
      );
      assert(crossText.includes("invalid-cursor"), crossText);
      for (const item of made) {
        assert(
          !crossText.includes(item.id),
          "none of the first organization's rows",
        );
      }
      const crossRead = await inbox(
        fixture,
        "GET",
        `/v1/notifications/${made[0]!.id}`,
        { organizationId: other },
      );
      assertEquals(
        crossRead.status,
        404,
        "an id from the first organization is not found in the second",
      );
      await crossRead.body?.cancel();
      // Under the second organization the person's own inbox is empty.
      const empty = await body<{ items: Row[] }>(
        await inbox(fixture, "GET", "/v1/notifications?limit=50", {
          organizationId: other,
        }),
        200,
      );
      assertEquals(empty.items, []);
    } finally {
      await fixture.pgDatabase.query(
        "delete from bakery.organization_memberships where organization_id = $1",
        [other],
      );
      await fixture.pgDatabase.query(
        "delete from bakery.organizations where id = $1",
        [other],
      );
    }
  } finally {
    await fixture.close();
  }
});
