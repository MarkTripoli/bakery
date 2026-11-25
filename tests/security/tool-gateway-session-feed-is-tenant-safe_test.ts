import { assertEquals } from "@std/assert";
import { allocateConversationFeedSequence } from "../../apps/server/src/modules/conversation/feed-sequence.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
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

const SECRET_SENTINEL =
  "secret-tool-payload-2f9c4d1e-8a76-4b03-9c55-do-not-leak";

type LiveAttempt = Awaited<ReturnType<typeof seedLiveAttempt>>;

type Feed = {
  items: Array<{
    kind: string;
    tool: {
      callId: string;
      name: string;
      phase: "started" | "completed" | "failed";
      ok: boolean | null;
    } | null;
  }>;
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

async function seedToolLifecycle(
  fixture: Fixture,
  seed: Seed,
  attempt: LiveAttempt,
  name: string,
): Promise<string> {
  const serverId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const callId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.mcp_servers (
       id, organization_id, slug, name, transport, source_revision, enabled
     ) values ($1, $2, $3, $4, 'http', $5, true)`,
    [serverId, seed.organizationId, `security-${serverId}`, name, serverId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.mcp_connections (
       id, organization_id, server_id, label
     ) values ($1, $2, $3, $4)`,
    [connectionId, seed.organizationId, serverId, name],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.tool_gateway_calls (
       id, organization_id, attempt_id, idempotency_key, mcp_connection_id,
       tool_name, effective_name, snapshot_digest, arguments_digest, read_only,
       status, result, settled_at
     ) values ($1, $2, $3, $4, $5, $6, $6, $7, $8, true,
       'completed', $9::jsonb, clock_timestamp())`,
    [
      callId,
      seed.organizationId,
      attempt.attemptId,
      crypto.randomUUID(),
      connectionId,
      name,
      "s".repeat(64),
      SECRET_SENTINEL,
      JSON.stringify({ content: SECRET_SENTINEL }),
    ],
  );
  await withPgTransaction(fixture.pgDatabase, async (transaction) => {
    const startedSequence = await allocateConversationFeedSequence(
      transaction,
      seed.organizationId,
      seed.conversationId,
    );
    const completedSequence = await allocateConversationFeedSequence(
      transaction,
      seed.organizationId,
      seed.conversationId,
    );
    await transaction.query(
      `insert into bakery.session_tool_feed_events (
         organization_id, conversation_id, agent_session_id,
         tool_gateway_call_id, sequence, phase, ok
       ) values
         ($1, $2, $3, $4, $5, 'started', null),
         ($1, $2, $3, $4, $6, 'completed', true)`,
      [
        seed.organizationId,
        seed.conversationId,
        attempt.agentSessionId,
        callId,
        startedSequence,
        completedSequence,
      ],
    );
  });
  return callId;
}

Deno.test("a tool feed discloses no other tenant, session, arguments or result", () =>
  withFixture(async (fixture) => {
    const owner = await seedOrganization(fixture, "tool-feed-security-owner");
    const outsider = await seedOrganization(
      fixture,
      "tool-feed-security-outsider",
    );
    const taskId = await seedTask(fixture, owner);
    const visibleAttempt = await seedLiveAttempt(fixture, owner, taskId, []);
    const hiddenAttempt = await seedLiveAttempt(fixture, owner, taskId, []);
    const visibleCallId = await seedToolLifecycle(
      fixture,
      owner,
      visibleAttempt,
      "visible_tool",
    );
    await seedToolLifecycle(
      fixture,
      owner,
      hiddenAttempt,
      "other_session_tool",
    );

    const ownerResponse = await request(
      fixture,
      owner,
      `/v1/sessions/${visibleAttempt.agentSessionId}/feed`,
    );
    assertEquals(ownerResponse.status, 200);
    const serialized = await ownerResponse.text();
    assertEquals(serialized.includes(SECRET_SENTINEL), false);
    assertEquals(serialized.includes("other_session_tool"), false);
    const feed = JSON.parse(serialized) as Feed;
    assertEquals(
      feed.items.filter((item) => item.kind === "tool").map((item) =>
        item.tool
      ),
      [
        {
          callId: visibleCallId,
          name: "visible_tool",
          phase: "started",
          ok: null,
        },
        {
          callId: visibleCallId,
          name: "visible_tool",
          phase: "completed",
          ok: true,
        },
      ],
    );

    const outsiderResponse = await request(
      fixture,
      outsider,
      `/v1/sessions/${visibleAttempt.agentSessionId}/feed`,
    );
    assertEquals(outsiderResponse.status, 404);
    const outsiderProblem = await outsiderResponse.json() as { code: string };
    assertEquals(outsiderProblem.code, "RESOURCE_NOT_FOUND");
  }));
