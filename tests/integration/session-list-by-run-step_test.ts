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

type SessionPage = {
  items: {
    id: string;
    runStepId: string | null;
    conversationId: string;
    status: string;
  }[];
  nextCursor: string | null;
};

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

async function seedSession(
  fixture: Fixture,
  seed: Seed,
): Promise<{ stepId: string; agentSessionId: string }> {
  const taskId = await seedTask(fixture, seed);
  const ids = await seedLiveAttempt(fixture, seed, taskId, []);
  return { stepId: ids.stepId, agentSessionId: ids.agentSessionId };
}

Deno.test("AC: a run step's sessions are listed so a client can reach one by step", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "session-list-shape");
    const { stepId, agentSessionId } = await seedSession(fixture, seed);

    const response = await request(
      fixture,
      seed,
      `/v1/sessions?runStepId=${stepId}`,
    );
    assertEquals(response.status, 200);
    const page = await response.json() as SessionPage;

    assertEquals(page.items.length, 1);
    assertEquals(page.items[0].id, agentSessionId);
    assertEquals(page.items[0].runStepId, stepId);
    // The listed session is the one the by-id read returns.
    const direct = await request(
      fixture,
      seed,
      `/v1/sessions/${agentSessionId}`,
    );
    assertEquals(direct.status, 200);
    const session = await direct.json() as { conversationId: string };
    assertEquals(page.items[0].conversationId, session.conversationId);
    assertEquals(page.nextCursor, null);
  }));

Deno.test("AC: another organization's run step is not found rather than empty", () =>
  withFixture(async (fixture) => {
    const mine = await seedOrganization(fixture, "session-list-mine");
    const theirs = await seedOrganization(fixture, "session-list-theirs");
    const other = await seedSession(fixture, theirs);

    const response = await request(
      fixture,
      mine,
      `/v1/sessions?runStepId=${other.stepId}`,
    );
    // 404, not an empty page: an empty page would confirm the step exists.
    assertEquals(response.status, 404);
    const problem = await response.json() as { code: string };
    assertEquals(problem.code, "RESOURCE_NOT_FOUND");
  }));

Deno.test("AC: a malformed session-list cursor is refused rather than ignored", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "session-list-cursor");
    const { stepId } = await seedSession(fixture, seed);
    const response = await request(
      fixture,
      seed,
      `/v1/sessions?runStepId=${stepId}&cursor=not-a-cursor`,
    );
    assertEquals(response.status, 400);
    const problem = await response.json() as { code: string };
    assertEquals(problem.code, "INVALID_CURSOR");
  }));

Deno.test("AC: a cursor from one run step cannot be replayed against another", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "session-list-binding");
    const taskId = await seedTask(fixture, seed);
    const first = await seedLiveAttempt(fixture, seed, taskId, []);
    const second = await seedLiveAttempt(fixture, seed, taskId, []);
    // A second session on the FIRST step, so the first page has more to follow.
    await fixture.pgDatabase.query(
      `insert into bakery.agent_sessions
         (id, organization_id, run_step_id, conversation_id, agent_version_id,
          harness, status)
       values ($1, $2, $3, $4, $5, 'codex', 'active')`,
      [
        crypto.randomUUID(),
        seed.organizationId,
        first.stepId,
        seed.conversationId,
        seed.agentVersionId,
      ],
    );
    assert(first.stepId !== second.stepId);

    // A cursor is bound to the filters it was issued under, so replaying one
    // against a different step is a refusal, never a silent wrong page.
    const opening = await request(
      fixture,
      seed,
      `/v1/sessions?runStepId=${first.stepId}&limit=1`,
    );
    assertEquals(opening.status, 200);
    const page = await opening.json() as SessionPage;

    // The first page must have a follower, so the replay is always exercised.
    assert(page.nextCursor !== null);
    {
      const replay = await request(
        fixture,
        seed,
        `/v1/sessions?runStepId=${second.stepId}&cursor=${
          encodeURIComponent(page.nextCursor)
        }`,
      );
      assertEquals(replay.status, 400);
      const problem = await replay.json() as { code: string };
      assertEquals(problem.code, "INVALID_CURSOR");
    }
  }));
