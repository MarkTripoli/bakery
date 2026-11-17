import { assert, assertEquals } from "@std/assert";
import { authTestOrigin, openAuthFixture } from "../helpers/auth.ts";
import { cleanupSeededOrganizations } from "../helpers/coordinator-turns.ts";
import {
  type Fixture,
  request,
  type Seed,
  seedLiveAttempt,
  seedOrganization,
  seedTask,
} from "../helpers/durable-questions.ts";

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

async function seedSessionWithMessage(
  fixture: Fixture,
  seed: Seed,
): Promise<{ agentSessionId: string; body: string }> {
  const taskId = await seedTask(fixture, seed);
  const ids = await seedLiveAttempt(fixture, seed, taskId, []);
  const body = "streamed body";
  const posted = await request(
    fixture,
    seed,
    `/v1/conversations/${seed.conversationId}/messages`,
    {
      method: "POST",
      body: {
        body,
        clientMessageId: crypto.randomUUID(),
        intent: "discussion",
      },
    },
  );
  assertEquals(posted.status, 201);
  return { agentSessionId: ids.agentSessionId, body };
}

/** Reads SSE frames until `want` items arrived, then cancels the stream. */
async function readFeedEvents(
  response: Response,
  want: number,
): Promise<{ ids: string[]; items: { sequence: string }[] }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const ids: string[] = [];
  const items: { sequence: string }[] = [];
  let buffer = "";
  try {
    while (items.length < want) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
        const id = frame.match(/^id: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (id) ids.push(id);
        if (data) {
          items.push(JSON.parse(data) as { sequence: string });
          if (items.length >= want) break;
        }
      }
    }
  } finally {
    await reader.cancel();
  }
  return { ids, items };
}

Deno.test("AC: the feed streams typed items as server-sent events", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "session-feed-stream");
    const { agentSessionId } = await seedSessionWithMessage(fixture, seed);

    const response = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/sessions/${agentSessionId}/feed/stream`,
        {
          headers: {
            cookie: seed.cookie,
            "Bakery-Organization-Id": seed.organizationId,
            accept: "text/event-stream",
          },
        },
      ),
    );
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("content-type"),
      "text/event-stream; charset=utf-8",
    );

    const { ids, items } = await readFeedEvents(response, 1);
    assertEquals(items.length, 1);
    // The SSE `id:` is the item sequence a reconnect replays as Last-Event-ID.
    assertEquals(ids[0], items[0].sequence);
  }));

Deno.test("AC: the stream refuses a caller outside the session's organization", () =>
  withFixture(async (fixture) => {
    const owner = await seedOrganization(fixture, "session-stream-owner");
    const outsider = await seedOrganization(fixture, "session-stream-outsider");
    const { agentSessionId } = await seedSessionWithMessage(fixture, owner);

    const response = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/sessions/${agentSessionId}/feed/stream`,
        {
          headers: {
            cookie: outsider.cookie,
            "Bakery-Organization-Id": outsider.organizationId,
            accept: "text/event-stream",
          },
        },
      ),
    );
    // The stream authorizes through `sessions.feed`, so the refusal is the same
    // 404 a JSON reader gets: a caller cannot learn the session exists.
    assertEquals(response.status, 404);
    const problem = await response.json() as { code: string };
    assertEquals(problem.code, "RESOURCE_NOT_FOUND");
  }));

Deno.test("AC: an unauthenticated stream is refused", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "session-stream-anon");
    const { agentSessionId } = await seedSessionWithMessage(fixture, seed);
    const response = await fixture.app.fetch(
      new Request(
        `${authTestOrigin}/v1/sessions/${agentSessionId}/feed/stream`,
        { headers: { accept: "text/event-stream" } },
      ),
    );
    assert(
      response.status === 401 || response.status === 403,
      `expected an auth refusal, got ${response.status}`,
    );
  }));
