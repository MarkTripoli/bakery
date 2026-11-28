import { assert, assertEquals } from "@std/assert";
import { bakeryDataMigrations } from "../../apps/server/src/data-migrations.ts";
import { allocateConversationFeedSequence } from "../../apps/server/src/modules/conversation/feed-sequence.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { openAuthFixture } from "../helpers/auth.ts";
import { cleanupSeededOrganizations } from "../helpers/coordinator-turns.ts";
import {
  type Fixture,
  request,
  seedLiveAttempt,
  seedOrganization,
  seedTask,
} from "../helpers/durable-questions.ts";

const MIGRATION_VERSION = "0369_session_tool_effective_names";
const LEGACY_CALL_COUNT = 1_001;

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

Deno.test("session tool names stay readable through bounded restartable backfill", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "session-tool-backfill");
    const taskId = await seedTask(fixture, seed);
    const attempt = await seedLiveAttempt(fixture, seed, taskId, []);
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    await fixture.pgDatabase.query(
      `insert into bakery.mcp_servers (
         id, organization_id, slug, name, transport, source_revision, enabled
       ) values ($1, $2, $3, 'Backfill server', 'http', $4, true)`,
      [serverId, seed.organizationId, `backfill-${serverId}`, serverId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.mcp_connections (
         id, organization_id, server_id, label
       ) values ($1, $2, $3, 'Backfill connection')`,
      [connectionId, seed.organizationId, serverId],
    );
    const calls = await fixture.pgDatabase.query<{
      id: string;
      tool_name: string;
    }>(
      `insert into bakery.tool_gateway_calls (
         organization_id, attempt_id, idempotency_key, mcp_connection_id,
         tool_name, effective_name, snapshot_digest, arguments_digest,
         read_only, status
       )
       select $1, $2, gen_random_uuid(), $3,
         'legacy_tool_' || ordinal::text, null, repeat('a', 64),
         repeat('b', 64), true, 'completed'
       from generate_series(1, $4::integer) as ordinal
       returning id, tool_name`,
      [
        seed.organizationId,
        attempt.attemptId,
        connectionId,
        LEGACY_CALL_COUNT,
      ],
    );
    const visibleCallId = calls.rows.find((row) =>
      row.tool_name === "legacy_tool_1"
    )?.id;
    assert(visibleCallId);
    await withPgTransaction(fixture.pgDatabase, async (transaction) => {
      const sequence = await allocateConversationFeedSequence(
        transaction,
        seed.organizationId,
        seed.conversationId,
      );
      await transaction.query(
        `insert into bakery.session_tool_feed_events (
           organization_id, conversation_id, agent_session_id,
           tool_gateway_call_id, sequence, phase, ok
         ) values ($1, $2, $3, $4, $5, 'started', null)`,
        [
          seed.organizationId,
          seed.conversationId,
          attempt.agentSessionId,
          visibleCallId,
          sequence,
        ],
      );
    });

    const beforeBackfill = await request(
      fixture,
      seed,
      `/v1/sessions/${attempt.agentSessionId}/feed`,
    );
    assertEquals(beforeBackfill.status, 200);
    const feed = await beforeBackfill.json() as {
      items: Array<{ tool: { name: string } | null }>;
    };
    assertEquals(
      feed.items.find((item) => item.tool !== null)?.tool?.name,
      "legacy_tool_1",
    );

    const migration = bakeryDataMigrations.find((candidate) =>
      candidate.version === MIGRATION_VERSION
    );
    assert(migration);
    const connection = await fixture.database.reserve();
    try {
      assertEquals(
        await migration.run(connection, { maxBatches: 1 }),
        false,
      );
      const afterFirstBatch = await fixture.pgDatabase.query<{ count: number }>(
        `select count(*)::integer as count
           from bakery.tool_gateway_calls
          where organization_id = $1 and effective_name is null`,
        [seed.organizationId],
      );
      assertEquals(afterFirstBatch.rows[0]?.count, 1);

      assertEquals(
        await migration.run(connection, { maxBatches: 1 }),
        false,
      );
      const afterRestart = await fixture.pgDatabase.query<{
        count: number;
        mismatches: number;
      }>(
        `select count(*) filter (where effective_name is null)::integer as count,
                count(*) filter (
                  where effective_name is distinct from tool_name
                )::integer as mismatches
           from bakery.tool_gateway_calls
          where organization_id = $1`,
        [seed.organizationId],
      );
      assertEquals(afterRestart.rows[0], { count: 0, mismatches: 0 });
      assertEquals(
        await migration.run(connection, { maxBatches: 1 }),
        true,
      );
    } finally {
      connection.release();
    }
  }));
