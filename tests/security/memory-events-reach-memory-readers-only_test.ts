import { assert, assertEquals } from "@std/assert";
import {
  openSocketFixture,
  type SocketFixture,
} from "../helpers/events-socket.ts";
import type { WsClient } from "../helpers/ws-client.ts";

/**
 * #72 live updates. The signals of remembered facts (memories.created,
 * memories.updated, memory.revised, memory.source_changed) reach a subscriber
 * only through the `memory` scope, and that scope opens only to someone who may
 * read memory, whether or not they may read the events stream. No other scope
 * delivers them, whatever columns they carry.
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

async function open(fixture: SocketFixture): Promise<WsClient> {
  const connected = await fixture.connect({ cookie: fixture.cookie });
  assert("send" in connected, "the member may open the events socket");
  assertEquals((await next(connected)).type, "hello");
  return connected;
}

async function subscribe(client: WsClient, scopes: unknown[]): Promise<Frame> {
  await client.send(JSON.stringify({
    type: "subscribe",
    requestId: crypto.randomUUID(),
    scopes,
    after: null,
  }));
  return await next(client);
}

/** The event types that arrive within the window, in order. */
async function typesWithin(client: WsClient, ms: number): Promise<string[]> {
  const seen: string[] = [];
  const until = Date.now() + ms;
  while (Date.now() < until) {
    let frame: Frame;
    try {
      frame = await next(client, Math.max(50, until - Date.now()));
    } catch {
      break;
    }
    if (frame.type === "events") {
      for (const event of frame.events as { type: string }[]) {
        seen.push(event.type);
      }
    }
  }
  return seen;
}

/** A memory signal as the server writes it for an organization: no task, application or conversation. */
function memoryEvent(
  fixture: SocketFixture,
  eventType: string,
  over: { taskId?: null; applicationId?: null; conversationId?: null } = {},
) {
  return fixture.insertDomainEvent({
    eventType,
    applicationId: null,
    taskId: null,
    conversationId: null,
    ...over,
  });
}

const MEMORY_TYPES = [
  "memories.created",
  "memories.updated",
  "memory.revised",
  "memory.source_changed",
];

Deno.test("the memory scope is the organization's and delivers only memory signals, in order", async () => {
  const fixture = await openSocketFixture();
  try {
    const client = await open(fixture);
    assertEquals(
      problemCode(
        await subscribe(client, [{ type: "memory", id: crypto.randomUUID() }]),
      ),
      "RESOURCE_NOT_FOUND",
      "another organization's memory scope is indistinguishable from none",
    );
    const reply = await subscribe(client, [
      { type: "memory", id: fixture.organizationId },
    ]);
    assertEquals(reply.type, "cursor", JSON.stringify(reply));
    for (const eventType of MEMORY_TYPES) await memoryEvent(fixture, eventType);
    // Not a memory signal: the memory scope never carries it.
    await fixture.insertDomainEvent({
      eventType: "conversation.message_created",
    });
    assertEquals(await typesWithin(client, 2_000), MEMORY_TYPES);
  } finally {
    await fixture.close();
  }
});

Deno.test("a cursor taken from the memory scope resumes it", async () => {
  const fixture = await openSocketFixture();
  try {
    const first = await open(fixture);
    const reply = await subscribe(first, [
      { type: "memory", id: fixture.organizationId },
    ]);
    assertEquals(reply.type, "cursor", JSON.stringify(reply));
    await memoryEvent(fixture, "memory.revised");
    await memoryEvent(fixture, "memories.updated");
    const second = await open(fixture);
    await second.send(JSON.stringify({
      type: "resume",
      requestId: crypto.randomUUID(),
      cursor: reply.cursor,
    }));
    assertEquals(await typesWithin(second, 2_000), [
      "memory.revised",
      "memories.updated",
    ]);
  } finally {
    await fixture.close();
  }
});

Deno.test("memory signals never ride another scope, whatever columns they carry", async () => {
  const fixture = await openSocketFixture();
  try {
    const client = await open(fixture);
    const reply = await subscribe(client, [
      { type: "task", id: fixture.taskId },
      { type: "application", id: fixture.applicationId },
      { type: "conversation", id: fixture.conversationId },
    ]);
    assertEquals(reply.type, "cursor", JSON.stringify(reply));
    // Tagged with the task, the application and the conversation, as an event
    // written before the memory scope existed may be.
    await fixture.insertDomainEvent({ eventType: "memory.revised" });
    await fixture.insertDomainEvent({ eventType: "memories.updated" });
    await fixture.insertDomainEvent({
      eventType: "conversation.message_created",
    });
    assertEquals(await typesWithin(client, 2_000), [
      "conversation.message_created",
    ]);
  } finally {
    await fixture.close();
  }
});

Deno.test("a viewer, who may read memory but not the events stream, gets the memory scope and nothing else", async () => {
  const fixture = await openSocketFixture();
  try {
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships set role = 'viewer'
       where organization_id = $1 and principal_id = $2`,
      [fixture.organizationId, fixture.principalId],
    );
    const client = await open(fixture);
    assertEquals(
      problemCode(
        await subscribe(client, [{ type: "task", id: fixture.taskId }]),
      ),
      "RESOURCE_NOT_FOUND",
      "no event:read, so no task scope",
    );
    assertEquals(
      problemCode(
        await subscribe(client, [
          { type: "memory", id: fixture.organizationId },
          { type: "task", id: fixture.taskId },
        ]),
      ),
      "RESOURCE_NOT_FOUND",
      "the memory scope does not carry other scopes along",
    );
    const reply = await subscribe(client, [
      { type: "memory", id: fixture.organizationId },
    ]);
    assertEquals(reply.type, "cursor", JSON.stringify(reply));
    await memoryEvent(fixture, "memories.created");
    assertEquals(await typesWithin(client, 2_000), ["memories.created"]);
  } finally {
    await fixture.close();
  }
});

Deno.test("a member who may read the events stream but not memory cannot subscribe to it and is sent none", async () => {
  const fixture = await openSocketFixture();
  try {
    const role = await fixture.pgDatabase.query<{ id: string }>(
      `insert into bakery.organization_roles (
         organization_id, key, name, permissions, created_by_principal_id
       ) values ($1, 'events-without-memory', 'Events without memory',
                 array['event:read', 'task:read'], $2)
       returning id`,
      [fixture.organizationId, fixture.principalId],
    );
    await fixture.pgDatabase.query(
      `update bakery.organization_memberships
          set role = 'guest', custom_role_id = $3
        where organization_id = $1 and principal_id = $2`,
      [fixture.organizationId, fixture.principalId, role.rows[0]!.id],
    );
    const client = await open(fixture);
    assertEquals(
      problemCode(
        await subscribe(client, [{
          type: "memory",
          id: fixture.organizationId,
        }]),
      ),
      "RESOURCE_NOT_FOUND",
      "without memory:read the memory scope answers like one that does not exist",
    );
    // The same member's task scope still works, and the memory signal is not in it.
    const reply = await subscribe(client, [{
      type: "task",
      id: fixture.taskId,
    }]);
    assertEquals(reply.type, "cursor", JSON.stringify(reply));
    await fixture.insertDomainEvent({ eventType: "memory.revised" });
    await fixture.insertDomainEvent({
      eventType: "conversation.message_created",
    });
    assertEquals(await typesWithin(client, 2_000), [
      "conversation.message_created",
    ]);
  } finally {
    await fixture.close();
  }
});
