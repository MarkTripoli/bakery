import { assertEquals } from "@std/assert";
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

// #412 slice 1. Chapter 25 section 9: "Every steer is recorded before delivery,
// in the session's inputs and in the work item's decisions ledger." The
// session's input and the worker command already existed; the ledger entry did
// not, so a steer never showed in the work item's history.

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
  capabilities: string[],
) {
  const taskId = await seedTask(fixture, seed);
  const ids = await seedLiveAttempt(fixture, seed, taskId, capabilities);
  return { taskId, ...ids };
}

const steerEntries = async (fixture: Fixture, sessionId: string) =>
  (await fixture.pgDatabase.query<{
    taskId: string;
    runId: string | null;
    decidedBy: string;
    text: string | null;
    mode: string;
    messageId: string;
    truncated: string;
  }>(
    `select task_id as "taskId", run_id as "runId", decided_by as "decidedBy",
            text, detail->>'mode' as mode,
            detail->>'messageId' as "messageId",
            detail->>'truncated' as truncated
       from bakery.decisions_ledger
      where subject_kind = 'session' and subject_id = $1 and kind = 'steer'`,
    [sessionId],
  )).rows;

const steer = (
  fixture: Fixture,
  seed: Seed,
  sessionId: string,
  body: Record<string, unknown>,
  key?: string,
) =>
  request(fixture, seed, `/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    body,
    ...(key === undefined ? {} : { key }),
  });

Deno.test("AC: a steer is recorded in the work item's decisions ledger", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "steer-ledger");
    const session = await seedSession(fixture, seed, ["steer"]);

    const response = await steer(fixture, seed, session.agentSessionId, {
      body: "Use the existing helper instead.",
      mode: "steer",
    });
    assertEquals(response.status, 201);

    const entries = await steerEntries(fixture, session.agentSessionId);
    assertEquals(entries.length, 1);
    assertEquals(entries[0].taskId, session.taskId);
    assertEquals(entries[0].runId, session.runId);
    assertEquals(entries[0].decidedBy, seed.principalId);
    assertEquals(entries[0].text, "Use the existing helper instead.");
    assertEquals(entries[0].mode, "steer");
  }));

Deno.test("AC: a replayed steer adds no second ledger entry", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "steer-ledger-replay");
    const session = await seedSession(fixture, seed, ["steer"]);
    const body = {
      body: "Stop and report.",
      mode: "steer",
      clientMessageId: crypto.randomUUID(),
    };

    const key = crypto.randomUUID();
    const first = await steer(fixture, seed, session.agentSessionId, body, key);
    const second = await steer(
      fixture,
      seed,
      session.agentSessionId,
      body,
      key,
    );
    assertEquals(first.status, 201);
    assertEquals(second.status < 300, true);

    assertEquals(
      (await steerEntries(fixture, session.agentSessionId)).length,
      1,
    );
  }));

Deno.test("AC: a steer the worker cannot take leaves no ledger entry", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "steer-ledger-unsupported");
    const session = await seedSession(fixture, seed, []);

    const response = await steer(fixture, seed, session.agentSessionId, {
      body: "Try this.",
      mode: "steer",
    });
    assertEquals(response.status, 409);

    assertEquals(
      (await steerEntries(fixture, session.agentSessionId)).length,
      0,
    );
  }));

Deno.test("AC: a long steer is recorded as a bounded excerpt with its message id", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "steer-ledger-long");
    const session = await seedSession(fixture, seed, ["steer"]);

    const response = await steer(fixture, seed, session.agentSessionId, {
      body: "x".repeat(20000),
      mode: "steer",
    });
    assertEquals(response.status, 201);
    const message = await response.json() as { id: string };

    const entries = await steerEntries(fixture, session.agentSessionId);
    assertEquals(entries.length, 1);
    assertEquals(entries[0].text?.length, 4000);
    assertEquals(entries[0].messageId, message.id);
    assertEquals(entries[0].truncated, "true");
  }));

Deno.test("AC: a steer with a lone surrogate is a 400 and writes nothing", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "steer-ledger-surrogate");
    const session = await seedSession(fixture, seed, ["steer"]);

    const response = await steer(fixture, seed, session.agentSessionId, {
      body: "bad \ud800 text",
      mode: "steer",
    });
    assertEquals(response.status, 400);

    assertEquals(
      (await steerEntries(fixture, session.agentSessionId)).length,
      0,
    );
  }));

Deno.test("AC: an emoji straddling the excerpt limit is not split into a lone surrogate", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "steer-ledger-emoji");
    const session = await seedSession(fixture, seed, ["steer"]);

    // The emoji's high surrogate is code unit 4000 (index 3999), its low
    // surrogate falls outside the excerpt.
    const response = await steer(fixture, seed, session.agentSessionId, {
      body: "x".repeat(3999) + "\u{1F600}" + "tail",
      mode: "steer",
    });
    assertEquals(response.status, 201);

    const entries = await steerEntries(fixture, session.agentSessionId);
    assertEquals(entries.length, 1);
    assertEquals(entries[0].text, "x".repeat(3999));
    assertEquals(entries[0].truncated, "true");
  }));
