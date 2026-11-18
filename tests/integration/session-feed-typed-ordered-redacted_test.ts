import { assert, assertEquals } from "@std/assert";
import { openAuthFixture } from "../helpers/auth.ts";
import { cleanupSeededOrganizations } from "../helpers/coordinator-turns.ts";
import {
  type Fixture,
  request,
  type Seed,
  seedLiveAttempt,
  seedOrganization,
  seedTask,
} from "../helpers/durable-questions.ts";

type FeedItem = {
  id: string;
  sessionId: string;
  sequence: string;
  kind: string;
  occurredAt: string;
  redacted: boolean;
  message: {
    messageId: string;
    authorId: string | null;
    authorKind: string;
    messageType: string;
    body: string;
  } | null;
  terminal: unknown;
  status: unknown;
  tool: unknown;
  fileChange: unknown;
  artifact: unknown;
  usage: unknown;
  deliveredInput: { messageId: string; body: string } | null;
};

type Feed = { items: FeedItem[]; nextCursor: string | null };

async function withFixture(
  work: (fixture: Fixture) => Promise<void>,
): Promise<void> {
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

async function seedSessionMessages(
  fixture: Fixture,
  seed: Seed,
): Promise<{ ids: { agentSessionId: string }; bodies: string[] }> {
  const taskId = await seedTask(fixture, seed);
  const ids = await seedLiveAttempt(fixture, seed, taskId, []);
  const bodies: string[] = [];
  for (
    const [index, intent] of [
      "discussion",
      "agent_request",
      "discussion",
    ].entries()
  ) {
    const body = `feed body ${index}`;
    const response = await request(
      fixture,
      seed,
      `/v1/conversations/${seed.conversationId}/messages`,
      {
        method: "POST",
        body: { body, clientMessageId: crypto.randomUUID(), intent },
      },
    );
    assertEquals(response.status, 201);
    bodies.push(body);
  }
  return { ids, bodies };
}

Deno.test("AC: the session feed returns typed, ordered items keyed by session", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "session-feed-shaped");
    const { ids, bodies } = await seedSessionMessages(fixture, seed);

    const response = await request(
      fixture,
      seed,
      `/v1/sessions/${ids.agentSessionId}/feed`,
    );
    assertEquals(response.status, 200);
    const feed = await response.json() as Feed;

    assertEquals(feed.items.length, bodies.length);
    for (const item of feed.items) {
      // Every item is keyed by the session it was read from.
      assertEquals(item.sessionId, ids.agentSessionId);
      // `kind` names exactly one non-null payload, and the others stay null.
      const payloads = [
        "message",
        "terminal",
        "status",
        "tool",
        "fileChange",
        "artifact",
        "usage",
        "deliveredInput",
      ] as const;
      const present = payloads.filter((name) => item[name] !== null);
      assertEquals(present.length, 1, `item ${item.id} carries one payload`);
      assert(
        present[0] === "message" || present[0] === "deliveredInput",
        `unexpected kind ${item.kind}`,
      );
    }

    // Ordered forward by sequence, strictly ascending.
    const sequences = feed.items.map((item) => BigInt(item.sequence));
    for (let index = 1; index < sequences.length; index += 1) {
      assert(sequences[index] > sequences[index - 1], "sequence ascends");
    }

    // An agent_request message is a delivered input, everything else a message.
    const delivered = feed.items.filter((item) =>
      item.kind ===
        "delivered_input"
    );
    assertEquals(delivered.length, 1);
    assertEquals(delivered[0].deliveredInput?.body, bodies[1]);
    const messages = feed.items.filter((item) => item.kind === "message");
    assertEquals(messages.length, bodies.length - 1);
    assertEquals(
      messages.map((item) => item.message?.body),
      [bodies[0], bodies[2]],
    );
    // The feed carries no secret material: redaction is a projection, not a flag.
    for (const item of feed.items) {
      assertEquals(item.redacted, false);
    }
  }));

Deno.test("AC: the feed pages forward from a cursor without gap or duplicate", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "session-feed-paged");
    const { ids, bodies } = await seedSessionMessages(fixture, seed);
    const path = `/v1/sessions/${ids.agentSessionId}/feed`;

    const first = await (await request(fixture, seed, `${path}?limit=2`))
      .json() as Feed;
    assertEquals(first.items.length, 2);
    assert(first.nextCursor !== null, "a first page of two has a next cursor");

    const second = await (await request(
      fixture,
      seed,
      `${path}?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    )).json() as Feed;
    assertEquals(second.items.length, bodies.length - 2);

    const seen = [...first.items, ...second.items].map((item) => item.id);
    assertEquals(new Set(seen).size, seen.length, "no item is repeated");
    assertEquals(seen.length, bodies.length, "no item is skipped");
    const sequences = seen.length;
    assertEquals(sequences, bodies.length);
  }));

Deno.test("AC: the feed is scoped to the caller's organization", () =>
  withFixture(async (fixture) => {
    const owner = await seedOrganization(fixture, "session-feed-owner");
    const outsider = await seedOrganization(fixture, "session-feed-outsider");
    const { ids } = await seedSessionMessages(fixture, owner);

    const response = await request(
      fixture,
      { cookie: outsider.cookie, organizationId: outsider.organizationId },
      `/v1/sessions/${ids.agentSessionId}/feed`,
    );
    assertEquals(response.status, 404);
    const problem = await response.json() as { code: string };
    assertEquals(problem.code, "RESOURCE_NOT_FOUND");
  }));

Deno.test("AC: a malformed cursor is refused rather than silently ignored", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "session-feed-cursor");
    const { ids } = await seedSessionMessages(fixture, seed);
    const response = await request(
      fixture,
      seed,
      `/v1/sessions/${ids.agentSessionId}/feed?cursor=not-a-cursor`,
    );
    assertEquals(response.status, 400);
    const problem = await response.json() as { code: string };
    assertEquals(problem.code, "INVALID_CURSOR");
  }));

// A sentinel that looks like secret material a projection must not expose. It is
// checked against the WHOLE serialized body, not one field: the defect worth
// catching is a sentinel surfacing in a field nobody remembered.
const LEASE_SENTINEL = "lease_2f9c4d1e-8a76-4b03-9c55-SENTINEL-DO-NOT-LEAK";

Deno.test("AC: the projection exposes no column it does not name", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "session-feed-sentinel");
    const taskId = await seedTask(fixture, seed);
    const ids = await seedLiveAttempt(fixture, seed, taskId, []);

    // Put the sentinel in a column the feed deliberately does NOT select.
    // `comment_context` is stored beside a message and is not part of the feed's
    // projection, so it stands in for any column carrying secret material: if
    // the projection ever widens to `select *`, this sentinel leaks.
    const inserted = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.messages
         (organization_id, conversation_id, message_type, body,
          client_message_id, sequence, intent, comment_context)
       values ($1, $2, 'user', 'a visible message', $3,
               (select coalesce(max(sequence), 0) + 1
                  from bakery.messages where conversation_id = $2),
               'discussion', $4::jsonb)
       returning id`,
      [
        seed.organizationId,
        seed.conversationId,
        crypto.randomUUID(),
        JSON.stringify({ leaseToken: LEASE_SENTINEL }),
      ],
    );
    assert(inserted.rows.length === 1);

    const response = await request(
      fixture,
      seed,
      `/v1/sessions/${ids.agentSessionId}/feed`,
    );
    assertEquals(response.status, 200);
    const serialized = await response.text();

    // The message itself is visible; the unselected column beside it is not.
    assertEquals(serialized.includes("a visible message"), true);
    assertEquals(
      serialized.includes(LEASE_SENTINEL),
      false,
      "the feed exposed a column its projection does not name",
    );

    // The mapper is the gate that actually holds: a column the SELECT happens to
    // return still cannot reach the wire, because each item is built from named
    // fields. This pins that shape, so widening the SELECT alone cannot start
    // leaking and spreading a raw row into the item cannot pass unnoticed.
    const feed = JSON.parse(serialized) as Feed;
    const expected = [
      "id",
      "sessionId",
      "sequence",
      "kind",
      "occurredAt",
      "redacted",
      "message",
      "terminal",
      "status",
      "tool",
      "fileChange",
      "artifact",
      "usage",
      "deliveredInput",
    ];
    for (const item of feed.items) {
      assertEquals(Object.keys(item).sort(), expected.sort());
    }
  }));
