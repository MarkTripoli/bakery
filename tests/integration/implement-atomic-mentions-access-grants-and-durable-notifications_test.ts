import { assert, assertEquals } from "@std/assert";
import {
  authTestOrigin,
  openAuthFixture,
  signSessionCookie,
} from "../helpers/auth.ts";

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
    const responses = await Promise.all([
      ...[0, 1, 2].map(() =>
        w.send(writer, raced, { mentions, clientMessageId }, sameKey)
      ),
      ...[0, 1, 2].map(() =>
        w.send(writer, raced, { mentions, clientMessageId })
      ),
    ]);
    const statuses = responses.map((response) => response.status);
    assert(
      statuses.includes(201),
      "one request is committed: " + JSON.stringify(statuses),
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
          assert(
            (await w.read(newcomer, chat)).status >= 400,
            "a removed recipient cannot read",
          );
        }
      }
    }
  } finally {
    await w.close();
  }
});
